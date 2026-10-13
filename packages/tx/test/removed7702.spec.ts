import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import {
  bytesToHex,
  concatBytes,
  createAddressFromPrivateKey,
  createAddressFromString,
  hexToBytes,
} from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import {
  createAccessList2930Tx,
  createFeeMarket1559Tx,
  createLegacyTx,
  createTx,
  createTxFromBlockBodyData,
  createTxFromJSONRPCProvider,
  createTxFromRLP,
  createTxFromRPC,
  normalizeTxParams,
} from '../src/index.ts'

const constructors = [createTx, createLegacyTx, createAccessList2930Tx, createFeeMarket1559Tx]
const privateKey = hexToBytes(`0x${'11'.repeat(32)}`)
const recipient = createAddressFromString('0x2222222222222222222222222222222222222222')

describe('removed EIP-7702 transaction inputs', () => {
  it.each([4, 4n, '0x04', new Uint8Array([4])] as const)(
    'rejects type %s before selecting or normalizing a transaction',
    async (type) => {
      for (const create of constructors) {
        expect(() => create({ type })).toThrow('EIP-7702 transaction type 0x04')
      }
      expect(() => normalizeTxParams({ type })).toThrow('EIP-7702 transaction type 0x04')
      await expect(createTxFromRPC({ type })).rejects.toThrow('EIP-7702 transaction type 0x04')
    },
  )

  it.each(['authorizationList', 'authorization_list'])(
    'rejects %s on ordinary transactions, including empty and inherited fields',
    async (field) => {
      for (const type of [undefined, 0, 1, 2]) {
        for (const value of [undefined, null, 0, [], [{}]]) {
          const data = { type, gasLimit: 100000n, to: recipient, [field]: value }
          for (const create of constructors) {
            expect(() => create(data)).toThrow(`EIP-7702 transaction field ${field}`)
          }
          expect(() => normalizeTxParams(data)).toThrow(`EIP-7702 transaction field ${field}`)
          await expect(createTxFromRPC(data)).rejects.toThrow(`EIP-7702 transaction field ${field}`)
        }
      }
      const inherited = Object.assign(Object.create({ [field]: undefined }), { to: recipient })
      expect(() => normalizeTxParams(inherited)).toThrow(`EIP-7702 transaction field ${field}`)
      expect(() => createTx(inherited)).toThrow(`EIP-7702 transaction field ${field}`)
    },
  )

  it('rejects type 0x04 at RLP and block-body entry points before parsing its payload', () => {
    for (const payload of [
      new Uint8Array(),
      RLP.encode([]),
      RLP.encode(Array(13).fill(new Uint8Array())),
    ]) {
      const serialized = concatBytes(new Uint8Array([4]), payload)
      expect(() => createTxFromRLP(serialized)).toThrow('EIP-7702 transaction type 0x04')
      expect(() => createTxFromBlockBodyData(serialized)).toThrow('EIP-7702 transaction type 0x04')
    }
  })

  it('rejects authorization data returned by an RPC provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    try {
      for (const data of [{ type: '0x04' }, { type: '0x00', authorizationList: [] }]) {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: data })))
        await expect(
          createTxFromJSONRPCProvider('https://example.invalid', `0x${'00'.repeat(32)}`),
        ).rejects.toThrow(/EIP-7702 transaction/)
      }
    } finally {
      fetchMock.mockRestore()
    }
  })
})

// Recorded from the compiled pre-removal baseline (51e8e2a4d).
const vectors = [
  {
    chain: TronMainnet,
    hashes: [
      '0x7cd2e436f55d4011054110b85e258549921e01ddf3a7e0de8bcb344d1adb9ac5',
      '0x40267b9ec08eab861aeed310d1a3c1b66a1d46811ea0fd4ed11a4d659fcb0fb4',
      '0xeb172321d410e2a09ab8883140091053ea6234afc965843f86253c75c22b8fb6',
    ],
  },
  {
    chain: TronNile,
    hashes: [
      '0x3d032bf8a5d06e628f18d93a3e7e3cc164ba26d7ffe38a30724a8e22a133318f',
      '0x906b3c9fb6958fbe7174cf67b31863b048099c05994d76b0ee612a41e6620620',
      '0x51cfe140d3208fc815944fd10462f45cb0c171f936ff2641adb6123c62f9b4e1',
    ],
  },
  {
    chain: TronShasta,
    hashes: [
      '0xc47d7ad6740a1112295360f90b2bb8098891140f3d713cbdc74153a9400771fe',
      '0xd279209a20f0ce56e8fb824fdfefd7624af99deacaa3b9efa3959a9f41bfc0e8',
      '0xdfdbab15e228d323e6ebe934ecb85773666af5898a78d4a18ee18807726d6a3b',
    ],
  },
]

describe.each(vectors)(
  'ordinary signatures after EIP-7702 removal on $chain.name',
  ({ chain, hashes }) => {
    it.each([0, 1, 2] as const)('preserves the type %s encoding, hash and signer', (type) => {
      const common = new Common({ chain })
      const tx = createTx(
        {
          type,
          nonce: 5n,
          gasLimit: 100000n,
          ...(type === 2 ? { maxFeePerGas: 12n, maxPriorityFeePerGas: 2n } : { gasPrice: 10n }),
          to: recipient,
          value: 123n,
          data: '0x010200',
        },
        { common },
      ).sign(privateKey)
      expect(bytesToHex(tx.hash())).toBe(hashes[type])
      const restored = createTxFromRLP(tx.serialize(), { common })
      expect(restored.type).toBe(type)
      expect(restored.serialize()).toEqual(tx.serialize())
      expect(restored.getSenderAddress().equals(createAddressFromPrivateKey(privateKey))).toBe(true)
      expect(restored.verifySignature()).toBe(true)
      expect(restored.toJSON()).not.toHaveProperty('authorizationList')
      expect(restored).not.toHaveProperty('authorizationList')
    })
  },
)
