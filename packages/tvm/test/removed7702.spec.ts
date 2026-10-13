import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import {
  Account,
  bytesToBigInt,
  concatBytes,
  createAddressFromString,
  hexToBytes,
} from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import { createTVM } from '../src/index.ts'

const pointer = createAddressFromString(`0x${'11'.repeat(20)}`)
const target = createAddressFromString(`0x${'22'.repeat(20)}`)
const contract = createAddressFromString(`0x${'33'.repeat(20)}`)
const caller = createAddressFromString(`0x${'44'.repeat(20)}`)
const slot = new Uint8Array(32)
const designator = concatBytes(hexToBytes('0xef0100'), target.bytes)

async function createCodeTVM(common: Common) {
  const tvm = await createTVM({ common })
  for (const address of [pointer, target, contract, caller]) {
    await tvm.stateManager.putAccount(address, new Account())
  }
  await tvm.stateManager.putCode(pointer, designator)
  await tvm.stateManager.putCode(target, hexToBytes('0x600760005500'))
  return tvm
}

describe.each([TronMainnet, TronNile, TronShasta])('EIP-7702 removal in TVM on $name', (chain) => {
  it('executes a former delegation designator as invalid code without reading its target', async () => {
    const tvm = await createCodeTVM(new Common({ chain }))
    const getCode = vi.spyOn(tvm.stateManager, 'getCode')
    const putStorage = vi.spyOn(tvm.stateManager, 'putStorage')
    const result = await tvm.runCall({ caller, to: pointer, gasLimit: 500000n })
    expect(result.execResult.exceptionError?.error).toBe('invalid opcode')
    expect(getCode.mock.calls.some(([address]) => address.equals(target))).toBe(false)
    expect(putStorage).not.toHaveBeenCalled()
    expect(await tvm.stateManager.getCode(pointer)).toEqual(designator)
    expect(await tvm.stateManager.getStorage(pointer, slot)).toHaveLength(0)
    expect(await tvm.stateManager.getStorage(target, slot)).toHaveLength(0)
  })

  describe.each(['CALL', 'DELEGATECALL'] as const)('%s behavior', (opcode) => {
    it.each([false, true])(
      'preserves code and storage context (designator=%s)',
      async (delegated) => {
        const tvm = await createCodeTVM(new Common({ chain }))
        const callee = delegated ? pointer : target
        const call = opcode === 'CALL' ? '60006000600060006000' : '6000600060006000'
        const instruction = opcode === 'CALL' ? 'f1' : 'f4'
        await tvm.stateManager.putCode(
          contract,
          hexToBytes(
            `0x${call}73${callee.toString().slice(2)}61ffff${instruction}60005260206000f3`,
          ),
        )
        const getCode = vi.spyOn(tvm.stateManager, 'getCode')
        const result = await tvm.runCall({ caller, to: contract, gasLimit: 500000n })
        expect(result.execResult.exceptionError).toBeUndefined()
        expect(bytesToBigInt(result.execResult.returnValue)).toBe(delegated ? 0n : 1n)
        expect(getCode.mock.calls.some(([address]) => address.equals(target))).toBe(!delegated)
        expect(bytesToBigInt(await tvm.stateManager.getStorage(target, slot))).toBe(
          !delegated && opcode === 'CALL' ? 7n : 0n,
        )
        expect(bytesToBigInt(await tvm.stateManager.getStorage(contract, slot))).toBe(
          !delegated && opcode === 'DELEGATECALL' ? 7n : 0n,
        )
        expect(await tvm.stateManager.getStorage(pointer, slot)).toHaveLength(0)
        expect(await tvm.stateManager.getCode(pointer)).toEqual(designator)
      },
    )
  })

  it('reverts ordinary nested CALL storage when its parent reverts', async () => {
    const tvm = await createCodeTVM(new Common({ chain }))
    await tvm.stateManager.putCode(
      contract,
      hexToBytes(`0x6000600060006000600073${target.toString().slice(2)}61fffff160006000fd`),
    )
    const putStorage = vi.spyOn(tvm.stateManager, 'putStorage')
    const result = await tvm.runCall({ caller, to: contract, gasLimit: 500000n })
    expect(result.execResult.exceptionError?.error).toBe('revert')
    expect(putStorage.mock.calls.some(([address]) => address.equals(target))).toBe(true)
    expect(await tvm.stateManager.getStorage(target, slot)).toHaveLength(0)
    expect(await tvm.stateManager.getStorage(contract, slot)).toHaveLength(0)
  })
})
