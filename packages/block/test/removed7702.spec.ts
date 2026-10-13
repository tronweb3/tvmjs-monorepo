import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import { createTx } from '@tvmjs/tx'
import { bytesToHex, concatBytes, hexToBytes } from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import {
  Block,
  createBlock,
  createBlockFromBytesArray,
  createBlockFromExecutionPayload,
  createBlockFromJSONRPCProvider,
  createBlockFromRLP,
  createBlockFromRPC,
  genTransactionsTrieRoot,
} from '../src/index.ts'

const serialized = concatBytes(new Uint8Array([4]), RLP.encode([]))

describe.each([TronMainnet, TronNile, TronShasta])('EIP-7702 block rejection on $name', (chain) => {
  it('rejects type 0x04 in object, binary, RPC and execution-payload blocks', async () => {
    const common = new Common({ chain })
    const block = createBlock({}, { common })
    const error = 'EIP-7702 transaction type 0x04 is no longer supported'
    for (const type of [4, 4n, '0x04'] as const) {
      expect(() => createBlock({ transactions: [{ type }] }, { common })).toThrow(error)
      expect(() => new Block(block.header, [{ type } as any])).toThrow(error)
      expect(() => createBlockFromRPC({ transactions: [{ type }] } as any, [], { common })).toThrow(
        error,
      )
    }
    expect(() =>
      createBlockFromBytesArray([block.header.raw(), [serialized], []], { common }),
    ).toThrow(error)
    expect(() =>
      createBlockFromRLP(RLP.encode([block.header.raw(), [serialized], []]), { common }),
    ).toThrow(error)
    await expect(
      createBlockFromExecutionPayload(
        { ...block.toExecutionPayload(), transactions: [bytesToHex(serialized)] },
        { common },
      ),
    ).rejects.toMatch(/EIP-7702 transaction type 0x04/)
  })

  it.each(['authorizationList', 'authorization_list'])(
    'rejects %s even on ordinary or already-instantiated transactions',
    (field) => {
      const common = new Common({ chain })
      const block = createBlock({}, { common })
      const error = `EIP-7702 transaction field ${field} is no longer supported`
      for (const type of [0, 1, 2]) {
        for (const value of [undefined, null, []]) {
          const data = { type, [field]: value }
          expect(() => createBlock({ transactions: [data] }, { common })).toThrow(error)
          expect(() => createBlockFromRPC({ transactions: [data] } as any, [], { common })).toThrow(
            error,
          )
          const tx = createTx({ type }, { common, freeze: false })
          Object.assign(tx, { [field]: value })
          expect(() => new Block(block.header, [tx])).toThrow(error)
        }
      }
      const inherited = Object.assign(Object.create({ [field]: undefined }), { type: 0 })
      expect(() => new Block(block.header, [inherited])).toThrow(error)
    },
  )

  it('preserves all ordinary transaction types in block round trips', async () => {
    const common = new Common({ chain })
    const transactions = [0, 1, 2].map((type) =>
      createTx(
        {
          type,
          nonce: BigInt(type),
          to: `0x${'22'.repeat(20)}`,
          gasLimit: 50000n,
          ...(type === 2 ? { maxFeePerGas: 10n, maxPriorityFeePerGas: 2n } : { gasPrice: 10n }),
        },
        { common },
      ).sign(hexToBytes(`0x${'11'.repeat(32)}`)),
    )
    const block = createBlock(
      { header: { transactionsTrie: await genTransactionsTrieRoot(transactions) }, transactions },
      { common },
    )
    for (const restored of [
      createBlockFromRLP(block.serialize(), { common }),
      await createBlockFromExecutionPayload(block.toExecutionPayload(), { common }),
    ]) {
      expect(restored.hash()).toEqual(block.hash())
      expect(await restored.transactionsTrieIsValid()).toBe(true)
      expect(restored.transactions.map((tx) => tx.type)).toEqual([0, 1, 2])
      expect(restored.transactions.map((tx) => bytesToHex(tx.hash()))).toEqual(
        transactions.map((tx) => bytesToHex(tx.hash())),
      )
    }
  })
})

it('rejects authorization transactions fetched from a block provider', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
  try {
    for (const data of [{ type: '0x04' }, { type: '0x00', authorization_list: [] }]) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { transactions: [data], uncles: [] } })),
      )
      await expect(
        createBlockFromJSONRPCProvider('https://example.invalid', 1n, {}),
      ).rejects.toThrow(/EIP-7702 transaction/)
    }
  } finally {
    fetchMock.mockRestore()
  }
})
