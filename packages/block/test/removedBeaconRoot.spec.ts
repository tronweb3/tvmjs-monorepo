import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import { bytesToHex } from '@tvmjs/util'
import { describe, expect, it } from 'vitest'

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
} from '../src/index.ts'

const beaconFields = ['parentBeaconBlockRoot', 'parent_beacon_block_root']

describe.each([TronMainnet, TronNile, TronShasta])('Beacon root removal on $name', (chain) => {
  it.each(beaconFields)('rejects %s before construction or input normalization', async (field) => {
    const common = new Common({ chain })
    for (const value of [undefined, null, 0, 0n, '0x', new Uint8Array(), new Uint8Array(32)]) {
      const data = { [field]: value }
      const error = `Beacon root header field ${field} is no longer supported`
      expect(() => createBlockHeader(data, { common })).toThrow(error)
      expect(() => createBlock({ header: data }, { common })).toThrow(error)
      expect(() => createBlockHeaderFromRPC(data as any, { common })).toThrow(error)
      expect(() => createBlockFromRPC(data as any, [], { common })).toThrow(error)
      await expect(createBlockFromExecutionPayload(data as any, { common })).rejects.toThrow(error)

      const header = createBlockHeader({}, { common, freeze: false })
      Object.assign(header, data)
      expect(() => new Block(header)).toThrow(error)
    }
  })

  it('preserves ordinary header encoding and hashes without exposing Beacon root metadata', async () => {
    const common = new Common({ chain })
    const block = createBlock(
      { header: { number: 42n, timestamp: 1700000000n, gasLimit: 1000000n } },
      { common },
    )
    // Recorded before removing Beacon root support; the chain identity is not an RLP field.
    expect(bytesToHex(block.hash())).toBe(
      '0x1ec813dfff413887c0b03ff7391738baae41dcf9fe19665fdeea9f133831d428',
    )
    expect(block.header.raw()).toHaveLength(16)
    expect(createBlockFromRLP(block.serialize(), { common }).hash()).toEqual(block.hash())
    expect(
      (await createBlockFromExecutionPayload(block.toExecutionPayload(), { common })).hash(),
    ).toEqual(block.hash())
    for (const field of beaconFields) {
      expect(block.header).not.toHaveProperty(field)
      expect(block.toJSON().header).not.toHaveProperty(field)
      expect(block.toExecutionPayload()).not.toHaveProperty(field)
    }
  })
})

it('rejects the old Beacon-era RLP layout without reinterpreting its extension fields', () => {
  const header = createBlockHeader()
  const values = [
    ...header.raw(),
    new Uint8Array(32),
    new Uint8Array(),
    new Uint8Array(),
    new Uint8Array(32),
  ]
  expect(values).toHaveLength(20)
  expect(() => createBlockHeaderFromBytesArray(values)).toThrow('Unsupported header extension')
  expect(() => createBlockHeaderFromRLP(RLP.encode(values))).toThrow('Unsupported header extension')
  expect(() => createBlockFromBytesArray([values, [], []])).toThrow('Unsupported header extension')
  expect(() => createBlockFromRLP(RLP.encode([values, [], []]))).toThrow(
    'Unsupported header extension',
  )
})
