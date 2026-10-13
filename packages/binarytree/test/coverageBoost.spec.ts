import { MapDB, hexToBytes, utf8ToBytes } from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import { BinaryNodeType, CheckpointDB, InternalBinaryNode, createBinaryTree } from '../src/index.ts'
import { verifyBinaryProof } from '../src/proof.ts'

describe('BinaryTree Coverage Boost', () => {
  it('covers CheckpointDB stats, open, shallowCopy, setCheckpoints, and batch with checkpoints', async () => {
    const memDb = new MapDB<string, string | Uint8Array>()
    const db = new CheckpointDB({ db: memDb, cacheSize: 10 })
    await db.open()

    const stats = db.stats(false)
    assert.strictEqual(stats.cache.reads, 0)
    assert.strictEqual(stats.size, 0)
    db.stats(true)

    const copy = db.shallowCopy()
    assert.instanceOf(copy, CheckpointDB)

    const k1 = utf8ToBytes('k1')
    const v1 = utf8ToBytes('v1')
    const k2 = utf8ToBytes('k2')
    const v2 = utf8ToBytes('v2')

    db.checkpoint(hexToBytes('0x01'))
    assert.isTrue(db.hasCheckpoints())

    await db.batch([
      { type: 'put', key: k1, value: v1 },
      { type: 'put', key: k2, value: v2 },
    ])
    assert.deepEqual(await db.get(k1), v1)
    assert.deepEqual(await db.get(k2), v2)

    await db.batch([{ type: 'del', key: k1 }])
    assert.isUndefined(await db.get(k1))

    db.setCheckpoints(db.checkpoints)
    assert.isTrue(db.hasCheckpoints())

    await db.revert()
    assert.isFalse(db.hasCheckpoints())
  })

  it('covers InternalBinaryNode validation, child accessors and raw with null children', () => {
    const node = InternalBinaryNode.create()
    assert.isNull(node.getChild(0))
    assert.isNull(node.getChild(1))

    node.setChild(0, { hash: new Uint8Array(32).fill(1), path: [0, 1] })
    assert.isNotNull(node.getChild(0))

    const raw = node.raw()
    assert.strictEqual(raw[0][0], BinaryNodeType.Internal)

    expect(() => InternalBinaryNode.create([])).toThrow('Internal node must have 2 children')
    expect(() => InternalBinaryNode.fromRawNode([new Uint8Array([99])])).toThrow(
      'Invalid node type',
    )
    expect(() =>
      InternalBinaryNode.fromRawNode([new Uint8Array([BinaryNodeType.Internal]), new Uint8Array()]),
    ).toThrow('Invalid node length')
  })

  it('covers BinaryTree edge cases: createReadStream, commit/revert errors, hash errors', async () => {
    const tree = await createBinaryTree({ useRootPersistence: true })
    expect(() => tree.createReadStream()).toThrow('Not implemented')
    await expect(tree.commit()).rejects.toThrow('trying to commit when not checkpointed')
    await expect(tree.revert()).rejects.toThrow('trying to revert when not checkpointed')

    tree.checkpoint()
    const copyWithCheckpoints = tree.shallowCopy(true)
    assert.isTrue(copyWithCheckpoints.hasCheckpoints())

    tree.flushCheckpoints()
    assert.isFalse(tree.hasCheckpoints())

    expect(() => (tree as any).hash(new Uint8Array(10))).toThrow('Data must be 32 or 64 bytes')
    assert.deepEqual((tree as any).hash(null), new Uint8Array(32))
    assert.deepEqual((tree as any).hash(new Uint8Array(64)), new Uint8Array(32))
  })

  it('covers proof verification errors', async () => {
    const tree = await createBinaryTree()
    const stem = new Uint8Array(31).fill(1)
    const val = new Uint8Array(32).fill(2)
    await tree.put(stem, [0], [val])

    const key = new Uint8Array(32).fill(1)
    key[31] = 0
    const proof = await tree.createBinaryProof(key)

    await expect(verifyBinaryProof(new Uint8Array(32).fill(99), key, proof)).rejects.toThrow(
      'rootHash does not match proof root',
    )
  })
})
