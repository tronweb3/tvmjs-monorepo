import { Common, TronNile } from '@tvmjs/common'
import { MapDB } from '@tvmjs/util'
import { assert, afterEach, describe, expect, it, vi } from 'vitest'

import { DBManager } from '../src/db/manager.ts'
import { DBOp, DBTarget } from '../src/db/operation.ts'

afterEach(() => vi.restoreAllMocks())

describe.each([
  { name: 'header', target: DBTarget.Header },
  { name: 'body', target: DBTarget.Body },
  { name: 'total difficulty', target: DBTarget.TotalDifficulty },
  { name: 'hash to number', target: DBTarget.HashToNumber },
  { name: 'number to hash', target: DBTarget.NumberToHash },
])('DBManager $name cache', ({ target }) => {
  const original = Uint8Array.of(1)
  const updated = Uint8Array.of(2)
  const keys = [1, 2, 3].map((number) => ({
    blockHash: new Uint8Array(32).fill(number),
    blockNumber: BigInt(number),
  }))

  async function setup() {
    const db = new MapDB()
    const manager = new DBManager(db, new Common({ chain: TronNile }))
    await manager.batch([DBOp.set(target, original, keys[0]), DBOp.set(target, original, keys[1])])
    const updates = [
      DBOp.set(target, updated, keys[0]),
      DBOp.del(target, keys[1]),
      DBOp.set(target, updated, keys[2]),
    ]

    async function assertValues(expected: (Uint8Array | undefined)[]) {
      for (const [index, key] of keys.entries()) {
        const dbKey = DBOp.get(target, key).baseDBOp.key
        assert.deepEqual(await db.get(dbKey), expected[index], 'stored value')
        assert.deepEqual(await manager.get(target, key), expected[index], 'cached value')
      }
    }

    return { db, manager, updates, assertValues }
  }

  it('preserves values when a batch rejects and supports retry', async () => {
    const { db, manager, updates, assertValues } = await setup()
    const failure = new Error('Injected batch failure before any writes')
    vi.spyOn(db, 'batch').mockRejectedValueOnce(failure)

    await expect(manager.batch(updates)).rejects.toBe(failure)
    await assertValues([original, original, undefined])

    await manager.batch(updates)
    await assertValues([updated, undefined, updated])
  })

  it('keeps pending changes hidden and applies them after the batch succeeds', async () => {
    const { db, manager, updates, assertValues } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const batch = db.batch.bind(db)
    vi.spyOn(db, 'batch').mockImplementationOnce(async (ops) => {
      await gate
      await batch(ops)
    })

    const pending = manager.batch(updates)
    try {
      await assertValues([original, original, undefined])
    } finally {
      release()
      await pending
    }
    await assertValues([updated, undefined, updated])
  })
})
