import type { InterpreterStep } from '@tvmjs/tvm'
import { bytesToHex } from '@tvmjs/util'
import type { AfterTxEvent, VM } from '../src/index.ts'

/**
 * Formats an individual TVM step trace as a JSON object
 * @param step an {@link InterpreterStep} emitted by the TVM `step` event
 * @param memory whether to include the memory in the trace
 * @returns a JSON object that matches the EIP-7756 trace format
 */
export const stepTraceJSON = (step: InterpreterStep, memory: boolean = false) => {
  let hexStack = []
  hexStack = step.stack.map((item: bigint) => {
    return '0x' + item.toString(16)
  })
  let memWords = undefined
  const memSize = Number(step.memoryWordCount) * 32 // memSize is reported in bytes, not words (i.e 32 bytes)
  if (memory) {
    memWords = []
    for (let i = 0; i < step.memoryWordCount; i++) {
      memWords.push(bytesToHex(step.memory.slice(i * 32, (i + 1) * 32))) // memory is returned in 32 byte words
    }
  }

  const opTrace = {
    pc: step.pc,
    op: '0x' + step.opcode.code.toString(16),
    gas: Number(step.gasLeft),
    gasCost: Number(step.opcode.dynamicFee ?? BigInt(step.opcode.fee)), // if `dynamicFee` is set, it includes base fee
    memory: memory ? memWords : undefined,
    memSize,
    stack: hexStack,
    depth: step.depth + 1, // Depth starts at 1 - EIP-7756
    refund: Number(step.gasRefund),
    opName: step.opcode.name,
    section: step.eofSection,
    immediate: step.immediate !== undefined ? bytesToHex(step.immediate) : undefined,
    functionDepth: step.eofFunctionDepth,
    error: step.error !== undefined ? step.error.toString() : undefined,
  }
  return opTrace
}

/**
 * Formats an individual TVM summary trace as a JSON object
 * @param event an {@link AfterTxEvent} emitted by the vm `afterTx` event
 * @param vm a {@link VM} instance
 * @returns a JSON object that matches the EIP-7756 summary object format
 */
export const summaryTraceJSON = async (event: AfterTxEvent, vm: VM) => {
  const summary = {
    stateRoot: bytesToHex(await vm.stateManager.getStateRoot()),
    output: event.execResult.returnValue.length > 0 ? bytesToHex(event.execResult.returnValue) : '',
    gasUsed: Number(event.totalGasSpent),
    pass: event.execResult.exceptionError === undefined,
    fork: vm.common.hardfork(),
  }
  return summary
}
