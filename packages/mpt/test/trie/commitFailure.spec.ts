import { MapDB, utf8ToBytes } from '@tvmjs/util'
import { assert, afterEach, describe, expect, it, vi } from 'vitest'

import { MerklePatriciaTrie, createMPT } from '../../src/index.ts'

afterEach(() => vi.restoreAllMocks())

describe.each([0, 100])('MPT final commit failure (cacheSize: %s)', (cacheSize) => {
  describe.each([false, true])('root persistence: %s', (useRootPersistence) => {
    it.each(['commit', 'revert'] as const)(
      'keeps the trie readable and allows %s',
      async (recovery) => {
        const db = new MapDB<string, string | Uint8Array>()
        const trie = await createMPT({ db, cacheSize, useRootPersistence, useNodePruning: true })
        const key = utf8ToBytes('existing')
        const removed = utf8ToBytes('removed')
        const added = utf8ToBytes('added')
        const original = utf8ToBytes('original')
        const updated = utf8ToBytes('updated')
        await trie.put(key, original)
        await trie.put(removed, original)
        const oldRoot = trie.root().slice()
        const stored = new Map(db._database)

        trie.checkpoint()
        await trie.put(key, updated)
        await trie.del(removed)
        await trie.put(added, updated)
        const newRoot = trie.root().slice()
        assert.notDeepEqual(newRoot, oldRoot)
        const failure = new Error('Injected batch failure before any writes')
        vi.spyOn(db, 'batch').mockRejectedValueOnce(failure)

        await expect(trie.commit()).rejects.toBe(failure)

        assert.isTrue(trie.hasCheckpoints())
        assert.deepEqual(trie.root(), newRoot)
        assert.deepEqual(await trie.get(key), updated)
        assert.deepEqual(await trie.get(key, true), updated)
        assert.isNull(await trie.get(removed, true))
        assert.deepEqual(await trie.get(added, true), updated)
        assert.deepEqual(db._database, stored)

        // The failed batch has not pruned any of the previously committed nodes.
        const committed = new MerklePatriciaTrie({ db, root: oldRoot })
        assert.deepEqual(await committed.get(key, true), original)
        assert.deepEqual(await committed.get(removed, true), original)
        assert.isNull(await committed.get(added, true))
        if (useRootPersistence) {
          const reopened = await createMPT({ db, useRootPersistence })
          assert.deepEqual(reopened.root(), oldRoot)
          assert.deepEqual(await reopened.get(key, true), original)
        }

        await trie[recovery]()
        const expectedRoot = recovery === 'commit' ? newRoot : oldRoot
        assert.isFalse(trie.hasCheckpoints())
        assert.deepEqual(trie.root(), expectedRoot)
        const reopened = await createMPT({
          db,
          useRootPersistence,
          root: useRootPersistence ? undefined : expectedRoot,
        })
        for (const view of [trie, reopened]) {
          assert.deepEqual(view.root(), expectedRoot)
          assert.deepEqual(await view.get(key, true), recovery === 'commit' ? updated : original)
          assert.deepEqual(await view.get(removed, true), recovery === 'commit' ? null : original)
          assert.deepEqual(await view.get(added, true), recovery === 'commit' ? updated : null)
        }
      },
    )
  })
})
