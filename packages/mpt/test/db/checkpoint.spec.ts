import { MapDB, ValueEncoding, hexToBytes, utf8ToBytes } from '@tvmjs/util'
import { assert, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CheckpointDB } from '../../src/index.ts'

import type { BatchDBOp } from '@tvmjs/util'

afterEach(() => vi.restoreAllMocks())

describe('DB tests', () => {
  let db: CheckpointDB
  const k = utf8ToBytes('k1')
  const v = utf8ToBytes('v1')
  const v2 = utf8ToBytes('v2')
  const v3 = utf8ToBytes('v3')

  beforeEach(() => {
    // Set up a new CheckpointDB instance for each test
    db = new CheckpointDB({ db: new MapDB() })
  })

  it('should initialize with empty checkpoints', () => {
    assert.isEmpty(db.checkpoints)
  })

  it('should add a checkpoint', () => {
    db.checkpoint(new Uint8Array())
    assert.strictEqual(db.checkpoints.length, 1)
  })

  it('should commit the latest checkpoint', async () => {
    db.checkpoint(new Uint8Array())

    // Add some data to the latest checkpoint
    await db.put(hexToBytes('0x123'), hexToBytes('0x456'))

    await db.commit()

    // Ensure that the checkpoint is removed and the data is committed
    assert.isEmpty(db.checkpoints)
    assert.strictEqual(db._stats.db.writes, 1)
  })

  it('should revert the latest checkpoint', async () => {
    const expectedRoot = new Uint8Array()

    // Add a checkpoint
    db.checkpoint(expectedRoot)

    // Revert the checkpoint
    const actualRoot = await db.revert()

    // Ensure that the latest checkpoint is removed and the root is returned
    assert.isEmpty(db.checkpoints)
    assert.strictEqual(actualRoot, expectedRoot, 'roots should match')
  })

  it('should get a value', async () => {
    const key1 = hexToBytes('0x123')
    const val1 = hexToBytes('0x456')

    // Add some data
    await db.put(key1, val1)

    // Get the value
    const actualValue = await db.get(key1)

    // Ensure that the value is correct
    assert.deepEqual(actualValue, val1)
  })

  it('should put a value', async () => {
    const key1 = hexToBytes('0x123')
    const val1 = hexToBytes('0x456')

    // Put a value
    await db.put(key1, val1)

    // Get the value
    const actualValue = await db.get(key1)

    // Ensure that the value is correct
    assert.deepEqual(actualValue, val1)
  })

  it('should delete a value', async () => {
    const key1 = hexToBytes('0x123')
    const val1 = hexToBytes('0x456')

    // Add some data
    await db.put(key1, val1)

    // Delete the value
    await db.del(key1)

    // Ensure that the value is deleted
    const actualValue = await db.get(key1)
    assert(actualValue === undefined, 'deleted value should be undefined')
  })

  it('Checkpointing: revert -> put (add)', async () => {
    db.checkpoint(hexToBytes('0x01'))
    await db.put(k, v)
    assert.deepEqual(await db.get(k), v, 'before revert: v1')
    await db.revert()
    assert.deepEqual(await db.get(k), undefined, 'after revert: null')
  })

  it('Checkpointing: revert -> put (update)', async () => {
    await db.put(k, v)
    assert.deepEqual(await db.get(k), v, 'before CP: v1')
    db.checkpoint(hexToBytes('0x01'))
    await db.put(k, v2)
    await db.put(k, v3)
    await db.revert()
    assert.deepEqual(await db.get(k), v, 'after revert: v1')
  })

  it('Checkpointing: revert -> put (update) batched', async () => {
    await db.put(k, v)
    assert.deepEqual(await db.get(k), v, 'before CP: v1')
    db.checkpoint(hexToBytes('0x01'))
    const ops = [
      { type: 'put', key: k, value: v2 },
      { type: 'put', key: k, value: v3 },
    ] as BatchDBOp[]
    await db.batch(ops)
    await db.revert()
    assert.deepEqual(await db.get(k), v, 'after revert: v1')
  })

  it('Checkpointing: revert -> del', async () => {
    await db.put(k, v)
    assert.deepEqual(await db.get(k), v, 'before CP: v1')
    db.checkpoint(hexToBytes('0x01'))
    await db.del(k)
    assert.deepEqual(await db.get(k), undefined, 'before revert: undefined')
    await db.revert()
    assert.deepEqual(await db.get(k), v, 'after revert: v1')
  })

  it('Checkpointing: nested checkpoints -> commit -> revert', async () => {
    await db.put(k, v)

    assert.deepEqual(await db.get(k), v, 'before CP: v1')
    db.checkpoint(hexToBytes('0x01'))
    await db.put(k, v2)
    db.checkpoint(hexToBytes('0x02'))
    await db.put(k, v3)
    await db.commit()
    assert.deepEqual(await db.get(k), v3, 'after commit (second CP): v3')
    await db.revert()
    assert.deepEqual(await db.get(k), v, 'after revert (first CP): v1')
  })
})

