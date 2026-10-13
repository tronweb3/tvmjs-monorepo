import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { EOFContainer, TVMError, createTVM } from '../../src/index.ts'

const eofEIPs = [663, 3540, 3670, 4200, 4750, 5450, 6206, 7069, 7480, 7620, 7692, 7698]

describe.each([TronMainnet, TronNile, TronShasta])('EOF execution boundary on $name', (chain) => {
  it('rejects EOF activation and execution of the former simple-contract fixture', async () => {
    const common = new Common({ chain })
    const tvm = await createTVM({ common })
    for (const eip of eofEIPs) {
      assert.isFalse(common.isActivatedEIP(eip))
      assert.throws(() => common.setEIPs([eip]), /not supported by the TRON execution profile/)
    }
    // The retained container parser accepts this ADDRESS; POP; STOP fixture.
    // Executing its EOF header through the TRON interpreter must fail at 0xef.
    const code = hexToBytes('0xef000101000402000100030400010000800001305000ef')
    const container = new EOFContainer(code)
    assert.deepEqual(container.body.codeSections[0], hexToBytes('0x305000'))
    const result = await tvm.runCode({ code, gasLimit: 100000n })
    assert.strictEqual(result.exceptionError?.error, TVMError.errorMessages.INVALID_OPCODE)
    assert.strictEqual(result.executionGasUsed, 100000n)
  })
})

describe('retained EOF container parser', () => {
  it('initializes code positions across sections without an Ethereum Common', () => {
    const code = hexToBytes(
      '0xef0001010008020002000800030400000000800001000000013050e300016001003050e4',
    )
    const container = new EOFContainer(code)
    assert.strictEqual(container.header.getSectionFromProgramCounter(33), 1)
    // 17-byte header + 8-byte types section, followed by an 8-byte first code section.
    assert.strictEqual(container.header.getCodePosition(0), 25)
    assert.strictEqual(container.header.getCodePosition(1), 33)
    assert.deepEqual(container.body.codeSections[0], hexToBytes('0x3050e30001600100'))
    assert.deepEqual(container.body.codeSections[1], hexToBytes('0x3050e4'))
  })
})
