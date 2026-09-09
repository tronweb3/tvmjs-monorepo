import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { assert, describe, it } from 'vitest'

import { createTVM } from '../../src/index.ts'

describe('EIP-7939: CLZ (Count Leading Zeros) opcode', () => {
  it('should not be available in default Cancun', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
    const tvm = await createTVM({ common })

    // 0x1e is CLZ opcode, but not activated by default
    const code = new Uint8Array([
      0x60,
      0x08, // PUSH1 0x08
      0x1e, // CLZ (should be invalid opcode)
    ])

    const result = await tvm.runCode({ code })
    assert.isDefined(result.exceptionError, 'should throw invalid opcode error')
    assert.isTrue(
      result.exceptionError!.error.includes('invalid opcode'),
      'should be invalid opcode error',
    )
  })

  it('should be available when EIP-7939 is explicitly enabled', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun, eips: [7939] })
    const tvm = await createTVM({ common })

    // PUSH1 0x08, CLZ -> should return 252 (0x08 has bit 3 set, so 256-4=252 leading zeros)
    const code = new Uint8Array([
      0x60,
      0x08, // PUSH1 0x08
      0x1e, // CLZ
    ])

    const result = await tvm.runCode({ code })
    assert.isUndefined(result.exceptionError, 'should execute without error')
    assert.isDefined(result.runState, 'should have runState')
    assert.strictEqual(result.runState!.stack.length, 1, 'should have one item on stack')
    const [top] = result.runState!.stack.peek(1)
    assert.strictEqual(top, 252n, 'CLZ(0x08) should be 252')
  })

  it('should return 256 for zero input', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun, eips: [7939] })
    const tvm = await createTVM({ common })

    const code = new Uint8Array([
      0x60,
      0x00, // PUSH1 0x00
      0x1e, // CLZ
    ])

    const result = await tvm.runCode({ code })
    assert.isUndefined(result.exceptionError)
    const [top] = result.runState!.stack.peek(1)
    assert.strictEqual(top, 256n, 'CLZ(0) should be 256')
  })

  it('should return 0 for input with MSB set', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun, eips: [7939] })
    const tvm = await createTVM({ common })

    // 0x8000...0000 (MSB set, 255 trailing zeros)
    const code = new Uint8Array([
      0x7f, // PUSH32
      0x80,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x1e, // CLZ
    ])

    const result = await tvm.runCode({ code })
    assert.isUndefined(result.exceptionError)
    const [top] = result.runState!.stack.peek(1)
    assert.strictEqual(top, 0n, 'CLZ(0x80...00) should be 0')
  })

  it('should return 255 for input 0x01', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun, eips: [7939] })
    const tvm = await createTVM({ common })

    const code = new Uint8Array([
      0x60,
      0x01, // PUSH1 0x01
      0x1e, // CLZ
    ])

    const result = await tvm.runCode({ code })
    assert.isUndefined(result.exceptionError)
    const [top] = result.runState!.stack.peek(1)
    assert.strictEqual(top, 255n, 'CLZ(1) should be 255')
  })

  it('should consume correct gas (PUSH1 3 + CLZ 5 = 8)', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun, eips: [7939] })
    const tvm = await createTVM({ common })

    const code = new Uint8Array([
      0x60,
      0x08, // PUSH1 0x08 (gas: 3)
      0x1e, // CLZ (gas: 5)
    ])

    const result = await tvm.runCode({ code, gasLimit: 100n })
    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.executionGasUsed, 8n, 'total gas should be PUSH1(3) + CLZ(5) = 8')
  })

  it('should work with PUSH32 input', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun, eips: [7939] })
    const tvm = await createTVM({ common })

    // 0x0000000100000000...00 (3 zero bytes + 0x01 byte = 24 + 7 = 31 leading zero bits)
    const code = new Uint8Array([
      0x7f, // PUSH32
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x1e, // CLZ
    ])

    const result = await tvm.runCode({ code })
    assert.isUndefined(result.exceptionError)
    const [top] = result.runState!.stack.peek(1)
    assert.strictEqual(top, 31n, 'CLZ(0x00000001...) should be 31')
  })
})
