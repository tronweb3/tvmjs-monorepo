import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { createTVM } from '@tvmjs/tvm'
import { TransactionType, createTx } from '@tvmjs/tx'
import {
  Account,
  Address,
  generateTronContractAddress,
  hexToBytes,
  privateToAddress,
} from '@tvmjs/util'
import { describe, expect, it } from 'vitest'

import { createVM, runTx } from '../../../src/index.ts'

const privateKey = hexToBytes(`0x${'20'.repeat(32)}`)
const sender = new Address(privateToAddress(privateKey))
const balance = 10n ** 18n
const rootTransactionId = hexToBytes(
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
)

const vectors = [
  {
    name: '49153-byte initcode',
    data: new Uint8Array(49153),
    budget: 100000n,
    energy: 0n,
    codeSize: 0,
    error: undefined,
    returnSize: 0,
  },
  {
    name: '24577-byte runtime',
    data: hexToBytes('0x6160016000f3'),
    budget: 4918868n,
    energy: 4918868n,
    codeSize: 24577,
    error: undefined,
    returnSize: 24577,
  },
  {
    name: 'code deposit Energy shortage',
    data: hexToBytes('0x6160016000f3'),
    budget: 4918867n,
    energy: 4918867n,
    codeSize: 0,
    error: 'out of gas',
    returnSize: 0,
  },
  {
    name: 'large REVERT data',
    data: hexToBytes('0x6160016000fd'),
    budget: 100000n,
    energy: 3468n,
    codeSize: 0,
    error: 'revert',
    returnSize: 24577,
  },
  {
    name: 'EF-prefixed runtime',
    data: hexToBytes('0x60ef60005360016000f3'),
    budget: 100000n,
    energy: 100000n,
    codeSize: 0,
    error: 'invalid bytecode deployed',
    returnSize: 0,
  },
]

describe.each([TronMainnet, TronNile, TronShasta])('VM/TVM deployment limits on $name', (chain) => {
  describe.each([
    TransactionType.Legacy,
    TransactionType.AccessListEIP2930,
    TransactionType.FeeMarketEIP1559,
  ])('transaction type %s', (type) => {
    it.each(vectors)('preserves Energy, state and receipts for $name', async (vector) => {
      const common = new Common({ chain })
      const vm = await createVM({ common })
      const tvm = await createTVM({ common: new Common({ chain }) })
      for (const state of [vm.stateManager, tvm.stateManager]) {
        await state.putAccount(sender, new Account(0n, balance))
      }
      const txData = {
        type,
        data: vector.data,
        value: 7n,
        ...(type === TransactionType.FeeMarketEIP1559
          ? { maxFeePerGas: 10n, maxPriorityFeePerGas: 0n }
          : { gasPrice: 10n }),
      }
      const intrinsic = createTx(txData, { common }).getIntrinsicGas()
      const tx = createTx({ ...txData, gasLimit: intrinsic + vector.budget }, { common }).sign(
        privateKey,
      )
      const result = await runTx(vm, { tx, rootTransactionId })
      const direct = await tvm.runCall({
        caller: sender,
        data: tx.data,
        value: tx.value,
        gasLimit: vector.budget,
        rootTransactionId,
      })
      for (const execution of [result, direct]) {
        expect(execution.execResult.exceptionError?.error).toBe(vector.error)
        expect(execution.execResult.executionGasUsed).toBe(vector.energy)
        expect(execution.execResult.returnValue).toHaveLength(vector.returnSize)
        expect(execution.createdAddress?.bytes).toEqual(
          generateTronContractAddress(rootTransactionId, sender.bytes),
        )
      }
      expect(result.execResult.returnValue).toEqual(direct.execResult.returnValue)
      expect(result.totalGasSpent).toBe(intrinsic + vector.energy)
      expect(result.gasRefund).toBe(0n)
      expect(result.receipt).toMatchObject({
        status: vector.error === undefined ? 1 : 0,
        cumulativeBlockGasUsed: result.totalGasSpent,
      })
      for (const state of [vm.stateManager, tvm.stateManager]) {
        const account = await state.getAccount(result.createdAddress!)
        if (vector.error === undefined) {
          expect(account?.nonce).toBe(1n)
          expect(account?.balance).toBe(7n)
          expect(await state.getCode(result.createdAddress!)).toEqual(
            new Uint8Array(vector.codeSize),
          )
        } else {
          expect(account).toBeUndefined()
        }
        expect((await state.getAccount(sender))?.nonce).toBe(1n)
      }
      const transferred = vector.error === undefined ? 7n : 0n
      expect((await tvm.stateManager.getAccount(sender))?.balance).toBe(balance - transferred)
      expect((await vm.stateManager.getAccount(sender))?.balance).toBe(
        balance - transferred - result.amountSpent,
      )
    })
  })
})
