import { createAccount, createAddressFromString } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { SimpleStateManager } from '../src/index.ts'

describe('SimpleStateManager TRC-10 snapshots', () => {
  it('isolates copied token balances through independent commit and revert', async () => {
    const address = createAddressFromString(`0x${'11'.repeat(20)}`)
    const original = new SimpleStateManager()
    await original.putAccount(address, createAccount({ asset: { 1000001: 100n } }))
    await original.checkpoint()
    const copy = original.shallowCopy()
    const copiedAccount = (await copy.getAccount(address))!
    copiedAccount.asset![1000001] = 99n
    await copy.putAccount(address, copiedAccount)
    await copy.commit()

    assert.strictEqual((await original.getAccount(address))!.getTokenBalance(1000001n), 100n)
    const originalAccount = (await original.getAccount(address))!
    originalAccount.asset![1000001] = 98n
    await original.putAccount(address, originalAccount)
    await original.revert()
    assert.strictEqual((await original.getAccount(address))!.getTokenBalance(1000001n), 100n)
    assert.strictEqual((await copy.getAccount(address))!.getTokenBalance(1000001n), 99n)
  })
})
