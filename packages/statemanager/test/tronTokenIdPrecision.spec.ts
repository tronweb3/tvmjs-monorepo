import { createAccount, createAddressFromString, tokenIdToKey } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { MerkleStateManager, SimpleStateManager } from '../src/index.ts'

const address = createAddressFromString(`0x${'22'.repeat(20)}`)
const LOW = 2n ** 53n
const HIGH = LOW + 1n
const MAX = 2n ** 63n - 1n

for (const StateManager of [SimpleStateManager, MerkleStateManager]) {
  describe(`${StateManager.name} keeps adjacent high token IDs apart`, () => {
    it('stores, updates and reverts independent balances', async () => {
      const sm = new StateManager()
      await sm.putAccount(
        address,
        createAccount({
          asset: { [tokenIdToKey(LOW)]: 1n, [tokenIdToKey(HIGH)]: 2n, [tokenIdToKey(MAX)]: 3n },
        }),
      )
      await sm.checkpoint()
      const account = (await sm.getAccount(address))!
      assert.strictEqual(account.getTokenBalance(LOW), 1n)
      assert.strictEqual(account.getTokenBalance(HIGH), 2n)
      assert.strictEqual(account.getTokenBalance(MAX), 3n)
      assert.strictEqual(Object.keys(account.asset).length, 3)

      account.asset[tokenIdToKey(HIGH)] = 20n
      await sm.putAccount(address, account)
      const updated = (await sm.getAccount(address))!
      assert.strictEqual(updated.getTokenBalance(HIGH), 20n)
      assert.strictEqual(updated.getTokenBalance(LOW), 1n)

      await sm.revert()
      const reverted = (await sm.getAccount(address))!
      assert.strictEqual(reverted.getTokenBalance(HIGH), 2n)
      assert.strictEqual(reverted.getTokenBalance(LOW), 1n)
      assert.strictEqual(reverted.getTokenBalance(MAX), 3n)
    })
  })
}

for (const StateManager of [MerkleStateManager, SimpleStateManager]) {
  describe(`${StateManager.name} token registry`, () => {
    it('tracks token existence by exact ID through commit and revert', async () => {
      const sm = new StateManager()
      await sm.checkpoint()
      await sm.putAccount(address, createAccount({ asset: { [tokenIdToKey(HIGH)]: 5n } }))
      assert.isTrue(await sm.tokenIdExists(HIGH))
      assert.isFalse(await sm.tokenIdExists(LOW))
      await sm.revert()
      assert.isFalse(await sm.tokenIdExists(HIGH))

      await sm.checkpoint()
      await sm.putAccount(address, createAccount({ asset: { [tokenIdToKey(MAX)]: 5n } }))
      await sm.commit()
      assert.isTrue(await sm.tokenIdExists(MAX))
      assert.isFalse(await sm.tokenIdExists(MAX - 1n))
    })
  })
}

describe('MerkleStateManager token storage', () => {
  it('round-trips high IDs through the trie', async () => {
    const sm = new MerkleStateManager()
    await sm.putAccount(
      address,
      createAccount({ asset: { [tokenIdToKey(LOW)]: 1n, [tokenIdToKey(HIGH)]: 2n } }),
    )
    await sm.flush()
    sm.clearCaches()
    const account = (await sm.getAccount(address))!
    assert.strictEqual(account.getTokenBalance(LOW), 1n)
    assert.strictEqual(account.getTokenBalance(HIGH), 2n)
    assert.deepEqual(Object.keys(account.asset), [tokenIdToKey(LOW), tokenIdToKey(HIGH)])
  })
})
