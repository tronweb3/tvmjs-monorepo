import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { Account, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/index.ts'

const contract = createAddressFromString('0x' + '21'.repeat(20))
const target = createAddressFromString('0x' + '31'.repeat(20))

describe.each([TronMainnet, TronNile, TronShasta])('TRON account existence on $name', (chain) => {
  for (const exists of [false, true]) {
    it.each([0, 1])(`CALL value=%s with an existing account=${exists}`, async (value) => {
      const vm = await createVM({ common: new Common({ chain }) })
      await vm.stateManager.putAccount(contract, new Account(0n, 10n))
      if (exists) await vm.stateManager.putAccount(target, new Account())
      const code = hexToBytes(
        `0x6000600060006000600${value}73${target.toString().slice(2)}61fffff100`,
      )
      await vm.stateManager.putCode(contract, code)
      const result = await vm.tvm.runCall({ to: contract, gasLimit: 100000n })
      assert.isUndefined(result.execResult.exceptionError)
      // Seven PUSHes, CALL base 40; a value call adds 9000 and returns its
      // unused 2300 stipend. Only a missing value recipient adds 25000.
      const energy = 7n * 3n + 40n + (value ? 9000n - 2300n + (exists ? 0n : 25000n) : 0n)
      assert.strictEqual(result.execResult.executionGasUsed, energy)
      assert.deepEqual(result.execResult.runState!.stack.getStack(), [1n])
      const recipient = await vm.stateManager.getAccount(target)
      if (exists || value) assert.strictEqual(recipient!.balance, BigInt(value))
      else assert.isUndefined(recipient)
      assert.strictEqual((await vm.stateManager.getAccount(contract))!.balance, 10n - BigInt(value))
    })
  }
})
