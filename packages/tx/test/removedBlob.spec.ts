import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import { bytesToHex, concatBytes, createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import {
  TransactionType,
  createAccessList2930Tx,
  createFeeMarket1559Tx,
  createLegacyTx,
  createTx,
  createTxFromBlockBodyData,
  createTxFromJSONRPCProvider,
  createTxFromRLP,
  createTxFromRPC,
  isLegacyTx,
  normalizeTxParams,
} from '../src/index.ts'

const constructors = [createTx, createLegacyTx, createAccessList2930Tx, createFeeMarket1559Tx]
const privateKey = hexToBytes(`0x${'11'.repeat(32)}`)
const to = '0x0000000000000000000000000000000000000100'

describe('removed Blob transaction inputs', () => {
  it.each([3, 3n, '0x03', new Uint8Array([3])] as const)(
    'rejects type %s before constructor normalization',
    async (type) => {
      for (const create of constructors) {
        expect(() => create({ type })).toThrow('Blob transaction type 0x03 is no longer supported')
      }
      expect(() => normalizeTxParams({ type })).toThrow('Blob transaction type 0x03')
      await expect(createTxFromRPC({ type })).rejects.toThrow('Blob transaction type 0x03')
    },
  )

  it.each([
    'maxFeePerBlobGas',
    'blobVersionedHashes',
    'blobs',
    'blobsData',
    'kzgCommitments',
    'kzgProofs',
    'networkWrapperVersion',
  ])('rejects %s even when empty or attached to an ordinary transaction', async (field) => {
    for (const value of [undefined, null, 0, 0n, [], '0x']) {
      const data = { gasLimit: 21000n, [field]: value }
      for (const create of constructors) {
        expect(() => create(data)).toThrow(`Blob transaction field ${field}`)
      }
      await expect(createTxFromRPC(data)).rejects.toThrow(`Blob transaction field ${field}`)
    }
  })

  it('rejects canonical and network wrapper type 0x03 encodings at every binary entry point', () => {
    for (const payload of [[], [[], [], [], []], [[], new Uint8Array([1]), [], [], []]]) {
      const serialized = concatBytes(new Uint8Array([3]), RLP.encode(payload))
      expect(() => createTxFromRLP(serialized)).toThrow('TypedTransaction with ID 3 unknown')
      expect(() => createTxFromBlockBodyData(serialized)).toThrow(
        'TypedTransaction with ID 3 unknown',
      )
    }
  })

  it('rejects a Blob transaction returned by a provider', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ result: { type: '0x03' } })))
    try {
      await expect(
        createTxFromJSONRPCProvider('https://example.invalid', `0x${'00'.repeat(32)}`),
      ).rejects.toThrow('Blob transaction type 0x03')
    } finally {
      fetchMock.mockRestore()
    }
  })
})

describe.each([TronMainnet, TronNile, TronShasta])('retained transactions on $name', (chain) => {
  const common = new Common({ chain })
  it.each([
    TransactionType.Legacy,
    TransactionType.AccessListEIP2930,
    TransactionType.FeeMarketEIP1559,
  ])('preserves signing and RLP/RPC round trips for type %s', async (type) => {
    const tx = createTx(
      { type, to, nonce: 1n, gasLimit: 50000n, value: 9n, data: '0x0102' },
      { common },
    ).sign(privateKey)
    const serialized = tx.serialize()
    const restored = createTxFromRLP(serialized, { common })
    const fromBody = createTxFromBlockBodyData(isLegacyTx(tx) ? tx.raw() : serialized, { common })
    const rpcData = { ...tx.toJSON(), gas: '0xc350', input: '0x0102' }
    const fromRPC = await createTxFromRPC(rpcData, { common })
    for (const decoded of [restored, fromBody, fromRPC]) {
      expect(decoded.type).toBe(type)
      expect(bytesToHex(decoded.serialize())).toBe(bytesToHex(serialized))
      expect(bytesToHex(decoded.hash())).toBe(bytesToHex(tx.hash()))
      expect(decoded.getSenderAddress().toString()).toBe(
        createAddressFromPrivateKey(privateKey).toString(),
      )
      expect(decoded.verifySignature()).toBe(true)
    }
  })

  it('keeps typed transaction chainId and unsigned Token field validation', () => {
    for (const create of [createAccessList2930Tx, createFeeMarket1559Tx]) {
      expect(() => create({ chainId: common.chainId() + 1n }, { common })).toThrow(
        /chain ID|chainId/,
      )
      expect(() => create({ tokenId: 1000088n, tokenValue: 1n }, { common })).toThrow(
        'tokenId and tokenValue are not supported',
      )
    }
  })
})
