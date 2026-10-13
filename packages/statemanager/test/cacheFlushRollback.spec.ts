import { MerklePatriciaTrie } from '@tvmjs/mpt'
import { Account, Address, bytesToHex } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { CacheType, Caches, MerkleStateManager } from '../src/index.ts'

const address = new Address(new Uint8Array(20).fill(1))
const otherAddress = new Address(new Uint8Array(20).fill(2))
const slot = new Uint8Array(32)

async function writeState(state: MerkleStateManager, value: number, target = address) {
  if ((await state.getAccount(target)) === undefined) {
    await state.putAccount(target, new Account())
  }
  await state.modifyAccountFields(target, { nonce: BigInt(value - 1), balance: BigInt(value) })
  await state.putCode(target, Uint8Array.of(0x60, value, 0))
  await state.putStorage(target, slot, Uint8Array.of(value))
}

async function readState(state: MerkleStateManager, target = address) {
  const account = await state.getAccount(target)
  return {
    account: account === undefined ? undefined : bytesToHex(account.serialize()),
    code: bytesToHex(await state.getCode(target)),
    storage: bytesToHex(await state.getStorage(target, slot)),
  }
}

describe.each([CacheType.ORDERED_MAP, CacheType.LRU])(
  'Merkle StateManager cache flush rollback (%s)',
  (type) => {
    async function setup(size = 100) {
      const trie = new MerklePatriciaTrie({ useKeyHashing: true })
      const caches = new Caches({
        account: { type, size },
        code: { type, size },
        storage: { type, size },
      })
      const state = new MerkleStateManager({ trie, caches })
      await writeState(state, 1)
      const root = await state.getStateRoot()
      const initial = await readState(state)
      return { state, trie, caches, root, initial }
    }

    it.each(['account', 'code', 'storage'] as const)(
      'restores %s after getting the state root inside a checkpoint',
      async (kind) => {
        const { state, trie, root, initial } = await setup()
        await state.checkpoint()
        if (kind === 'account') {
          await state.modifyAccountFields(address, { balance: 2n, nonce: 1n })
        } else if (kind === 'code') {
          await state.putCode(address, Uint8Array.of(0x60, 2, 0))
        } else {
          await state.putStorage(address, slot, Uint8Array.of(2))
        }
        assert.notDeepEqual(await state.getStateRoot(), root)
        await state.revert()

        assert.deepEqual(trie.root(), root)
        assert.deepEqual(await readState(state), initial)
        assert.deepEqual(await readState(new MerkleStateManager({ trie })), initial)
        assert.deepEqual(await state.getStateRoot(), root)
      },
    )

    it('removes entries first loaded during a checkpoint even after an explicit flush', async () => {
      const { state, root, initial } = await setup()
      state.clearCaches()
      await state.checkpoint()
      await writeState(state, 2)
      await state.flush()
      await state.revert()

      assert.deepEqual(await readState(state), initial)
      assert.deepEqual(await state.getStateRoot(), root)
    })

    it.each(['create', 'delete'] as const)(
      'reverts an account %s together with code and storage after flushing',
      async (operation) => {
        const { state, root } = await setup()
        const target = operation === 'create' ? otherAddress : address
        const initial = await readState(state, target)
        await state.checkpoint()
        if (operation === 'create') {
          await writeState(state, 2, target)
        } else {
          await state.deleteAccount(target)
        }
        assert.notDeepEqual(await state.getStateRoot(), root)
        await state.revert()

        assert.deepEqual(await readState(state, target), initial)
        assert.deepEqual(await state.getStateRoot(), root)
        state.clearCaches()
        assert.deepEqual(await readState(state, target), initial)
      },
    )

    it('flushes only pending writes while retaining the original rollback values', async () => {
      const { state, caches, root, initial } = await setup()
      await state.checkpoint()
      await writeState(state, 2)
      await state.flush()

      assert.deepEqual(caches.account!.flush(), [])
      assert.deepEqual(caches.code!.flush(), [])
      assert.deepEqual(caches.storage!.flush(), [])

      await writeState(state, 3)
      await state.flush()
      await state.revert()
      assert.deepEqual(await readState(state), initial)
      assert.deepEqual(await state.getStateRoot(), root)
    })

    it.each(['commit', 'revert'] as const)(
      'retains the outer rollback state after an inner flush and %s',
      async (operation) => {
        const { state, root, initial } = await setup()
        await state.checkpoint()
        await writeState(state, 2)
        const outerRoot = await state.getStateRoot()
        const outerState = await readState(state)
        await state.checkpoint()
        await writeState(state, 3)
        const innerRoot = await state.getStateRoot()
        const innerState = await readState(state)
        await state[operation]()

        assert.deepEqual(await readState(state), operation === 'commit' ? innerState : outerState)
        assert.deepEqual(await state.getStateRoot(), operation === 'commit' ? innerRoot : outerRoot)
        await state.revert()
        assert.deepEqual(await readState(state), initial)
        assert.deepEqual(await state.getStateRoot(), root)
      },
    )

    it('flushes pending outer writes and restores their pending status on an inner revert', async () => {
      const { state, trie, root, initial } = await setup()
      await state.checkpoint()
      await writeState(state, 2)
      await state.checkpoint()
      const flushedRoot = await state.getStateRoot()
      const outerState = await readState(state)
      assert.deepEqual(await readState(new MerkleStateManager({ trie })), outerState)

      await state.revert()
      assert.deepEqual(await state.getStateRoot(), flushedRoot)
      assert.deepEqual(await readState(state), outerState)
      assert.deepEqual(await readState(new MerkleStateManager({ trie })), outerState)
      await state.revert()
      assert.deepEqual(await readState(state), initial)
      assert.deepEqual(await state.getStateRoot(), root)
    })

    it.each(['account', 'code', 'storage'] as const)(
      'restores a flushed outer %s write even if its cached entry was evicted',
      async (kind) => {
        const { state, trie, initial } = await setup(2)
        const thirdAddress = new Address(new Uint8Array(20).fill(3))
        const writer = new MerkleStateManager({ trie })
        await writeState(writer, 3, otherAddress)
        await writeState(writer, 4, thirdAddress)
        const root = await state.getStateRoot()

        await state.checkpoint()
        if (kind === 'account') {
          await state.modifyAccountFields(address, { balance: 2n, nonce: 1n })
        } else if (kind === 'code') {
          await state.putCode(address, Uint8Array.of(0x60, 2, 0))
        } else {
          await state.putStorage(address, slot, Uint8Array.of(2))
        }
        const pending = await readState(state)
        await state.checkpoint()
        await state.flush()
        for (const target of [otherAddress, thirdAddress]) {
          await readState(state, target)
          // Flush each read before loading another entry, so no pending write is evicted.
          await state.flush()
        }
        await state.revert()

        assert.deepEqual(await readState(state), pending)
        await state.flush()
        assert.deepEqual(await readState(new MerkleStateManager({ trie })), await readState(state))
        await state.revert()
        assert.deepEqual(await readState(state), initial)
        assert.deepEqual(await state.getStateRoot(), root)
      },
    )

    it.each(['deleteAccount', 'clearStorage'] as const)(
      'keeps pending outer storage after an inner %s, flush and revert',
      async (operation) => {
        const { state, trie, root, initial } = await setup()
        await state.checkpoint()
        await writeState(state, 2)
        const outerState = await readState(state)
        await state.checkpoint()
        await state[operation](address)
        await state.flush()
        await state.revert()

        // Storage roots in cached accounts are updated by the next flush.
        assert.deepEqual(await readState(state), outerState)
        await state.flush()
        assert.deepEqual(await readState(new MerkleStateManager({ trie })), await readState(state))
        await state.revert()
        assert.deepEqual(await readState(state), initial)
        assert.deepEqual(await state.getStateRoot(), root)
      },
    )

    it('persists a flushed commit and starts the next checkpoint with independent history', async () => {
      const { state } = await setup()
      await state.checkpoint()
      await writeState(state, 2)
      const root = await state.getStateRoot()
      const committed = await readState(state)
      await state.commit()
      state.clearCaches()
      assert.deepEqual(await readState(state), committed)
      assert.deepEqual(await state.getStateRoot(), root)

      await state.checkpoint()
      await writeState(state, 3)
      await state.flush()
      await state.revert()
      assert.deepEqual(await readState(state), committed)
      assert.deepEqual(await state.getStateRoot(), root)
    })
  },
)
