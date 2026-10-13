import { Common, Hardfork, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { MAX_UINT64, bytesToHex, createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'
import { describe, expect, it } from 'vitest'

import {
  TransactionType,
  createLegacyTx,
  createLegacyTxFromRLP,
  createTx,
  createTxFromBlockBodyData,
  createTxFromRLP,
  createTxFromRPC,
  isLegacyTx,
} from '../src/index.ts'

const networks = [TronMainnet, TronNile, TronShasta]
const types = [
  TransactionType.Legacy,
  TransactionType.AccessListEIP2930,
  TransactionType.FeeMarketEIP1559,
]
const privateKey = hexToBytes(`0x${'46'.repeat(32)}`)
const sender = createAddressFromPrivateKey(privateKey)
const to = hexToBytes(`0x${'11'.repeat(20)}`)
const slot = new Uint8Array(32)

describe.each(networks)('TRON transaction profile on $name', (chain) => {
  it('rejects Ethereum hardforks and retired fee rules without changing the profile', () => {
    const common = new Common({ chain })
    const before = common.copy()
    for (const hardfork of [Hardfork.Istanbul, Hardfork.London, Hardfork.Cancun]) {
      expect(() => common.setHardfork(hardfork)).toThrow(/not supported/)
      expect(common.isCompatibleWith(before)).toBe(true)
    }
    for (const eip of [2929, 7623, 7825]) {
      expect(() => common.setEIPs([eip])).toThrow(/not supported by the TRON execution profile/)
      expect(common.isActivatedEIP(eip)).toBe(false)
      expect(common.isCompatibleWith(before)).toBe(true)
    }
  })

  it.each(types)(
    'rejects cross-network signatures through every decoder for type %s',
    async (type) => {
      const common = new Common({ chain })
      const tx = createTx(
        { type, to, nonce: 3n, gasLimit: 50000n, value: 7n, data: '0x010200' },
        { common },
      ).sign(privateKey)
      expect(tx.getSenderAddress().equals(sender)).toBe(true)
      const serialized = tx.serialize()
      const body = isLegacyTx(tx) ? tx.raw() : serialized
      const rpc = { ...tx.toJSON(), gas: '0xc350', input: '0x010200' }
      for (const peer of networks.filter((network) => network !== chain)) {
        const options = { common: new Common({ chain: peer }) }
        const mismatch = /chain ID|chain id|chainId/
        expect(() => createTxFromRLP(serialized, options)).toThrow(mismatch)
        expect(() => createTxFromBlockBodyData(body, options)).toThrow(mismatch)
        await expect(createTxFromRPC(rpc, options)).rejects.toThrow(mismatch)
      }
    },
  )

  it.each(types)(
    'rejects array-valued Token fields before numeric conversion on type %s',
    (type) => {
      const common = new Common({ chain })
      for (const field of ['tokenId', 'tokenValue']) {
        for (const value of [[], [0], [1, 2, 3]]) {
          expect(() => createTx({ type, [field]: value }, { common })).toThrow(
            `${field} cannot be an array`,
          )
        }
      }
    },
  )

  it.each(types)('retains uint64 gasLimit bounds without the EIP-7825 cap for type %s', (type) => {
    const common = new Common({ chain })
    for (const gasLimit of [0n, (1n << 24n) - 1n, 1n << 24n, (1n << 24n) + 1n, MAX_UINT64]) {
      expect(createTx({ type, gasLimit }, { common }).gasLimit).toBe(gasLimit)
    }
    expect(() => createTx({ type, gasLimit: MAX_UINT64 + 1n }, { common })).toThrow(
      /gasLimit cannot exceed MAX_UINT64/,
    )
  })

  it.each([TransactionType.AccessListEIP2930, TransactionType.FeeMarketEIP1559])(
    'preserves duplicate access-list entries without charging for them on type %s',
    (type) => {
      const common = new Common({ chain })
      const accessList: [Uint8Array, Uint8Array[]][] = [
        [to, [slot]],
        [to, [slot, slot]],
      ]
      const data = '0x010200'
      const call = createTx({ type, to, data, accessList }, { common })
      const withoutList = createTx({ type, to, data }, { common })
      const deployment = createTx({ type, data, accessList }, { common })
      expect(call.getDataGas()).toBe(36n)
      expect(call.toJSON()).not.toHaveProperty('tokenId')
      expect(call.toJSON()).not.toHaveProperty('tokenValue')
      expect(call.getIntrinsicGas()).toBe(21036n)
      expect(deployment.getIntrinsicGas()).toBe(53036n)
      expect(call.getIntrinsicGas()).toBe(withoutList.getIntrinsicGas())
      expect(call.serialize()).not.toEqual(withoutList.serialize())
      expect(createTxFromRLP(call.serialize(), { common }).toJSON().accessList).toEqual(
        call.toJSON().accessList,
      )
      expect(isLegacyTx(call)).toBe(false)
      if (isLegacyTx(call)) throw new Error('Expected an access-list transaction')
      expect(call.accessList).toEqual(accessList)
    },
  )

  it('preserves distinct signed TRC-10 IDs above Number precision through serialization', async () => {
    const common = new Common({ chain })
    const ids = [9007199254740992n, 9007199254740993n, 9223372036854775807n]
    const hashes = new Set<string>()
    for (const tokenId of ids) {
      const tx = createLegacyTx({ to, tokenId, tokenValue: 7n }, { common }).sign(privateKey)
      const json = JSON.parse(JSON.stringify(tx))
      expect(json.tokenId).toBe(`0x${tokenId.toString(16)}`)
      expect(json.tokenValue).toBe('0x7')
      for (const decoded of [
        createLegacyTxFromRLP(tx.serialize(), { common }),
        createLegacyTx(json, { common }),
        await createTxFromRPC(json, { common }),
      ]) {
        expect(decoded.tokenId).toBe(tokenId)
        expect(decoded.tokenValue).toBe(7n)
        expect(decoded.serialize()).toEqual(tx.serialize())
        expect(decoded.verifySignature()).toBe(true)
        expect(decoded.getSenderAddress().equals(sender)).toBe(true)
      }
      hashes.add(bytesToHex(tx.hash()))
      for (const changed of [{ tokenId: tokenId - 1n }, { tokenValue: 8n }]) {
        const altered = createLegacyTx({ ...json, ...changed }, { common })
        expect(altered.getSenderAddress().equals(sender)).toBe(false)
      }
    }
    expect(hashes.size).toBe(ids.length)
  })
})
