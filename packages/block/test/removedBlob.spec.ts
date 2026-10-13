import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import { createLegacyTx } from '@tvmjs/tx'
import { bytesToHex, concatBytes, hexToBytes } from '@tvmjs/util'
import { describe, expect, it } from 'vitest'

import { infuraGoerliBlock10536893Data } from './testdata/infura-goerli-block-10536893.ts'

import {
  Block,
  createBlock,
  createBlockFromBytesArray,
  createBlockFromExecutionPayload,
  createBlockFromRLP,
  createBlockFromRPC,
  createBlockHeader,
  createBlockHeaderFromBytesArray,
  createBlockHeaderFromRLP,
  createBlockHeaderFromRPC,
  genTransactionsTrieRoot,
  valuesArrayToHeaderData,
} from '../src/index.ts'

describe('removed Blob block fields', () => {
  it('rejects a recorded Cancun RPC block before decoding its Blob transactions', () => {
    expect(() => createBlockFromRPC(infuraGoerliBlock10536893Data as any)).toThrow(
      'Blob header field blobGasUsed',
    )
  })
  it.each(['blobGasUsed', 'excessBlobGas'])(
    'rejects %s before header/RPC/payload mapping',
    async (field) => {
      for (const value of [undefined, null, 0, 0n, '0x0', new Uint8Array()]) {
        const data = { number: 0n, [field]: value }
        expect(() => createBlockHeader(data)).toThrow(`Blob header field ${field}`)
        expect(() => createBlock({ header: data })).toThrow(`Blob header field ${field}`)
        expect(() => createBlockHeaderFromRPC(data as any)).toThrow(`Blob header field ${field}`)
        expect(() => createBlockFromRPC(data as any)).toThrow(`Blob header field ${field}`)
        await expect(createBlockFromExecutionPayload(data as any)).rejects.toThrow(
          `Blob header field ${field}`,
        )
      }
    },
  )

  it('rejects old RLP positions without shifting later Ethereum fields into them', () => {
    const header = createBlockHeader()
    for (const length of [18, 19, 20, 21, 22, 23, 24]) {
      const values = [...header.raw()]
      while (values.length < length) values.push(new Uint8Array())
      expect(() => valuesArrayToHeaderData(values)).toThrow('Unsupported header extension')
      expect(() => createBlockHeaderFromBytesArray(values)).toThrow('Unsupported header extension')
      expect(() => createBlockHeaderFromRLP(RLP.encode(values))).toThrow(
        'Unsupported header extension',
      )
      expect(() => createBlockFromRLP(RLP.encode([values, [], []]))).toThrow(
        'Unsupported header extension',
      )
    }
  })

  it('rejects Blob transactions in object, binary, RPC and execution-payload blocks', async () => {
    const block = createBlock()
    const serialized = concatBytes(new Uint8Array([3]), RLP.encode([]))
    expect(() => createBlock({ transactions: [{ type: 3 }] })).toThrow('Blob transaction type 0x03')
    expect(() => new Block(block.header, [{ type: 3 } as any])).toThrow(
      'Blob transaction type 0x03',
    )
    expect(() => createBlockFromBytesArray([block.header.raw(), [serialized], []])).toThrow(
      'TypedTransaction with ID 3',
    )
    expect(() => createBlockFromRPC({ transactions: [{ type: '0x03' }] } as any)).toThrow(
      'Blob transaction type 0x03',
    )
    await expect(
      createBlockFromExecutionPayload({
        ...block.toExecutionPayload(),
        transactions: [bytesToHex(serialized)],
      }),
    ).rejects.toMatch(/TypedTransaction with ID 3/)
  })
})

describe.each([TronMainnet, TronNile, TronShasta])('ordinary block encoding on $name', (chain) => {
  it('preserves header field order, transaction roots and execution payload hashes', async () => {
    const common = new Common({ chain })
    const tx = createLegacyTx(
      { gasLimit: 21000n, gasPrice: 7n, to: `0x${'11'.repeat(20)}` },
      { common },
    ).sign(hexToBytes(`0x${'22'.repeat(32)}`))
    const block = createBlock(
      { header: { transactionsTrie: await genTransactionsTrieRoot([tx]) }, transactions: [tx] },
      { common },
    )
    const raw = block.header.raw()
    expect(raw).toHaveLength(16)
    expect(raw[14]).toEqual(block.header.nonce)
    expect(bytesToHex(raw[15])).toBe('0x07')
    const restored = createBlockFromRLP(block.serialize(), { common })
    expect(restored.hash()).toEqual(block.hash())
    expect(await restored.transactionsTrieIsValid()).toBe(true)
    expect(
      (await createBlockFromExecutionPayload(block.toExecutionPayload(), { common })).hash(),
    ).toEqual(block.hash())
    for (const field of ['blobGasUsed', 'excessBlobGas']) {
      expect(block.header).not.toHaveProperty(field)
      expect(block.header.toJSON()).not.toHaveProperty(field)
      expect(block.toExecutionPayload()).not.toHaveProperty(field)
    }
  })
})
