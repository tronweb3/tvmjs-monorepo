import { MerklePatriciaTrie } from '@tvmjs/mpt'
import { Account, Address, bytesToBigInt } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { CacheType, Caches, MerkleStateManager } from '../src/index.ts'

const address = new Address(new Uint8Array(20).fill(1))
const otherAddress = new Address(new Uint8Array(20).fill(2))
const oldSlot = new Uint8Array(32)
oldSlot[31] = 1
const newSlot = new Uint8Array(32)
const oldCode = Uint8Array.of(0x60, 1, 0)

describe.each([undefined, CacheType.ORDERED_MAP, CacheType.LRU])(
  'Merkle account storage lifecycle with cache type %s',
  (type) => {
    describe.each([false, true])('storage key prefixes enabled: %s', (prefixStorageTrieKeys) => {
      async function seedOtherAccount(state: MerkleStateManager) {
        await state.putAccount(otherAddress, new Account(0n, 6n))
        await state.putStorage(otherAddress, oldSlot, Uint8Array.of(6))
      }

      async function setup(persist = true) {
        const trie = new MerklePatriciaTrie({ useKeyHashing: true })
        const caches =
          type === undefined
            ? undefined
            : new Caches({ account: { type }, code: { type }, storage: { type } })
        const state = new MerkleStateManager({ trie, caches, prefixStorageTrieKeys })
        await state.putAccount(address, new Account(0n, 5n))
        await state.putCode(address, oldCode)
        await state.putStorage(address, oldSlot, Uint8Array.of(5))
        await seedOtherAccount(state)
        if (persist) await state.flush()
        return { state, trie }
      }

      async function freshRoot(withNewStorage = false) {
        const state = new MerkleStateManager({ prefixStorageTrieKeys })
        await seedOtherAccount(state)
        await state.putAccount(address, new Account(0n, 11n))
        if (withNewStorage) {
          await state.putStorage(address, newSlot, Uint8Array.of(9))
        }
        return state.getStateRoot()
      }

      it.each([false, true])(
        'does not read storage from a deleted account after recreation (persisted: %s)',
        async (persist) => {
          const { state } = await setup(persist)
          await state.deleteAccount(address)
          await state.putAccount(address, new Account(0n, 11n))

          assert.strictEqual(bytesToBigInt(await state.getStorage(address, oldSlot)), 0n)
          assert.deepEqual(await state.getCode(address), new Uint8Array())
          assert.strictEqual(bytesToBigInt(await state.getStorage(otherAddress, oldSlot)), 6n)
          assert.deepEqual(await state.getStateRoot(), await freshRoot())
        },
      )

      it('does not persist old slots when the recreated account writes new storage', async () => {
        const { state, trie } = await setup()
        await state.checkpoint()
        await state.deleteAccount(address)
        await state.putAccount(address, new Account(0n, 11n))
        await state.putStorage(address, newSlot, Uint8Array.of(9))
        await state.commit()

        assert.deepEqual(await state.getStateRoot(), await freshRoot(true))
        state.clearCaches()
        const reader = new MerkleStateManager({ trie, prefixStorageTrieKeys })
        for (const view of [state, reader]) {
          assert.strictEqual(bytesToBigInt(await view.getStorage(address, oldSlot)), 0n)
          assert.strictEqual(bytesToBigInt(await view.getStorage(address, newSlot)), 9n)
          assert.strictEqual((await view.getAccount(address))?.balance, 11n)
          assert.deepEqual(await view.getCode(address), new Uint8Array())
          assert.strictEqual(bytesToBigInt(await view.getStorage(otherAddress, oldSlot)), 6n)
        }
      })

      it('keeps the rebuilt state root unchanged across reads and an empty checkpoint revert', async () => {
        const { state } = await setup()
        await state.deleteAccount(address)
        await state.putAccount(address, new Account(0n, 11n))
        const expected = await freshRoot()
        assert.deepEqual(await state.getStateRoot(), expected)

        assert.strictEqual(bytesToBigInt(await state.getStorage(address, newSlot)), 0n)
        assert.deepEqual(await state.getStateRoot(), expected)
        await state.checkpoint()
        await state.revert()

        assert.deepEqual(await state.getStateRoot(), expected)
        assert.strictEqual(bytesToBigInt(await state.getStorage(address, oldSlot)), 0n)
      })

      it('restores the original account and storage when deletion and recreation are reverted', async () => {
        const { state, trie } = await setup()
        const root = await state.getStateRoot()
        await state.checkpoint()
        await state.checkpoint()
        await state.deleteAccount(address)
        await state.putAccount(address, new Account(0n, 11n))
        await state.putStorage(address, newSlot, Uint8Array.of(9))
        await state.flush()
        await state.commit()
        await state.revert()

        assert.deepEqual(await state.getStateRoot(), root)
        const reader = new MerkleStateManager({ trie, prefixStorageTrieKeys })
        for (const view of [state, reader]) {
          assert.strictEqual((await view.getAccount(address))?.balance, 5n)
          assert.deepEqual(await view.getCode(address), oldCode)
          assert.strictEqual(bytesToBigInt(await view.getStorage(address, oldSlot)), 5n)
          assert.strictEqual(bytesToBigInt(await view.getStorage(address, newSlot)), 0n)
          assert.strictEqual(bytesToBigInt(await view.getStorage(otherAddress, oldSlot)), 6n)
        }
      })
    })
  },
)
