import { Common, Hardfork, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { assert, describe, it } from 'vitest'

import { createTVM } from '../src/index.ts'
import { maxCallGas } from '../src/opcodes/util.ts'

describe('TVM -> getActiveOpcodes()', () => {
  const DIFFICULTY = 0x44
  const CHAINID = 0x46
  const CLZ = 0x1e

  for (const chain of [TronMainnet, TronNile, TronShasta]) {
    it(`exposes the TRON opcode set on ${chain.name}`, async () => {
      const tvm = await createTVM({ common: new Common({ chain }) })
      const opcodes = tvm.getActiveOpcodes()
      assert.strictEqual(opcodes.get(CHAINID)!.name, 'CHAINID')
      assert.strictEqual(opcodes.get(DIFFICULTY)!.name, 'DIFFICULTY')
      assert.isUndefined(opcodes.get(CLZ))
      assert.isUndefined(opcodes.get(0x49), 'BLOBHASH is unavailable')
      assert.isUndefined(opcodes.get(0x4a), 'BLOBBASEFEE is unavailable')
    })
  }

  it('exposes CLZ when explicitly selected', async () => {
    const common = new Common({ chain: TronMainnet, eips: [7939] })
    const tvm = await createTVM({ common })
    assert.strictEqual(tvm.getActiveOpcodes().get(CLZ)!.name, 'CLZ')
  })

  it('preserves the opcode set when Ethereum configuration changes are rejected', async () => {
    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })
    const opcodes = new Map(tvm.getActiveOpcodes())
    assert.throws(() => common.setHardfork(Hardfork.Istanbul), /not supported/)
    assert.throws(() => common.setEIPs([4399]), /not supported/)
    assert.strictEqual(common.hardfork(), Hardfork.Tron)
    assert.deepEqual(tvm.getActiveOpcodes(), opcodes)
  })
})

describe('TRON version-0 call gas forwarding', () => {
  it.each([
    [0n, 0n, 0n],
    [1n, 0n, 0n],
    [0n, 1000n, 0n],
    [500n, 1000n, 500n],
    [1000n, 1000n, 1000n],
    [2000n, 1000n, 1000n],
    [0n, -1n, -1n],
    [9007199254740993n, 9007199254740992n, 9007199254740992n],
    [9007199254740992n, 9007199254740993n, 9007199254740992n],
  ])(
    'caps requested gas %s at remaining budget %s (expected %s)',
    (requested, remaining, expected) => {
      assert.strictEqual(maxCallGas(requested, remaining), expected)
    },
  )
})
