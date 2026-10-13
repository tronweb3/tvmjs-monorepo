import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { MerkleStateManager, SimpleStateManager } from '@tvmjs/statemanager'
import { SIGNER_A } from '@tvmjs/testdata'
import { TVMError } from '@tvmjs/tvm'
import { createLegacyTx } from '@tvmjs/tx'
import {
  Account,
  bigIntToBytes,
  bytesToBigInt,
  createAddressFromString,
  hexToBytes,
  setLengthLeft,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createVM, runTx } from '../../src/index.ts'

const contract = createAddressFromString(`0x${'22'.repeat(20)}`)
const slot = new Uint8Array(32)
// Retain the 17 transition sequences from the former EIP-1283/2200/3529 tests.
// A first nonzero write to an absent slot costs 20000; written zero slots remain
// present in the transaction and all subsequent writes cost 5000. PUSH1 costs 3.
// See tvm/test/testdata/javaTronExecution.json for measured upstream execution.
const transitions = [
  [0, [0, 0], 10012],
  [0, [0, 1], 10012],
  [0, [1, 0], 25012],
  [0, [1, 2], 25012],
  [0, [1, 1], 25012],
  [1, [0, 0], 10012],
  [1, [0, 1], 10012],
  [1, [0, 2], 10012],
  [1, [2, 0], 10012],
  [1, [2, 3], 10012],
  [1, [2, 1], 10012],
  [1, [2, 2], 10012],
  [1, [1, 0], 10012],
  [1, [1, 2], 10012],
  [1, [1, 1], 10012],
  [0, [1, 0, 1], 30018],
  [1, [0, 1, 0], 15018],
] as const

for (const StateManager of [SimpleStateManager, MerkleStateManager]) {
  describe.each([TronMainnet, TronNile, TronShasta])(
    `TRON storage with ${StateManager.name} on $name`,
    (chain) => {
      for (const [initial, values, energy] of transitions) {
        it(`charges ${initial} -> ${values.join(' -> ')} without net-metering refunds`, async () => {
          const vm = await createVM({
            common: new Common({ chain }),
            stateManager: new StateManager(),
          })
          await vm.stateManager.putAccount(contract, new Account())
          await vm.stateManager.putStorage(contract, slot, bigIntToBytes(BigInt(initial)))
          await vm.stateManager.putCode(
            contract,
            hexToBytes(`0x${values.map((value) => `600${value}600055`).join('')}00`),
          )
          const result = await vm.tvm.runCall({ to: contract, gasLimit: 100000n })
          assert.isUndefined(result.execResult.exceptionError)
          assert.strictEqual(result.execResult.executionGasUsed, BigInt(energy))
          assert.strictEqual(result.execResult.gasRefund, 0n)
          assert.strictEqual(
            bytesToBigInt(await vm.stateManager.getStorage(contract, slot)),
            BigInt(values.at(-1)!),
          )
        })
      }

      it.each([5005n, 5006n])('uses the actual write cost at Energy limit %s', async (gasLimit) => {
        const vm = await createVM({
          common: new Common({ chain }),
          stateManager: new StateManager(),
        })
        await vm.stateManager.putAccount(contract, new Account())
        await vm.stateManager.putStorage(contract, slot, Uint8Array.of(1))
        await vm.stateManager.putCode(contract, hexToBytes('0x6000600055'))
        const result = await vm.tvm.runCall({ to: contract, gasLimit })
        assert.strictEqual(result.execResult.executionGasUsed, gasLimit)
        assert.strictEqual(
          result.execResult.exceptionError?.error,
          gasLimit === 5005n ? TVMError.errorMessages.OUT_OF_GAS : undefined,
        )
        assert.strictEqual(
          bytesToBigInt(await vm.stateManager.getStorage(contract, slot)),
          gasLimit === 5005n ? 1n : 0n,
        )
        assert.strictEqual(result.execResult.gasRefund, 0n)
      })

      it.each(['revert', 'out of gas'] as const)(
        'rolls back a completed write on %s',
        async (failure) => {
          const vm = await createVM({
            common: new Common({ chain }),
            stateManager: new StateManager(),
          })
          await vm.stateManager.putAccount(contract, new Account())
          const code = failure === 'revert' ? '0x600160005560006000fd' : '0x60016000556001600155'
          await vm.stateManager.putCode(contract, hexToBytes(code))
          const result = await vm.tvm.runCall({
            to: contract,
            gasLimit: failure === 'revert' ? 50000n : 20012n,
          })
          assert.strictEqual(result.execResult.exceptionError?.error, failure)
          assert.strictEqual(result.execResult.executionGasUsed, 20012n)
          assert.strictEqual(result.execResult.gasRefund, 0n)
          assert.strictEqual(bytesToBigInt(await vm.stateManager.getStorage(contract, slot)), 0n)
          assert.strictEqual(
            bytesToBigInt(
              await vm.stateManager.getStorage(contract, setLengthLeft(Uint8Array.of(1), 32)),
            ),
            0n,
          )
        },
      )

      it('clears 100 nonzero slots without applying the retired refund cap', async () => {
        const vm = await createVM({
          common: new Common({ chain }),
          stateManager: new StateManager(),
        })
        await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 10n ** 18n))
        await vm.stateManager.putAccount(contract, new Account())
        let code = '0x'
        for (let i = 0; i < 100; i++) {
          const key = setLengthLeft(bigIntToBytes(BigInt(i)), 32)
          await vm.stateManager.putStorage(contract, key, Uint8Array.of(1))
          code += `600060${i.toString(16).padStart(2, '0')}55`
        }
        await vm.stateManager.putCode(contract, hexToBytes(`${code}00` as `0x${string}`))
        const tx = createLegacyTx(
          { to: contract, gasLimit: 600000n, gasPrice: 10n },
          { common: vm.common },
        ).sign(SIGNER_A.privateKey)
        const result = await runTx(vm, { tx })
        assert.isUndefined(result.execResult.exceptionError)
        assert.strictEqual(result.execResult.executionGasUsed, 500600n)
        assert.strictEqual(result.gasRefund, 0n)
        assert.strictEqual(result.totalGasSpent, 521600n)
        assert.strictEqual(
          (await vm.stateManager.getAccount(SIGNER_A.address))!.balance,
          10n ** 18n - 5216000n,
        )
        for (let i = 0; i < 100; i++)
          assert.strictEqual(
            bytesToBigInt(
              await vm.stateManager.getStorage(
                contract,
                setLengthLeft(bigIntToBytes(BigInt(i)), 32),
              ),
            ),
            0n,
          )
      })

      it('does not refund SELFDESTRUCT', async () => {
        const vm = await createVM({
          common: new Common({ chain }),
          stateManager: new StateManager(),
        })
        await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 10n ** 18n))
        const tx = createLegacyTx(
          { data: '0x6000ff', gasLimit: 100000n, gasPrice: 10n },
          { common: vm.common },
        ).sign(SIGNER_A.privateKey)
        const result = await runTx(vm, { tx })
        assert.isUndefined(result.execResult.exceptionError)
        assert.strictEqual(result.gasRefund, 0n)
        assert.strictEqual(result.execResult.executionGasUsed, 30003n)
        assert.strictEqual(result.totalGasSpent, tx.getIntrinsicGas() + 30003n)
      })
    },
  )
}
