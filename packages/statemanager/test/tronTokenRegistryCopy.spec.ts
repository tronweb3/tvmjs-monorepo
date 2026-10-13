import { createAccount, createAddressFromString, tokenIdToKey } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { Caches, MerkleStateManager, SimpleStateManager } from '../src/index.ts'

const owner = createAddressFromString(`0x${'11'.repeat(20)}`)
const other = createAddressFromString(`0x${'22'.repeat(20)}`)
const KNOWN = 2n ** 53n
const PENDING = KNOWN + 1n
const COPIED = 2n ** 63n - 1n
const accountWith = (id: bigint) => createAccount({ asset: { [tokenIdToKey(id)]: 5n } })

for (const cached of [false, true]) {
  describe(`Merkle token registry copies, account cache=${cached}`, () => {
    const createState = () => new MerkleStateManager({ caches: cached ? new Caches() : undefined })

    it.each([false, true])(
      'copies committed IDs independently, downlevelCaches=%s',
      async (downlevel) => {
        const state = createState()
        await state.checkpoint()
        await state.putAccount(owner, accountWith(KNOWN))
        await state.commit()
        const copy = state.shallowCopy(downlevel)
        assert.isTrue(await copy.tokenIdExists(KNOWN))
        assert.strictEqual((await copy.getAccount(owner))!.getTokenBalance(KNOWN), 5n)
        assert.isFalse(await copy.tokenIdExists(PENDING))

        await copy.checkpoint()
        await copy.putAccount(other, accountWith(COPIED))
        await copy.commit()
        assert.isTrue(await copy.tokenIdExists(COPIED))
        assert.isFalse(await state.tokenIdExists(COPIED))
        assert.isUndefined(await state.getAccount(other))

        await state.checkpoint()
        await state.putAccount(other, accountWith(PENDING))
        await state.commit()
        assert.isTrue(await state.tokenIdExists(PENDING))
        assert.isFalse(await copy.tokenIdExists(PENDING))
        assert.strictEqual((await copy.getAccount(other))!.getTokenBalance(COPIED), 5n)
      },
    )

    it('copies the outermost snapshot after an inner commit, including its trie root', async () => {
      const state = createState()
      // Explicitly flushed writes outside a checkpoint must also survive copying.
      await state.putAccount(owner, accountWith(KNOWN))
      await state.flush()
      await state.checkpoint()
      await state.checkpoint()
      await state.putAccount(owner, accountWith(PENDING))
      await state.commit()
      // Move pending cache writes into checkpoint scratch, without committing the outer frame.
      await state.flush()

      const copy = state.shallowCopy()
      assert.isTrue(await copy.tokenIdExists(KNOWN))
      assert.isFalse(await copy.tokenIdExists(PENDING))
      const account = (await copy.getAccount(owner))!
      assert.strictEqual(account.getTokenBalance(KNOWN), 5n)
      assert.strictEqual(account.getTokenBalance(PENDING), 0n)

      await copy.checkpoint()
      await copy.putAccount(other, accountWith(COPIED))
      await copy.revert()
      assert.isFalse(await copy.tokenIdExists(COPIED))
      assert.isTrue(await copy.tokenIdExists(KNOWN))
      await state.revert()
      assert.isFalse(await state.tokenIdExists(PENDING))
      assert.isTrue(await state.tokenIdExists(KNOWN))
    })

    it('copies flushed registrations without requiring a checkpoint commit', async () => {
      const state = createState()
      await state.putAccount(owner, accountWith(KNOWN))
      await state.flush()
      const copy = state.shallowCopy()
      assert.isTrue(await copy.tokenIdExists(KNOWN))
      assert.strictEqual((await copy.getAccount(owner))!.getTokenBalance(KNOWN), 5n)
      await copy.checkpoint()
      await copy.putAccount(other, accountWith(PENDING))
      await copy.revert()
      assert.isFalse(await copy.tokenIdExists(PENDING))
      assert.isTrue(await copy.tokenIdExists(KNOWN))
    })
  })
}

describe('Simple token registry snapshots', () => {
  it('copies current registrations and nested checkpoints without sharing changes', async () => {
    const state = new SimpleStateManager()
    await state.putAccount(owner, accountWith(KNOWN))
    await state.checkpoint()
    await state.checkpoint()
    await state.putAccount(other, accountWith(PENDING))
    await state.commit()
    const copy = state.shallowCopy()
    assert.isTrue(await copy.tokenIdExists(KNOWN))
    assert.isTrue(await copy.tokenIdExists(PENDING))
    assert.strictEqual((await copy.getAccount(other))!.getTokenBalance(PENDING), 5n)

    await copy.putAccount(other, accountWith(COPIED))
    assert.isFalse(await state.tokenIdExists(COPIED))
    await copy.commit()
    await state.revert()
    assert.isFalse(await state.tokenIdExists(PENDING))
    assert.isTrue(await copy.tokenIdExists(PENDING))
    assert.isTrue(await copy.tokenIdExists(COPIED))

    await copy.checkpoint()
    await copy.putAccount(other, accountWith(COPIED - 1n))
    await copy.revert()
    assert.isFalse(await copy.tokenIdExists(COPIED - 1n))
    assert.isTrue(await copy.tokenIdExists(COPIED))
  })

  it('keeps known IDs when a balance reaches zero or a holder is deleted', async () => {
    const state = new SimpleStateManager()
    await state.putAccount(owner, accountWith(KNOWN))
    await state.putAccount(owner, createAccount({ asset: { [tokenIdToKey(KNOWN)]: 0n } }))
    await state.deleteAccount(owner)
    assert.isTrue(await state.tokenIdExists(KNOWN))
    assert.isFalse(await state.tokenIdExists(PENDING))
  })
})
