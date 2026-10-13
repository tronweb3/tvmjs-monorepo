import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { describe, expect, it } from 'vitest'

import {
  createBlock,
  createBlockFromExecutionPayload,
  createBlockFromRPC,
  createBlockHeader,
  createBlockHeaderFromRPC,
} from '../src/index.ts'
import { testdataFromRPCData } from './testdata/testdata-from-rpc.ts'

describe.each([TronMainnet, TronNile, TronShasta])('Inactive header fields on $name', (chain) => {
  it.each([
    ['requestsHash', 7685, `0x${'00'.repeat(32)}`],
    ['blockAccessListHash', 7928, `0x${'00'.repeat(32)}`],
    ['slotNumber', 7843, '0x1'],
  ] as const)(
    'rejects %s in object, RPC and execution payload inputs',
    async (field, eip, value) => {
      const common = new Common({ chain })
      expect(common.isActivatedEIP(eip)).toBe(false)
      expect(() => common.setEIPs([eip])).toThrow()
      const error = new RegExp(`EIP ?${eip}`)
      expect(() => createBlockHeader({ [field]: value }, { common })).toThrow(error)
      expect(() => createBlock({ header: { [field]: value } }, { common })).toThrow(error)
      const rpc = { ...testdataFromRPCData, [field]: value }
      expect(() => createBlockHeaderFromRPC(rpc, { common })).toThrow(error)
      expect(() => createBlockFromRPC(rpc, [], { common })).toThrow(error)
      const payload = { ...createBlock({}, { common }).toExecutionPayload(), [field]: value }
      await expect(createBlockFromExecutionPayload(payload, { common })).rejects.toThrow(error)
    },
  )
})
