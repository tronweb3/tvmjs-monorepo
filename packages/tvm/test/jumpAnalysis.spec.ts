import { concatBytes, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { assert, afterEach, describe, expect, it, vi } from 'vitest'

import { TVMError } from '../src/errors.ts'
import { createTVM } from '../src/index.ts'
import { Interpreter } from '../src/interpreter.ts'

const address = createAddressFromString(`0x${'11'.repeat(20)}`)

afterEach(() => vi.restoreAllMocks())

function trackAnalysis() {
  const analyze = Interpreter.prototype._getValidJumpDestinations
  const gasAtAnalysis: bigint[] = []
  const spy = vi
    .spyOn(Interpreter.prototype, '_getValidJumpDestinations')
    .mockImplementation(function (this: Interpreter, code: Uint8Array) {
      gasAtAnalysis.push(this.getGasLeft())
      return analyze.call(this, code)
    })
  return { spy, gasAtAnalysis }
}

function paddedCode(prefix: Uint8Array, size = 1024) {
  const code = new Uint8Array(size)
  code.set(prefix)
  return code
}

describe('jump analysis gas ordering', () => {
  it.each([
    { opcode: 0x56, size: 1024, gasLimit: 0n },
    { opcode: 0x56, size: 32768, gasLimit: 0n },
    { opcode: 0x57, size: 1024, gasLimit: 0n },
    { opcode: 0x57, size: 32768, gasLimit: 0n },
    { opcode: 0x56, size: 1024, gasLimit: 7n },
    { opcode: 0x57, size: 1024, gasLimit: 9n },
  ])(
    'rejects opcode $opcode with gas $gasLimit without scanning $size bytes on repeated calls',
    async ({ opcode, size, gasLimit }) => {
      const tvm = await createTVM()
      await tvm.stateManager.putCode(address, paddedCode(Uint8Array.of(opcode), size))
      const analysis = trackAnalysis()
      const steps: { pc: number; gasLeft: bigint; opcode: number }[] = []
      tvm.events.on('step', (step) => {
        steps.push({ pc: step.pc, gasLeft: step.gasLeft, opcode: step.opcode.code })
      })

      for (let i = 0; i < 3; i++) {
        const { execResult } = await tvm.runCall({ to: address, gasLimit, value: 0n })
        assert.strictEqual(execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
        assert.strictEqual(execResult.executionGasUsed, gasLimit)
      }

      assert.deepEqual(
        steps,
        Array.from({ length: 3 }, () => ({ pc: 0, gasLeft: gasLimit, opcode })),
      )
      assert.strictEqual(analysis.spy.mock.calls.length, 0)
    },
  )

  it.each([1024, 32768])('keeps zero gas STOP calls successful for %i bytes', async (size) => {
    const tvm = await createTVM()
    await tvm.stateManager.putCode(address, new Uint8Array(size))
    const analysis = trackAnalysis()

    for (let i = 0; i < 3; i++) {
      const { execResult } = await tvm.runCall({ to: address, gasLimit: 0n, value: 0n })
      assert.isUndefined(execResult.exceptionError)
      assert.strictEqual(execResult.executionGasUsed, 0n)
    }
    assert.strictEqual(analysis.spy.mock.calls.length, 0)
  })

  it.each([
    { name: 'JUMP', prefix: '0x6003565b00', gasLimit: 3n },
    { name: 'JUMPI', prefix: '0x60016005575b00', gasLimit: 6n },
  ] as const)('does not scan when earlier instructions exhaust gas before $name', async (test) => {
    const tvm = await createTVM()
    await tvm.stateManager.putCode(address, paddedCode(hexToBytes(test.prefix), 32768))
    const analysis = trackAnalysis()

    const { execResult } = await tvm.runCall({ to: address, gasLimit: test.gasLimit, value: 0n })

    assert.strictEqual(execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
    assert.strictEqual(execResult.executionGasUsed, test.gasLimit)
    assert.strictEqual(analysis.spy.mock.calls.length, 0)
  })

  it('charges an affordable JUMP before analysis even if it leaves zero gas', async () => {
    const tvm = await createTVM()
    // PUSH1 costs 3 and JUMP costs 8. The following JUMPDEST then runs out of gas.
    await tvm.stateManager.putCode(address, paddedCode(hexToBytes('0x6003565b00')))
    const analysis = trackAnalysis()

    const { execResult } = await tvm.runCall({ to: address, gasLimit: 11n, value: 0n })

    assert.strictEqual(execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
    assert.strictEqual(execResult.executionGasUsed, 11n)
    expect(analysis.spy).toHaveBeenCalledTimes(1)
    assert.deepEqual(analysis.gasAtAnalysis, [0n])
    assert.strictEqual(execResult.runState?.programCounter, 3)
  })

  it.each([
    {
      name: 'forward jumps and cached PUSH values',
      code: '0x6006560000005b600b56005b602a00',
      gasLimit: 27n,
      gasAtAnalysis: 16n,
      stack: [42n],
    },
    {
      name: 'backward conditional jumps',
      code: '0x60025b600190038060025700',
      gasLimit: 55n,
      gasAtAnalysis: 26n,
      stack: [0n],
    },
  ] as const)('preserves $name with one analysis per execution', async (test) => {
    const tvm = await createTVM()
    await tvm.stateManager.putCode(address, hexToBytes(test.code))
    const analysis = trackAnalysis()

    for (let i = 0; i < 3; i++) {
      const { execResult } = await tvm.runCall({ to: address, gasLimit: test.gasLimit, value: 0n })
      assert.isUndefined(execResult.exceptionError)
      assert.strictEqual(execResult.executionGasUsed, test.gasLimit)
      assert.deepEqual(execResult.runState?.stack.getStack(), [...test.stack])
    }

    expect(analysis.spy).toHaveBeenCalledTimes(3)
    assert.deepEqual(analysis.gasAtAnalysis, [
      test.gasAtAnalysis,
      test.gasAtAnalysis,
      test.gasAtAnalysis,
    ])
  })

  it('still rejects a jump into PUSH data', async () => {
    const tvm = await createTVM()
    await tvm.stateManager.putCode(address, hexToBytes('0x600456605b00'))
    const analysis = trackAnalysis()

    const { execResult } = await tvm.runCall({ to: address, gasLimit: 20n, value: 0n })

    assert.include(execResult.exceptionError?.error, TVMError.errorMessages.INVALID_JUMP)
    assert.strictEqual(execResult.executionGasUsed, 20n)
    assert.strictEqual(execResult.runState?.validJumps[4], 0)
    assert.deepEqual(analysis.gasAtAnalysis, [9n])
  })

  it.each([6n, 9n])(
    'does not analyze jump destinations for MCOPY with %s gas',
    async (gasLimit) => {
      const tvm = await createTVM()
      // Three PUSH0 instructions, zero-length MCOPY, STOP.
      await tvm.stateManager.putCode(address, paddedCode(hexToBytes('0x5f5f5f5e00'), 32768))
      const analysis = trackAnalysis()

      const { execResult } = await tvm.runCall({ to: address, gasLimit, value: 0n })

      assert.strictEqual(
        execResult.exceptionError?.error,
        gasLimit === 6n ? TVMError.errorMessages.OUT_OF_GAS : undefined,
      )
      assert.strictEqual(execResult.executionGasUsed, gasLimit)
      assert.strictEqual(analysis.spy.mock.calls.length, 0)
    },
  )

  it('checks the full custom opcode gas cost before analyzing jumps', async () => {
    const logicFunction = vi.fn()
    const tvm = await createTVM({
      customOpcodes: [
        {
          opcode: 0x56,
          opcodeName: 'JUMP',
          baseFee: 0,
          gasFunction: (_runState, gas) => gas + 5n,
          logicFunction,
        },
      ],
    })
    await tvm.stateManager.putCode(address, paddedCode(Uint8Array.of(0x56)))
    const analysis = trackAnalysis()

    const { execResult } = await tvm.runCall({ to: address, gasLimit: 4n, value: 0n })

    assert.strictEqual(execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
    assert.strictEqual(execResult.executionGasUsed, 4n)
    assert.strictEqual(analysis.spy.mock.calls.length, 0)
    expect(logicFunction).not.toHaveBeenCalled()
  })

  it('does not analyze a removed jump opcode', async () => {
    const tvm = await createTVM({ customOpcodes: [{ opcode: 0x56 }] })
    await tvm.stateManager.putCode(address, paddedCode(Uint8Array.of(0x56)))
    const analysis = trackAnalysis()

    const { execResult } = await tvm.runCall({ to: address, gasLimit: 20n, value: 0n })

    assert.strictEqual(execResult.exceptionError?.error, TVMError.errorMessages.INVALID_OPCODE)
    assert.strictEqual(analysis.spy.mock.calls.length, 0)
  })

  it('avoids analysis in a child call receiving zero gas', async () => {
    const tvm = await createTVM()
    const child = createAddressFromString(`0x${'22'.repeat(20)}`)
    await tvm.stateManager.putCode(child, paddedCode(Uint8Array.of(0x56), 32768))
    await tvm.stateManager.putCode(
      address,
      concatBytes(hexToBytes('0x6000600060006000600073'), child.bytes, hexToBytes('0x6000f100')),
    )
    const analysis = trackAnalysis()

    const { execResult } = await tvm.runCall({ to: address, gasLimit: 1000n, value: 0n })

    assert.isUndefined(execResult.exceptionError)
    assert.deepEqual(execResult.runState?.stack.getStack(), [0n])
    assert.strictEqual(analysis.spy.mock.calls.length, 0)
  })
})
