import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import {
  Account,
  Address,
  createAddressFromString,
  generateTronAddress2,
  hexToBytes,
} from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import { TVM, TVMError, createTVM, paramsTVM } from '../../src/index.ts'

const caller = createAddressFromString(`0x${'11'.repeat(20)}`)
const factory = createAddressFromString(`0x${'22'.repeat(20)}`)
const rootTransactionId = hexToBytes(
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
)

// Fixed TRON Energy vectors include PUSH instructions, memory expansion and result storage.
// CREATE2 additionally charges six Energy per hashed word; neither opcode meters initcode.
const vectors = [
  { size: 0, create: 32021n, create2: 32024n },
  { size: 31, create: 32021n, create2: 32030n },
  { size: 32, create: 32021n, create2: 32030n },
  { size: 33, create: 32024n, create2: 32039n },
  { size: 49151, create: 41234n, create2: 50453n },
  { size: 49152, create: 41234n, create2: 50453n },
  { size: 49153, create: 41243n, create2: 50468n },
]

describe.each([TronMainnet, TronNile, TronShasta])('TRON initcode execution on $name', (chain) => {
  const common = () => new Common({ chain, activatedProposals: [95, 96], eips: [7939] })

  it.each(vectors)('accepts $size bytes in a top-level deployment', async ({ size }) => {
    const tvm = await createTVM({ common: common() })
    await tvm.stateManager.putAccount(caller, new Account(0n, 100n))
    const result = await tvm.runCall({
      caller,
      data: new Uint8Array(size),
      value: 7n,
      gasLimit: 100000n,
      rootTransactionId,
    })
    expect(result.execResult.exceptionError).toBeUndefined()
    expect(result.execResult.executionGasUsed).toBe(0n)
    expect(result.createdAddress?.toString()).toBe('0x83406c6537ca51e460302d2b2ef235ea1cad2f46')
    expect(await tvm.stateManager.getCode(result.createdAddress!)).toHaveLength(0)
    const account = await tvm.stateManager.getAccount(result.createdAddress!)
    expect(account?.nonce).toBe(1n)
    expect(account?.balance).toBe(7n)
    expect((await tvm.stateManager.getAccount(caller))?.balance).toBe(93n)
  })

  describe.each(['f0', 'f5'] as const)('opcode 0x%s', (opcode) => {
    it.each(vectors)('deploys $size bytes without initcode word metering', async (vector) => {
      const tvm = await createTVM({ common: common() })
      const size = vector.size.toString(16).padStart(4, '0')
      const code = hexToBytes(
        `0x${opcode === 'f5' ? '6000' : ''}61${size}60006000${opcode}60005260206000f3`,
      )
      await tvm.stateManager.putAccount(factory, new Account())
      await tvm.stateManager.putCode(factory, code)
      const energy = opcode === 'f0' ? vector.create : vector.create2
      const result = await tvm.runCall({ to: factory, gasLimit: energy, rootTransactionId })
      expect(result.execResult.exceptionError).toBeUndefined()
      expect(result.execResult.executionGasUsed).toBe(energy)
      const word = result.execResult.returnValue
      expect(word).toHaveLength(32)
      expect(word.slice(0, 11)).toEqual(new Uint8Array(11))
      expect(word[11]).toBe(0x41)
      const address = new Address(word.slice(12))
      const expected =
        opcode === 'f0'
          ? createAddressFromString('0xe5732ce09bab3ecf290d7a67c4bbbf294ecec649')
          : new Address(
              generateTronAddress2(factory.bytes, new Uint8Array(32), new Uint8Array(vector.size)),
            )
      expect(address.equals(expected)).toBe(true)
      expect((await tvm.stateManager.getAccount(address))?.nonce).toBe(1n)
      expect(await tvm.stateManager.getCode(address)).toHaveLength(0)
      expect((await tvm.stateManager.getAccount(factory))?.nonce).toBe(1n)
    })
  })

  it('retains EXP pricing and the active EIP-607 implementation group', async () => {
    const tvm = await createTVM({ common: common() })
    expect(tvm.common.isActivatedEIP(607)).toBe(true)
    expect(tvm.common.param('expByteGas')).toBe(10n)
    const result = await tvm.runCode({ code: hexToBytes('0x600260020a00'), gasLimit: 26n })
    expect(result.exceptionError).toBeUndefined()
    expect(result.executionGasUsed).toBe(26n)
    expect(result.runState!.stack.peek()).toEqual([4n])
  })
})

describe('removed TVM contract size configuration', () => {
  it.each(['allowUnlimitedContractSize', 'allowUnlimitedInitCodeSize'])(
    'rejects %s before initialization, regardless of its value or ownership',
    async (option) => {
      const common = new Common({ chain: TronMainnet })
      const updateParams = vi.spyOn(common, 'updateParams')
      for (const value of [true, false, undefined, null]) {
        for (const opts of [
          { common, [option]: value },
          Object.assign(Object.create({ [option]: value }), { common }),
        ]) {
          await expect(createTVM(opts)).rejects.toThrow(`The ${option} option has been removed`)
          expect(() => new TVM(opts)).toThrow(`The ${option} option has been removed`)
        }
      }
      expect(updateParams).not.toHaveBeenCalled()
    },
  )

  it('removes public size parameters and unreachable error identifiers', async () => {
    const tvm = await createTVM()
    expect(paramsTVM).not.toHaveProperty('3860')
    expect(paramsTVM[607]).not.toHaveProperty('maxCodeSize')
    for (const name of ['maxCodeSize', 'maxInitCodeSize', 'initCodeWordGas']) {
      expect(() => tvm.common.param(name)).toThrow(/Missing parameter/)
    }
    expect(TVMError.errorMessages).not.toHaveProperty('CODESIZE_EXCEEDS_MAXIMUM')
    expect(TVMError.errorMessages).not.toHaveProperty('INITCODE_SIZE_VIOLATION')
  })
})
