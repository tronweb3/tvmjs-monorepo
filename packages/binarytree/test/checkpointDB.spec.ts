import { MapDB, hexToBytes, utf8ToBytes } from '@tvmjs/util'
import { assert, beforeEach, describe, it } from 'vitest'

import { CheckpointDB } from '../src/index.ts'

describe('BinaryTree CheckpointDB cache coherency', () => {
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
