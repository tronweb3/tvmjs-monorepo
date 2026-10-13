import { Common, TronMainnet, TronNile, TronShasta, tronExecutionProfile } from '@tvmjs/common'
import {
  Account,
  bytesToBigInt,
  concatBytes,
  createAddressFromString,
  hexToBytes,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { TVMError, createTVM, paramsTVM } from '../src/index.ts'
import { accessAddressEIP2929, getAddressAccessCost } from '../src/opcodes/EIP2929.ts'

import type { TVMResult } from '../src/index.ts'

const caller = createAddressFromString(`0x${'11'.repeat(20)}`)
const factory = createAddressFromString(`0x${'22'.repeat(20)}`)
const rootTransactionId = new Uint8Array(32).fill(3)
// Store a value and emit a log before returning 32 bytes for code deposit.
const initcode = hexToBytes('0x600160005560006000a060206000f3')

describe.each([TronMainnet, TronNile, TronShasta])('TRON gas cleanup on $name', (chain) => {
  it('accepts every explicit profile group and preserves the TRON Energy schedule', async () => {
    for (const eips of [
      ...tronExecutionProfile.eips.map((eip) => [eip]),
      [...tronExecutionProfile.eips],
    ]) {
      const tvm = await createTVM({ common: new Common({ chain, eips }) })
      const result = await tvm.runCode({ code: hexToBytes('0x600031506000545000') })
      assert.isUndefined(result.exceptionError)
      assert.strictEqual(result.executionGasUsed, 80n)
      assert.isFalse(tvm.common.isActivatedEIP(2929))
      assert.isFalse(tvm.getActiveOpcodes().has(0x1e))
    }
  })

  it('accepts optional CLZ alongside explicit profile groups', async () => {
    const common = new Common({ chain, eips: [...tronExecutionProfile.eips, 7939] })
    for (const tvm of [
      await createTVM({ common }),
      (await createTVM({ common: common.copy() })).shallowCopy(),
    ]) {
      const result = await tvm.runCode({ code: hexToBytes('0x60011e00') })
      assert.isUndefined(result.exceptionError)
      assert.strictEqual(result.runState!.stack.peek()[0], 255n)
      assert.strictEqual(result.executionGasUsed, 8n)
    }
  })

  it('rejects retired pricing and EOF activation without changing the active profile', () => {
    const common = new Common({ chain })
    for (const eip of [1283, 2200, 2929, 3529, 3651, 3540, 7069, 4844, 7702, 3860]) {
      assert.throws(() => common.setEIPs([eip]), /not supported by the TRON execution profile/)
      assert.isFalse(common.isActivatedEIP(eip))
      assert.deepEqual(common.eips(), [])
    }
  })

  it('retains inactive EOF address helpers without warming TRON accesses', async () => {
    const tvm = await createTVM({ common: new Common({ chain }) })
    const result = await tvm.runCode({ code: hexToBytes('0x00') })
    const state = result.runState!
    assert.strictEqual(getAddressAccessCost(state, factory.bytes, tvm.common), 0n)
    assert.strictEqual(accessAddressEIP2929(state, factory.bytes, tvm.common), 0n)
    assert.isFalse(tvm.journal.isWarmedAddress(factory.bytes))
  })

  it('reverts all creation effects when initcode succeeds but code deposit runs out of Energy', async () => {
    const tvm = await createTVM({ common: new Common({ chain }) })
    await tvm.stateManager.putAccount(caller, new Account(0n, 100n))
    const opcodes: string[] = []
    tvm.events.on('step', (step) => opcodes.push(step.opcode.name))
    const result = await tvm.runCall({
      caller,
      data: initcode,
      value: 7n,
      gasLimit: 21000n,
      rootTransactionId,
    })
    assert.includeMembers(opcodes, ['SSTORE', 'LOG0', 'RETURN'])
    assert.strictEqual(result.execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
    assert.strictEqual(result.execResult.executionGasUsed, 21000n)
    assert.strictEqual(result.execResult.gasRefund, 0n)
    assert.deepEqual(result.execResult.logs, [])
    assert.strictEqual(result.execResult.selfdestruct!.size, 0)
    assert.strictEqual(result.execResult.createdAddresses!.size, 0)
    assert.isDefined(result.createdAddress)
    assert.isUndefined(await tvm.stateManager.getAccount(result.createdAddress!))
    assert.strictEqual((await tvm.stateManager.getCode(result.createdAddress!)).length, 0)
    assert.strictEqual((await tvm.stateManager.getAccount(caller))!.balance, 100n)
    assert.strictEqual((await tvm.stateManager.getAccount(caller))!.nonce, 1n)
  })

  it.each([0xf0, 0xf5])(
    'returns zero from opcode %s after a failed child code deposit',
    async (opcode) => {
      const tvm = await createTVM({ common: new Common({ chain }) })
      await tvm.stateManager.putAccount(factory, new Account(0n, 100n))
      const code = concatBytes(
        // Copy initcode after the factory's STOP, then create with value 7.
        Uint8Array.of(0x60, initcode.length, 0x60, opcode === 0xf0 ? 15 : 17, 0x60, 0, 0x39),
        opcode === 0xf5 ? Uint8Array.of(0x60, 0) : new Uint8Array(),
        Uint8Array.of(0x60, initcode.length, 0x60, 0, 0x60, 7, opcode, 0),
        initcode,
      )
      await tvm.stateManager.putCode(factory, code)
      let child: TVMResult | undefined
      tvm.events.on('afterMessage', (result) => {
        if (result.createdAddress !== undefined) child = result
      })
      const result = await tvm.runCall({ caller, to: factory, gasLimit: 57000n, rootTransactionId })
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.runState!.stack.peek()[0], 0n)
      assert.isDefined(child)
      assert.strictEqual(child!.execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
      assert.deepEqual(child!.execResult.logs, [])
      assert.strictEqual(child!.execResult.gasRefund, 0n)
      assert.isUndefined(await tvm.stateManager.getAccount(child!.createdAddress!))
      assert.strictEqual(
        bytesToBigInt(await tvm.stateManager.getStorage(factory, new Uint8Array(32))),
        0n,
      )
      assert.strictEqual((await tvm.stateManager.getAccount(factory))!.balance, 100n)
      assert.strictEqual((await tvm.stateManager.getAccount(factory))!.nonce, 1n)
    },
  )
})

it('removes retired storage parameters while retaining the live TRON and EOF address schedules', async () => {
  const removed = [
    'netSstoreNoopGas',
    'netSstoreInitGas',
    'netSstoreCleanGas',
    'netSstoreDirtyGas',
    'netSstoreClearRefundGas',
    'netSstoreResetRefundGas',
    'netSstoreResetClearRefundGas',
    'sstoreSentryEIP2200Gas',
    'sstoreNoopEIP2200Gas',
    'sstoreDirtyEIP2200Gas',
    'sstoreInitEIP2200Gas',
    'sstoreInitRefundEIP2200Gas',
    'sstoreCleanEIP2200Gas',
    'sstoreCleanRefundEIP2200Gas',
    'sstoreClearRefundEIP2200Gas',
    'coldsloadGas',
  ]
  const common = new Common({ chain: TronMainnet, params: paramsTVM })
  for (const key of removed) {
    for (const group of Object.values(paramsTVM)) assert.notProperty(group, key)
    assert.throws(() => common.param(key), /Missing parameter/)
  }
  assert.strictEqual(common.param('sstoreSetGas'), 20000n)
  assert.strictEqual(common.param('sstoreResetGas'), 5000n)
  assert.strictEqual(common.param('bn254MulGas'), 6000n)
  assert.strictEqual(paramsTVM[2929].coldaccountaccessGas, 2600)
  assert.strictEqual(paramsTVM[2929].warmstoragereadGas, 100)
  const tvm = await createTVM({
    common: new Common({
      chain: TronMainnet,
      params: { tron: Object.fromEntries(removed.map((key) => [key, 1])) },
    }),
  })
  const result = await tvm.runCall({
    to: factory,
    code: hexToBytes('0x60016000556000600055'),
    gasLimit: 50000n,
  })
  assert.isUndefined(result.execResult.exceptionError)
  assert.strictEqual(result.execResult.executionGasUsed, 25012n)
  assert.strictEqual(result.execResult.gasRefund, 0n)
})
