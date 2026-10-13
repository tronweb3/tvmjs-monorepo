import { describe, expect, it } from 'vitest'

import type { BeaconPayloadJSON } from '../src/index.ts'
import {
  createBlock,
  createBlockFromBeaconPayloadJSON,
  executionPayloadFromBeaconPayload,
} from '../src/index.ts'

const block = createBlock({
  header: { number: 9007199254740993n, timestamp: 2n, gasLimit: 1000000n },
})
const execution = block.toExecutionPayload()
const payload: BeaconPayloadJSON = {
  parent_hash: execution.parentHash,
  fee_recipient: execution.feeRecipient,
  state_root: execution.stateRoot,
  receipts_root: execution.receiptsRoot,
  logs_bloom: execution.logsBloom,
  prev_randao: execution.prevRandao,
  block_number: '9007199254740993',
  gas_limit: '1000000',
  gas_used: '0',
  timestamp: '2',
  extra_data: execution.extraData,
  base_fee_per_gas: '7',
  block_hash: execution.blockHash,
  transactions: [],
}

describe('Beacon execution payload data conversion', () => {
  it('preserves ordinary fields, exact integers and the resulting block hash', async () => {
    const converted = executionPayloadFromBeaconPayload(payload)
    expect(converted.blockNumber).toBe('0x20000000000001')
    expect(converted).not.toHaveProperty('blobGasUsed')
    expect(converted).not.toHaveProperty('excessBlobGas')
    expect(converted).not.toHaveProperty('parentBeaconBlockRoot')
    expect(converted).not.toHaveProperty('parent_beacon_block_root')
    expect((await createBlockFromBeaconPayloadJSON(payload)).hash()).toEqual(block.hash())
  })

  it('still validates the payload block hash', async () => {
    await expect(
      createBlockFromBeaconPayloadJSON({ ...payload, block_hash: `0x${'00'.repeat(32)}` }),
    ).rejects.toThrow('Invalid blockHash')
  })

  it.each(['blob_gas_used', 'excess_blob_gas', 'blobGasUsed', 'excessBlobGas'])(
    'rejects %s before mapping can discard it',
    async (field) => {
      for (const value of [undefined, null, '0', 0, []]) {
        const input = { ...payload, [field]: value }
        expect(() => executionPayloadFromBeaconPayload(input)).toThrow(`Blob header field ${field}`)
        await expect(createBlockFromBeaconPayloadJSON(input)).rejects.toThrow(
          `Blob header field ${field}`,
        )
      }
    },
  )

  it.each(['parentBeaconBlockRoot', 'parent_beacon_block_root'])(
    'rejects %s before Beacon payload conversion can discard it',
    async (field) => {
      for (const value of [undefined, null, '0', 0, '', `0x${'00'.repeat(32)}`]) {
        const input = { ...payload, [field]: value }
        expect(() => executionPayloadFromBeaconPayload(input)).toThrow(
          `Beacon root header field ${field}`,
        )
        await expect(createBlockFromBeaconPayloadJSON(input)).rejects.toThrow(
          `Beacon root header field ${field}`,
        )
      }
    },
  )
})
