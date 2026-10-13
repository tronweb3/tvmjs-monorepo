import { createAccount, createAddressFromString, tokenIdToKey } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { MerkleStateManager, SimpleStateManager } from '../src/index.ts'

const address = createAddressFromString(`0x${'33'.repeat(20)}`)
const TOKEN = 2n ** 53n + 1n

function tokenAccount() {
  return createAccount({ asset: { [tokenIdToKey(TOKEN)]: 1n } })
}

for (const StateManager of [MerkleStateManager, SimpleStateManager]) {
  describe(`${StateManager.name} token registry with nested checkpoints`, () => {
    it('discards registrations committed inside a reverted outer checkpoint', async () => {
      const sm = new StateManager()
      await sm.checkpoint()
      await sm.checkpoint()
      await sm.putAccount(address, tokenAccount())
      await sm.commit()
      assert.isTrue(await sm.tokenIdExists(TOKEN))

      await sm.revert()
      assert.isUndefined(await sm.getAccount(address))
      assert.isFalse(await sm.tokenIdExists(TOKEN))
    })

    it('discards registrations reverted inside a committed outer checkpoint', async () => {
      const sm = new StateManager()
      await sm.checkpoint()
      await sm.checkpoint()
      await sm.putAccount(address, tokenAccount())
      await sm.revert()
      await sm.commit()
      assert.isFalse(await sm.tokenIdExists(TOKEN))
    })

    it('keeps registrations once the outermost checkpoint commits', async () => {
      const sm = new StateManager()
      await sm.checkpoint()
      await sm.checkpoint()
      await sm.putAccount(address, tokenAccount())
      await sm.commit()
      assert.isTrue(await sm.tokenIdExists(TOKEN))
      await sm.commit()
      assert.isTrue(await sm.tokenIdExists(TOKEN))

      await sm.checkpoint()
      await sm.revert()
      assert.isTrue(await sm.tokenIdExists(TOKEN))
      assert.strictEqual((await sm.getAccount(address))!.getTokenBalance(TOKEN), 1n)
    })
  })
}
