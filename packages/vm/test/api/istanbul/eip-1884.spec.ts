import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { Account, bytesToBigInt, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/index.ts'

describe.each([TronMainnet, TronNile, TronShasta])('SELFBALANCE on $name', (chain) => {
  it.each([0n, 0x123456789abcdefn])('returns the full balance %s', async (balance) => {
    const vm = await createVM({ common: new Common({ chain, activatedProposals: [] }) })
    const to = createAddressFromString('0x' + '21'.repeat(20))
    await vm.stateManager.putAccount(to, new Account(0n, balance))
    const result = await vm.tvm.runCode({
      to,
      code: hexToBytes('0x4760005260206000f3'),
      gasLimit: 100n,
    })
    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.returnValue.length, 32)
    assert.strictEqual(bytesToBigInt(result.returnValue), balance)
    assert.strictEqual(result.executionGasUsed, 17n)
  })
})
