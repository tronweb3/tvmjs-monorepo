import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { SIGNER_A } from '@tvmjs/testdata'
import { createTVM } from '@tvmjs/tvm'
import { createLegacyTx } from '@tvmjs/tx'
import {
  Account,
  bytesToBigInt,
  createAddressFromString,
  hexToBytes,
  setLengthLeft,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createVM, runTx } from '../../src/index.ts'

import type { InterpreterStep } from '@tvmjs/tvm'
import type { PrefixedHexString } from '@tvmjs/util'

const contract = createAddressFromString(`0x${'22'.repeat(20)}`)
const coinbase = createAddressFromString(`0x${'33'.repeat(20)}`)
// Bytecode retained from the former EIP-2929 suite. Expected costs use the pinned
// java-tron version-0 schedule documented in tvm/test/testdata/tronEnergy.json.
const vectors = [
  {
    name: 'precompile, external, origin and self account reads',
    code: '0x60013f5060023b506003315060f13f5060f23b5060f3315060f23f5060f33b5060f1315032315030315000',
    energy: 1413n,
    costs: [400n, 20n, 20n, 400n, 20n, 20n, 400n, 20n, 20n, 20n, 20n],
  },
  {
    name: 'repeated EXTCODECOPY',
    code: '0x60006000600060ff3c60006000600060ff3c600060006000303c00',
    energy: 95n,
    costs: [20n, 20n, 20n],
  },
  {
    name: 'SLOAD and repeated SSTORE',
    code: '0x6001545060116001556011600255601160025560025460015400',
    energy: 45179n,
    costs: [50n, 20000n, 20000n, 5000n, 50n, 50n],
  },
] as const
const callFF = '6000808080806000195AF1'
const nestedVectors = [
  [
    'precompile CALL and repeated CALL/STATICCALL',
    '0x60008080808060046000f15060008080808060ff6000f15060008080808060ff6000fa5000',
    189n,
    false,
  ],
  ['SLOAD across nested calls', '0x60005460003415601357600080808080305AF15B00', 209n, false],
  [
    'SLOAD after a nested revert',
    '0x341515600D57600054600080FD5B600080808080305AF160005400',
    214n,
    true,
  ],
  [
    'repeated address calls across frames',
    `0x${callFF}60003415601B57600080808080305AF15B00`,
    229n,
    false,
  ],
  [
    'repeated address calls after a nested revert',
    `0x341515601557${callFF}600080FD5B600080808080305AF1${callFF}00`,
    234n,
    true,
  ],
] as const

describe.each([TronMainnet, TronNile, TronShasta])('TRON access accounting on $name', (chain) => {
  async function setup(code: PrefixedHexString) {
    const common = new Common({ chain })
    const tvm = await createTVM({ common })
    const vm = await createVM({ common, tvm })
    await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 10n ** 18n))
    await vm.stateManager.putAccount(contract, new Account())
    await vm.stateManager.putAccount(coinbase, new Account())
    await vm.stateManager.putCode(contract, hexToBytes(code))
    const block = createBlock({ header: { coinbase, gasLimit: 1000000n } }, { common })
    const tx = createLegacyTx(
      { to: contract, value: 1n, gasLimit: 100000n, gasPrice: 10n },
      { common },
    ).sign(SIGNER_A.privateKey)
    return { vm, tvm, tx, block }
  }

  for (const vector of vectors) {
    it(`${vector.name} use fixed costs without cold/warm discounts`, async () => {
      const { vm, tvm, tx, block } = await setup(vector.code)
      const steps: Pick<InterpreterStep, 'opcode' | 'gasLeft'>[] = []
      vm.tvm.events!.on('step', (step) => {
        steps.push({ opcode: step.opcode, gasLeft: step.gasLeft })
        assert.isFalse(tvm.journal.isWarmedAddress(contract.bytes))
        assert.isFalse(tvm.journal.isWarmedStorage(contract.bytes, new Uint8Array(32)))
      })
      const result = await runTx(vm, { tx, block, reportAccessList: true })
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.executionGasUsed, vector.energy)
      assert.strictEqual(result.totalGasSpent, 21000n + vector.energy)
      assert.strictEqual(result.gasRefund, 0n)
      const costs = steps.flatMap((step, i) =>
        ['BALANCE', 'EXTCODESIZE', 'EXTCODEHASH', 'EXTCODECOPY', 'SLOAD', 'SSTORE'].includes(
          step.opcode.name,
        )
          ? [step.gasLeft - steps[i + 1].gasLeft]
          : [],
      )
      assert.deepEqual(costs, [...vector.costs])
      assert.isAbove(result.accessList!.length, 0)
      if (vector.name === 'SLOAD and repeated SSTORE') {
        for (const key of [1, 2])
          assert.strictEqual(
            bytesToBigInt(
              await vm.stateManager.getStorage(contract, setLengthLeft(Uint8Array.of(key), 32)),
            ),
            17n,
          )
      }
    })
  }

  for (const [name, code, energy, hasRevert] of nestedVectors) {
    it(name, async () => {
      const { vm, tvm, tx, block } = await setup(code)
      let revertedFrames = 0
      vm.tvm.events!.on('afterMessage', (result) => {
        if (result.execResult.exceptionError?.error === 'revert') revertedFrames++
        assert.isFalse(tvm.journal.isWarmedAddress(contract.bytes))
        assert.isFalse(tvm.journal.isWarmedStorage(contract.bytes, new Uint8Array(32)))
      })
      const result = await runTx(vm, { tx, block })
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.executionGasUsed, energy)
      assert.strictEqual(result.totalGasSpent, 21000n + energy)
      assert.strictEqual(result.gasRefund, 0n)
      assert.strictEqual(revertedFrames, hasRevert ? 1 : 0)
      assert.strictEqual((await vm.stateManager.getAccount(contract))!.balance, 1n)
    })
  }

  it.each([
    ['BALANCE', '0x41315041315000', 48n],
    ['CALL', '0x600080808080415af1600080808080415af100', 118n],
  ] as const)(
    'charges repeated coinbase %s without EIP-3651 warming',
    async (_name, code, energy) => {
      const { vm, tvm, tx, block } = await setup(code)
      vm.tvm.events!.on('beforeMessage', () =>
        assert.isFalse(tvm.journal.isWarmedAddress(coinbase.bytes)),
      )
      const result = await runTx(vm, { tx, block })
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.executionGasUsed, energy)
      assert.strictEqual(result.totalGasSpent, 21000n + energy)
      assert.strictEqual(result.gasRefund, 0n)
      assert.isFalse(vm.common.isActivatedEIP(3651))
    },
  )
})
