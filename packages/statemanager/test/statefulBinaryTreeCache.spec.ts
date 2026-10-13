import { createBinaryTree } from '@tvmjs/binarytree'
import { Account, Address, bytesToBigInt, setLengthLeft } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { CacheType } from '../src/cache/types.ts'
import { Caches, StatefulBinaryTreeStateManager } from '../src/index.ts'

describe.each([CacheType.ORDERED_MAP, CacheType.LRU])(
  'Binary Tree StateManager cache persistence (%s)',
  (type) => {
    const address = new Address(new Uint8Array(20).fill(1))
    const slot = setLengthLeft(new Uint8Array([7]), 32)
    const value = setLengthLeft(new Uint8Array([42]), 32)

    const createState = async () => {
      const tree = await createBinaryTree()
      const caches = new Caches({
        account: { type, size: 32 },
        storage: { type, size: 32 },
        code: { type, size: 32 },
      })
      const state = new StatefulBinaryTreeStateManager({ tree, caches })
      return { tree, state, caches }
    }

    it.each([false, true])('persists a committed account (existing: %s)', async (existing) => {
      const { tree, state } = await createState()
      if (existing) {
        const initial = new StatefulBinaryTreeStateManager({ tree })
        await initial.putAccount(address, new Account(0n, 1n))
      }
      const originalRoot = tree.root().slice()

      await state.checkpoint()
      await state.putAccount(address, new Account(0n, 100n))
      assert.strictEqual((await state.getAccount(address))?.balance, 100n)
      await state.commit()

      assert.notDeepEqual(await state.getStateRoot(), originalRoot)
      state.clearCaches()
      assert.strictEqual((await state.getAccount(address))?.balance, 100n)
      const reader = new StatefulBinaryTreeStateManager({ tree: tree.shallowCopy(false) })
      assert.strictEqual((await reader.getAccount(address))?.balance, 100n)
    })

    it('persists storage and its new account together', async () => {
      const { tree, state } = await createState()
      const originalRoot = tree.root().slice()
      await state.checkpoint()
      await state.putAccount(address, new Account(0n, 100n))
      await state.putStorage(address, slot, value)
      assert.strictEqual(bytesToBigInt(await state.getStorage(address, slot)), 42n)
      await state.commit()

      assert.notDeepEqual(await state.getStateRoot(), originalRoot)
      state.clearCaches()
      assert.strictEqual((await state.getAccount(address))?.balance, 100n)
      assert.deepEqual(await state.getStorage(address, slot), value)
      assert.deepEqual(await state.getStorage(address, slot), value)
      const reader = new StatefulBinaryTreeStateManager({ tree: tree.shallowCopy(false) })
      assert.deepEqual(await reader.getStorage(address, slot), value)
    })

    it('keeps a committed account deletion after clearing caches', async () => {
      const { tree, state } = await createState()
      const initial = new StatefulBinaryTreeStateManager({ tree })
      await initial.putAccount(address, new Account(0n, 100n))
      const originalRoot = tree.root().slice()

      await state.checkpoint()
      await state.deleteAccount(address)
      assert.isUndefined(await state.getAccount(address))
      await state.commit()

      assert.notDeepEqual(await state.getStateRoot(), originalRoot)
      state.clearCaches()
      assert.isUndefined(await state.getAccount(address))
      const reader = new StatefulBinaryTreeStateManager({ tree: tree.shallowCopy(false) })
      assert.isUndefined(await reader.getAccount(address))
    })

    it('persists an explicit empty storage value', async () => {
      const { tree, state } = await createState()
      const initial = new StatefulBinaryTreeStateManager({ tree })
      await initial.putAccount(address, new Account(0n, 100n))
      await initial.putStorage(address, slot, value)
      const originalRoot = tree.root().slice()

      await state.checkpoint()
      await state.putStorage(address, slot, new Uint8Array())
      await state.commit()

      assert.notDeepEqual(await state.getStateRoot(), originalRoot)
      state.clearCaches()
      assert.strictEqual(bytesToBigInt(await state.getStorage(address, slot)), 0n)
      assert.strictEqual((await state.getAccount(address))?.balance, 100n)
    })

    it('flushes account, code and storage without requiring a checkpoint', async () => {
      const { tree, state, caches } = await createState()
      const code = new Uint8Array([0x60, 0x01, 0x00])
      await state.putAccount(address, new Account(0n, 100n))
      await state.putCode(address, code)
      await state.putStorage(address, slot, value)
      await state.flush()

      // A completed flush must not queue its own writes for another flush.
      assert.deepEqual(caches.account!.flush(), [])
      assert.deepEqual(caches.storage!.flush(), [])
      assert.deepEqual(caches.code!.flush(), [])
      state.clearCaches()
      assert.strictEqual((await state.getAccount(address))?.balance, 100n)
      assert.deepEqual(await state.getCode(address), code)
      assert.deepEqual(await state.getStorage(address, slot), value)
      const reader = new StatefulBinaryTreeStateManager({ tree: tree.shallowCopy(false) })
      assert.deepEqual(await reader.getCode(address), code)
    })

    it('discards an inner commit when the outer checkpoint is reverted', async () => {
      const { tree, state } = await createState()
      const originalRoot = tree.root().slice()
      await state.checkpoint()
      await state.putAccount(address, new Account(0n, 100n))
      await state.putStorage(address, slot, value)
      await state.checkpoint()
      await state.modifyAccountFields(address, { balance: 200n })
      await state.putStorage(address, slot, new Uint8Array([99]))
      await state.commit()
      await state.revert()

      assert.deepEqual(await state.getStateRoot(), originalRoot)
      state.clearCaches()
      assert.isUndefined(await state.getAccount(address))
      assert.strictEqual(bytesToBigInt(await state.getStorage(address, slot)), 0n)
    })

    it('does not change an empty tree when flushing a cached missing account', async () => {
      const { tree, state } = await createState()
      const originalRoot = tree.root().slice()
      assert.isUndefined(await state.getAccount(address))
      await state.flush()
      assert.deepEqual(await state.getStateRoot(), originalRoot)
      state.clearCaches()
      assert.isUndefined(await state.getAccount(address))
    })

    it('preserves stored values when reverting an account deletion after cached reads', async () => {
      const { tree, state } = await createState()
      const initial = new StatefulBinaryTreeStateManager({ tree })
      await initial.putAccount(address, new Account(0n, 100n))
      await initial.putStorage(address, slot, value)
      const originalRoot = tree.root().slice()
      assert.deepEqual(await state.getStorage(address, slot), value)

      await state.checkpoint()
      await state.deleteAccount(address)
      await state.revert()

      assert.deepEqual(await state.getStateRoot(), originalRoot)
      state.clearCaches()
      assert.strictEqual((await state.getAccount(address))?.balance, 100n)
      assert.deepEqual(await state.getStorage(address, slot), value)
    })
  },
)
