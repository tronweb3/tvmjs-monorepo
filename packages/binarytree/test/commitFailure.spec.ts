import { MapDB } from '@tvmjs/util'
import { assert, afterEach, describe, expect, it, vi } from 'vitest'

import { createBinaryTree } from '../src/index.ts'

afterEach(() => vi.restoreAllMocks())

describe.each([0, 100])('BinaryTree final commit failure (cacheSize: %s)', (cacheSize) => {
  describe.each([false, true])('root persistence: %s', (useRootPersistence) => {
    it.each(['commit', 'revert'] as const)(
      'keeps the tree readable and allows %s',
      async (recovery) => {
        const db = new MapDB<string, string | Uint8Array>()
        const tree = await createBinaryTree({ db, cacheSize, useRootPersistence })
        const stem = new Uint8Array(31).fill(1)
        const original = new Uint8Array(32).fill(1)
        const updated = new Uint8Array(32).fill(2)
        await tree.put(stem, [0, 1], [original, original])
        const oldRoot = tree.root().slice()
        const stored = new Map(db._database)

        tree.checkpoint()
        await tree.put(stem, [0], [updated])
        tree.checkpoint()
        await tree.del(stem, [1])
        await tree.put(stem, [2], [updated])
        await tree.commit()
        const newRoot = tree.root().slice()
        assert.notDeepEqual(newRoot, oldRoot)
        const failure = new Error('Injected batch failure before any writes')
        vi.spyOn(db, 'batch').mockRejectedValueOnce(failure)

        await expect(tree.commit()).rejects.toBe(failure)

        assert.isTrue(tree.hasCheckpoints())
        assert.deepEqual(tree.root(), newRoot)
        assert.deepEqual(await tree.get(stem, [0, 1, 2]), [updated, null, updated])
        assert.deepEqual(db._database, stored)
        const committed = await createBinaryTree({ db, root: oldRoot })
        assert.deepEqual(await committed.get(stem, [0, 1, 2]), [original, original, null])
        if (useRootPersistence) {
          const reopened = await createBinaryTree({ db, useRootPersistence })
          assert.deepEqual(reopened.root(), oldRoot)
          assert.deepEqual(await reopened.get(stem, [0, 1, 2]), [original, original, null])
        }

        await tree[recovery]()
        const expectedRoot = recovery === 'commit' ? newRoot : oldRoot
        assert.isFalse(tree.hasCheckpoints())
        assert.deepEqual(tree.root(), expectedRoot)
        const reopened = await createBinaryTree({
          db,
          useRootPersistence,
          root: useRootPersistence ? undefined : expectedRoot,
        })
        for (const view of [tree, reopened]) {
          assert.deepEqual(view.root(), expectedRoot)
          assert.deepEqual(
            await view.get(stem, [0, 1, 2]),
            recovery === 'commit' ? [updated, null, updated] : [original, original, null],
          )
        }
      },
    )
  })
})
