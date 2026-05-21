import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { assert, describe, it } from 'vitest'

import { createTVM } from '../src/index.ts'

describe('TVM -> getActiveOpcodes()', () => {
  const DIFFICULTY_PREVRANDAO = 0x44
  const CHAINID = 0x46 //istanbul opcode

  it('should not expose opcodes from a follow-up HF (istanbul -> petersburg)', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Petersburg })
    const tvm = await createTVM({ common })
    assert.strictEqual(
      tvm.getActiveOpcodes().get(CHAINID),
      undefined,
      'istanbul opcode not exposed (HF: < istanbul (petersburg)',
    )
  })

  it('should expose opcodes when HF is active (>= istanbul)', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Istanbul })
    const tvm = await createTVM({ common })
    assert.strictEqual(
      tvm.getActiveOpcodes().get(CHAINID)!.name,
      'CHAINID',
      'istanbul opcode exposed (HF: istanbul)',
    )
  })

  it('should switch DIFFICULTY opcode name to PREVRANDAO when >= Merge HF', async () => {
    let common = new Common({ chain: Mainnet, hardfork: Hardfork.Istanbul })
    let tvm = await createTVM({ common })
    assert.strictEqual(
      tvm.getActiveOpcodes().get(DIFFICULTY_PREVRANDAO)!.name,
      'DIFFICULTY',
      'Opcode x44 named DIFFICULTY pre-Merge',
    )

    common = new Common({ chain: Mainnet, hardfork: Hardfork.Paris })
    tvm = await createTVM({ common })
    assert.strictEqual(
      tvm.getActiveOpcodes().get(DIFFICULTY_PREVRANDAO)!.name,
      'PREVRANDAO',
      'Opcode x44 named PREVRANDAO post-Merge',
    )
  })

  it('should update opcodes on a hardfork change', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Istanbul })
    const tvm = await createTVM({ common })

    common.setHardfork(Hardfork.Byzantium)
    assert.strictEqual(
      tvm.getActiveOpcodes().get(CHAINID),
      undefined,
      'opcode not exposed after HF change (-> < istanbul)',
    )

    common.setHardfork(Hardfork.Istanbul)
    assert.strictEqual(
      tvm.getActiveOpcodes().get(CHAINID)!.name,
      'CHAINID',
      'opcode exposed after HF change (-> istanbul)',
    )
  })
})