describe('DB checkpoint cache coherency', () => {
  const key = utf8ToBytes('cached-key')
  const original = utf8ToBytes('original')
  const updated = utf8ToBytes('updated')
  let db: CheckpointDB

  beforeEach(async () => {
    db = new CheckpointDB({ db: new MapDB(), cacheSize: 100 })
    await db.put(key, original)
    assert.deepEqual(await db.get(key), original, 'prime the LRU cache')
  })

  it('prefers checkpointed puts and deletions over cached values, then restores on revert', async () => {
    db.checkpoint(hexToBytes('0x01'))

    await db.put(key, updated)
    assert.deepEqual(await db.get(key), updated, 'checkpointed put is visible')

    await db.del(key)
    assert.isUndefined(await db.get(key), 'checkpointed deletion is visible')

    await db.revert()
    assert.deepEqual(await db.get(key), original, 'revert restores the cached disk value')
  })

  it('refreshes cached values after the final checkpoint commit', async () => {
    db.checkpoint(hexToBytes('0x01'))
    await db.put(key, updated)
    await db.commit()

    assert.deepEqual(await db.get(key), updated, 'committed put refreshes the cache')

    db.checkpoint(hexToBytes('0x02'))
    assert.deepEqual(await db.get(key), updated, 'a later checkpoint sees the committed value')
    await db.del(key)
    await db.commit()

    assert.isUndefined(await db.get(key), 'committed deletion invalidates the cache')
  })

  it('keeps direct non-checkpoint batches coherent with the cache', async () => {
    await db.batch([{ type: 'put', key, value: updated }])
    assert.deepEqual(await db.get(key), updated)

    await db.batch([{ type: 'del', key }])
    assert.isUndefined(await db.get(key))
  })
})

describe.each([0, 100])('DB checkpoint commit failures (cacheSize: %s)', (cacheSize) => {
  describe.each([ValueEncoding.String, ValueEncoding.Bytes])('encoding: %s', (valueEncoding) => {
    const key = utf8ToBytes('existing')
    const removed = utf8ToBytes('removed')
    const added = utf8ToBytes('added')
    const original = utf8ToBytes('original')
    const updated = utf8ToBytes('updated')
    const root = new Uint8Array(32).fill(1)

    it.each(['commit', 'revert'] as const)(
      'preserves pending puts and deletions for %s after a failed outer commit',
      async (recovery) => {
        const backing = new MapDB<string, string | Uint8Array>()
        const db = new CheckpointDB({ db: backing, cacheSize, valueEncoding })
        await db.put(key, original)
        await db.put(removed, original)
        const stored = new Map(backing._database)

        db.checkpoint(root)
        await db.put(key, updated)
        db.checkpoint(new Uint8Array(32).fill(2))
        await db.del(removed)
        await db.put(added, updated)
        await db.commit()

        const failure = new Error('Injected batch failure before any writes')
        vi.spyOn(backing, 'batch').mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(db.commit()).rejects.toBe(failure)
          assert.strictEqual(db.checkpoints.length, 1)
          assert.deepEqual(db.checkpoints[0].root, root)
          assert.deepEqual(await db.get(key), updated)
          assert.isUndefined(await db.get(removed))
          assert.deepEqual(await db.get(added), updated)
          assert.deepEqual(backing._database, stored)
        }

        if (recovery === 'commit') {
          await db.commit()
        } else {
          assert.deepEqual(await db.revert(), root)
        }
        assert.isFalse(db.hasCheckpoints())

        const reader = new CheckpointDB({ db: backing, valueEncoding })
        for (const view of [db, reader]) {
          assert.deepEqual(await view.get(key), recovery === 'commit' ? updated : original)
          assert.deepEqual(await view.get(removed), recovery === 'commit' ? undefined : original)
          assert.deepEqual(await view.get(added), recovery === 'commit' ? updated : undefined)
        }
      },
    )

    it('keeps pending values readable until the final batch succeeds', async () => {
      const backing = new MapDB<string, string | Uint8Array>()
      const db = new CheckpointDB({ db: backing, cacheSize, valueEncoding })
      await db.put(key, original)
      const stored = new Map(backing._database)
      db.checkpoint(root)
      await db.put(key, updated)

      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const batch = backing.batch.bind(backing)
      vi.spyOn(backing, 'batch').mockImplementationOnce(async (ops) => {
        await gate
        await batch(ops)
      })

      const pending = db.commit()
      try {
        assert.isTrue(db.hasCheckpoints())
        assert.deepEqual(await db.get(key), updated)
        assert.deepEqual(backing._database, stored)
      } finally {
        release()
        await pending
      }

      assert.isFalse(db.hasCheckpoints())
      assert.deepEqual(await db.get(key), updated)
      const reader = new CheckpointDB({ db: backing, valueEncoding })
      assert.deepEqual(await reader.get(key), updated)
    })
  })
})
