import { Common, TronMainnet } from '@tvmjs/common'
import { MerkleStateManager, SimpleStateManager } from '@tvmjs/statemanager'
import { SIGNER_A } from '@tvmjs/testdata'
import { createTVM } from '@tvmjs/tvm'
import { createAccessList2930Tx, createFeeMarket1559Tx, createLegacyTx } from '@tvmjs/tx'
import { Account, bytesToBigInt, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { assert, describe, it, vi } from 'vitest'

import energyVectors from '../../../tvm/test/testdata/tronEnergy.json' with { type: 'json' }
import { createVM, runTx } from '../../src/index.ts'

import type { StateManagerInterface } from '@tvmjs/common'
import type { AccessListBytes } from '@tvmjs/tx'

const contract = createAddressFromString('0x1000000000000000000000000000000000000001')
const target = createAddressFromString('0x2000000000000000000000000000000000000002')
const slot = new Uint8Array(32)
const tokenId = 1000001n
const call = (value: number) =>
  `0x6000600060006000600${value}73${target.toString().slice(2)}61fffff1` as const
const callToken = `0x6000600060006000620f4241600173${target.toString().slice(2)}61ffffd0` as const

async function initialize(state: StateManagerInterface, code: `0x${string}`) {
  await state.putAccount(SIGNER_A.address, new Account(0n, 10n ** 18n))
  const account = new Account(0n, 100n)
  account.asset = { [tokenId.toString()]: 100n }
  await state.putAccount(contract, account)
  await state.putCode(contract, hexToBytes(code))
  await state.putAccount(target, new Account())
}

for (const StateManager of [SimpleStateManager, MerkleStateManager]) {
  describe(`VM/TVM Energy consistency with ${StateManager.name}`, () => {
    for (const vector of energyVectors.vectors) {
      it(vector.name, async () => {
        const common = new Common({ chain: TronMainnet, activatedProposals: [] })
        const vmCommon = common.copy()
        const tvmCommon = common.copy()
        const vm = await createVM({
          common: vmCommon,
          stateManager: new StateManager({ common: vmCommon }),
        })
        const tvm = await createTVM({
          common: tvmCommon,
          stateManager: new StateManager({ common: tvmCommon }),
        })
        for (const state of [vm.stateManager, tvm.stateManager]) {
          await initialize(state, vector.code as `0x${string}`)
        }
        const tx = createLegacyTx(
          { to: contract, gasLimit: 100000n, gasPrice: 10n },
          { common: vm.common },
        ).sign(SIGNER_A.privateKey)
        const actual = await runTx(vm, { tx })
        const direct = await tvm.runCall({
          caller: SIGNER_A.address,
          to: contract,
          gasLimit: tx.gasLimit - tx.getIntrinsicGas(),
          rootTransactionId: tx.hash(),
        })
        assert.isUndefined(actual.execResult.exceptionError)
        assert.isUndefined(direct.execResult.exceptionError)
        assert.strictEqual(actual.execResult.executionGasUsed, BigInt(vector.energy))
        assert.strictEqual(actual.execResult.executionGasUsed, direct.execResult.executionGasUsed)
        assert.strictEqual(actual.gasRefund, 0n)
        assert.strictEqual(direct.execResult.gasRefund, 0n)
        assert.strictEqual(actual.totalGasSpent, BigInt(vector.energy) + tx.getIntrinsicGas())
        assert.deepEqual(actual.execResult.returnValue, direct.execResult.returnValue)
        assert.deepEqual(
          await vm.stateManager.getStorage(contract, slot),
          await tvm.stateManager.getStorage(contract, slot),
        )
      })
    }

    it.each([false, true])('matches CALLTOKEN state and Energy with revert=%s', async (revert) => {
      const vm = await createVM({ stateManager: new StateManager() })
      const tvm = await createTVM({ stateManager: new StateManager() })
      for (const state of [vm.stateManager, tvm.stateManager]) {
        await initialize(state, callToken)
        await state.putCode(
          target,
          hexToBytes(revert ? '0x600160005560006000fd' : '0x600160005500'),
        )
      }
      const tx = createLegacyTx(
        { to: contract, gasLimit: 100000n, gasPrice: 10n },
        { common: vm.common },
      ).sign(SIGNER_A.privateKey)
      const actual = await runTx(vm, { tx })
      const direct = await tvm.runCall({
        caller: SIGNER_A.address,
        to: contract,
        gasLimit: tx.gasLimit - tx.getIntrinsicGas(),
      })
      assert.isUndefined(actual.execResult.exceptionError)
      assert.isUndefined(direct.execResult.exceptionError)
      assert.strictEqual(actual.execResult.executionGasUsed, direct.execResult.executionGasUsed)
      assert.strictEqual(actual.gasRefund, 0n)
      for (const state of [vm.stateManager, tvm.stateManager]) {
        assert.strictEqual(
          (await state.getAccount(contract))!.getTokenBalance(tokenId),
          revert ? 100n : 99n,
        )
        assert.strictEqual(
          (await state.getAccount(target))!.getTokenBalance(tokenId),
          revert ? 0n : 1n,
        )
        assert.strictEqual(bytesToBigInt(await state.getStorage(target, slot)), revert ? 0n : 1n)
      }
    })

    it('preserves an empty recipient across transactions and does not charge creation later', async () => {
      const vm = await createVM({ stateManager: new StateManager() })
      await initialize(vm.stateManager, call(0))
      for (const value of [0, 1]) {
        await vm.stateManager.putCode(contract, hexToBytes(call(value)))
        const tx = createLegacyTx(
          { to: contract, gasLimit: 100000n, gasPrice: 10n, nonce: BigInt(value) },
          { common: vm.common },
        ).sign(SIGNER_A.privateKey)
        const result = await runTx(vm, { tx })
        assert.isUndefined(result.execResult.exceptionError)
        assert.strictEqual(result.execResult.executionGasUsed, value === 0 ? 61n : 6761n)
        assert.strictEqual((await vm.stateManager.getAccount(target))!.balance, BigInt(value))
      }
    })
  })
}

describe('TRON transaction access lists', () => {
  it.each(['2930', '1559'] as const)(
    'retains %s encoding without access-list charges or prewarming',
    async (type) => {
      const gasUsed: bigint[] = []
      const intrinsic: bigint[] = []
      for (const withAccessList of [false, true]) {
        const common = new Common({ chain: TronMainnet, eips: [2930] })
        const vm = await createVM({ common })
        await initialize(vm.stateManager, '0x600054506000545000')
        const accessList: AccessListBytes = withAccessList
          ? [
              [target.bytes, [slot]],
              [contract.bytes, [slot]],
            ]
          : []
        const data = {
          to: contract,
          gasLimit: 100000n,
          accessList,
        }
        const tx = (
          type === '2930'
            ? createAccessList2930Tx({ ...data, gasPrice: 10n }, { common })
            : createFeeMarket1559Tx(
                { ...data, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n },
                { common },
              )
        ).sign(SIGNER_A.privateKey)
        assert.isTrue(tx.verifySignature())
        const addressWarming = vi.spyOn(vm.tvm.journal, 'addAlwaysWarmAddress')
        const slotWarming = vi.spyOn(vm.tvm.journal, 'addAlwaysWarmSlot')
        const result = await runTx(vm, { tx, reportAccessList: true })
        assert.isUndefined(result.execResult.exceptionError)
        assert.strictEqual(addressWarming.mock.calls.length, 0)
        assert.strictEqual(slotWarming.mock.calls.length, 0)
        assert.strictEqual(tx.common.param('accessListAddressGas'), 0n)
        assert.strictEqual(tx.common.param('accessListStorageKeyGas'), 0n)
        assert.isTrue(
          result.accessList!.some(
            (entry) => entry.address === contract.toString() && entry.storageKeys.length === 1,
          ),
        )
        if (withAccessList)
          assert.isTrue(result.accessList!.some((entry) => entry.address === target.toString()))
        gasUsed.push(result.execResult.executionGasUsed)
        intrinsic.push(tx.getIntrinsicGas())
      }
      assert.deepEqual(gasUsed, [110n, 110n])
      assert.deepEqual(intrinsic, [21000n, 21000n])
    },
  )
})
