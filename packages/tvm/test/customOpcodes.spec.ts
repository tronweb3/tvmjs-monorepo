import { equalsBytes, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createTVM } from '../src/index.ts'

import type { RunState } from '../src/interpreter.ts'
import type { AddOpcode } from '../src/types.ts'

describe('VM: custom opcodes', () => {
  const fee = 333
  const logicFee = BigInt(33)
  const totalFee = BigInt(fee) + logicFee
  const stackPush = BigInt(1)

  const testOpcode: AddOpcode = {
    opcode: 0x21,
    opcodeName: 'TEST',
    baseFee: fee,
    gasFunction(runState: RunState, gas: bigint) {
      return gas + logicFee
    },
    logicFunction(runState: RunState) {
      runState.stack.push(BigInt(stackPush))
    },
  }

  it('should add custom opcodes to the TVM', async () => {
    const tvm = await createTVM({ customOpcodes: [testOpcode] })
    const gas = 123456
    let correctOpcodeName: boolean = false
    tvm.events.on('step', (e) => {
      if (e.pc === 0) {
        correctOpcodeName = e.opcode.name === testOpcode.opcodeName
      }
    })
    const res = await tvm.runCode({
      code: hexToBytes('0x21'),
      gasLimit: BigInt(gas),
    })
    assert.isTrue(res.executionGasUsed === totalFee, 'successfully charged correct gas')
    assert.strictEqual(res.runState!.stack.peek()[0], stackPush, 'successfully ran opcode logic')
    assert.isTrue(correctOpcodeName, 'successfully set opcode name')
  })

  it('should delete opcodes from the TVM', async () => {
    const tvm = await createTVM({
      customOpcodes: [{ opcode: 0x20 }], // deletes KECCAK opcode
    })
    const gas = BigInt(123456)
    const res = await tvm.runCode({
      code: hexToBytes('0x20'),
      gasLimit: BigInt(gas),
    })
    assert.isTrue(res.executionGasUsed === gas, 'successfully deleted opcode')
  })

  it('should not override default opcodes', async () => {
    // This test ensures that always the original opcode map is used
    // Thus, each time you recreate a TVM, it is in a clean state
    const tvm = await createTVM({
      customOpcodes: [{ opcode: 0x01 }], // deletes ADD opcode
    })
    const gas = BigInt(123456)
    const res = await tvm.runCode({
      code: hexToBytes('0x01'),
      gasLimit: BigInt(gas),
    })
    assert.strictEqual(res.executionGasUsed, gas, 'successfully deleted opcode')

    const tvmDefault = await createTVM()

    // PUSH 04
    // PUSH 01
    // ADD      // Adds 4 and 1 -> stack is now [5]
    // PUSH 00
    // MSTORE  // Store 5 (this is a bytes32, so 31 0 bytes and then 1 byte with value 5) at memory position 0
    // PUSH 01 // RETURNDATA length
    // PUSH 1F // RETURNDATA offset
    // RETURN  // Returns 0x05
    const result = await tvmDefault.runCode!({
      code: hexToBytes('0x60046001016000526001601FF3'),
      gasLimit: BigInt(gas),
    })
    assert.isTrue(equalsBytes(result.returnValue, hexToBytes('0x05')))
  })

  it('should override opcodes in the TVM', async () => {
    testOpcode.opcode = 0x20 // Overrides KECCAK
    const tvm = await createTVM({ customOpcodes: [testOpcode] })
    const gas = 123456
    const res = await tvm.runCode({
      code: hexToBytes('0x20'),
      gasLimit: BigInt(gas),
    })
    assert.strictEqual(res.executionGasUsed, totalFee, 'successfully charged correct gas')
    assert.strictEqual(res.runState!.stack.peek()[0], stackPush, 'successfully ran opcode logic')
  })

  it('should pass the correct TVM options when copying the TVM', async () => {
    const fee = 333
    const stackPush = BigInt(1)

    const testOpcode: AddOpcode = {
      opcode: 0x21,
      opcodeName: 'TEST',
      baseFee: fee,
      logicFunction(runState: RunState) {
        runState.stack.push(BigInt(stackPush))
      },
    }

    const tvm = await createTVM({ customOpcodes: [testOpcode] })
    tvm.events.on('beforeMessage', () => {})
    tvm.events.on('beforeMessage', () => {})
    const tvmCopy = tvm.shallowCopy()

    assert.deepEqual(
      tvmCopy['_customOpcodes'],
      tvm['_customOpcodes'],
      'tvm.shallowCopy() successfully copied customOpcodes option',
    )

    assert.strictEqual(
      tvm.events.listenerCount('beforeMessage'),
      2,
      'original TVM instance should have two listeners',
    )
    assert.strictEqual(
      tvmCopy!.events!.listenerCount('beforeMessage'),
      0,
      'copied TVM instance should have zero listeners',
    )
  })
})
