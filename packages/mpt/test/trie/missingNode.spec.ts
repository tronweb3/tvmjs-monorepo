import { MapDB, ValueEncoding, hexToBytes } from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import {
  MerklePatriciaTrie,
  ROOT_DB_KEY,
  createMPTFromProof,
  createMerkleProof,
} from '../../src/index.ts'

import type { MPTOpts } from '../../src/index.ts'

const targetKey = hexToBytes('0x10')
const siblingKey = hexToBytes('0x20')
const emptyKey = new Uint8Array()
const replacement = new Uint8Array(32).fill(0xff)

async function createFixture(opts: MPTOpts = {}, keys = [targetKey, siblingKey]) {
  const db = new MapDB<string, Uint8Array>()
  const trie = new MerklePatriciaTrie({ ...opts, db, valueEncoding: ValueEncoding.Bytes })
  const values = keys.map((_, index) => new Uint8Array(32).fill(index + 1))
  for (const [index, key] of keys.entries()) {
    await trie.put(key, values[index])
  }
  return { db, trie, values }
}

async function removePathNode(trie: MerklePatriciaTrie, key: Uint8Array, nodeIndex = -1) {
  const { stack } = await trie.findPath(trie['appliedKey'](key), true)
  const node = stack.at(nodeIndex)
  assert.isDefined(node)
  const encoded = node!.serialize()
  // Values are long enough to force hashed nodes, rather than inline child references.
  assert.isAtLeast(encoded.length, 32)
  const dbKey = trie['_getDbKey'](trie['hash'](encoded))
  assert.deepEqual(await trie.database().get(dbKey), encoded)
  // Also evict any cached copy so the next lookup must observe the missing node.
  await trie.database().del(dbKey)
  return { dbKey, encoded }
}

const configurations: { name: string; opts: MPTOpts; skipKeyTransform?: boolean }[] = [
  { name: 'default', opts: {} },
  { name: 'pruning', opts: { useNodePruning: true } },
  { name: 'cache', opts: { cacheSize: 32 } },
  { name: 'root persistence', opts: { useRootPersistence: true } },
  {
    name: 'secure prefixed storage with pruning and cache',
    opts: {
      useKeyHashing: true,
      keyPrefix: hexToBytes('0xabcd'),
      useRootPersistence: true,
      useNodePruning: true,
      cacheSize: 32,
    },
  },
  { name: 'already hashed keys', opts: { useKeyHashing: true }, skipKeyTransform: true },
]

describe('put with missing trie nodes', () => {
  it.each(configurations)(
    'rejects a missing child before changing the root or database ($name)',
    async ({ opts, skipKeyTransform = false }) => {
      const { db, trie, values } = await createFixture(opts)
      const root = trie.root().slice()
      const missing = await removePathNode(trie, targetKey)
      const diskBefore = new Map(db._database)
      const persistedRootKey = trie['_getDbKey'](trie['appliedKey'](ROOT_DB_KEY))
      const putKey = skipKeyTransform ? trie['appliedKey'](targetKey) : targetKey

      await expect(trie.get(targetKey, true)).rejects.toThrow('Missing node in DB')
      await expect(trie.get(targetKey)).resolves.toBeNull()
      await expect(trie.put(putKey, replacement, skipKeyTransform)).rejects.toThrow(
        'Missing node in DB',
      )

      assert.deepEqual(trie.root(), root)
      assert.deepEqual(db._database, diskBefore)
      assert.deepEqual(
        await trie.database().get(persistedRootKey),
        opts.useRootPersistence === true ? root : undefined,
      )
      await expect(trie.get(targetKey, true)).rejects.toThrow('Missing node in DB')
      assert.deepEqual(await trie.get(siblingKey, true), values[1])
      if (opts.useKeyHashing !== true) {
        await expect(trie.get(emptyKey, true)).resolves.toBeNull()
      }

      // Restoring the missing node allows a retry on the same instance: the lock was released.
      await trie.database().put(missing.dbKey, missing.encoded)
      await trie.put(putKey, replacement, skipKeyTransform)
      assert.deepEqual(await trie.get(targetKey, true), replacement)
      assert.deepEqual(await trie.get(siblingKey, true), values[1])
      assert.notDeepEqual(trie.root(), root)
    },
  )

  it.each([
    { name: 'root', keys: ['0x10', '0x20'], nodeIndex: 0 },
    { name: 'extension child', keys: ['0x1000', '0x1010'], nodeIndex: 1 },
    { name: 'nested branch child', keys: ['0x1010', '0x1020', '0x2000'], nodeIndex: -1 },
  ] as const)('rejects a missing $name without publishing a new root', async (testCase) => {
    const keys = testCase.keys.map((key) => hexToBytes(key))
    const { db, trie } = await createFixture({ useRootPersistence: true }, keys)
    const root = trie.root().slice()
    await removePathNode(trie, keys[0], testCase.nodeIndex)
    const diskBefore = new Map(db._database)

    await expect(trie.put(keys[0], replacement)).rejects.toThrow('Missing node in DB')

    assert.deepEqual(trie.root(), root)
    assert.deepEqual(db._database, diskBefore)
    assert.deepEqual(await trie.database().get(ROOT_DB_KEY), root)
  })

  it('preserves an existing ancestor branch value', async () => {
    const { db, trie } = await createFixture()
    const ancestorValue = new Uint8Array(32).fill(3)
    await trie.put(emptyKey, ancestorValue)
    const root = trie.root().slice()
    await removePathNode(trie, targetKey)
    const diskBefore = new Map(db._database)

    await expect(trie.put(targetKey, replacement)).rejects.toThrow('Missing node in DB')

    assert.deepEqual(trie.root(), root)
    assert.deepEqual(db._database, diskBefore)
    assert.deepEqual(await trie.get(emptyKey, true), ancestorValue)
  })

  it('keeps earlier checkpoint changes when a later put fails', async () => {
    const { trie } = await createFixture({
      useRootPersistence: true,
      useNodePruning: true,
      cacheSize: 32,
    })
    const missing = await removePathNode(trie, targetKey)
    trie.checkpoint()
    await trie.put(siblingKey, replacement)
    const root = trie.root().slice()

    await expect(trie.put(targetKey, replacement)).rejects.toThrow('Missing node in DB')

    assert.deepEqual(trie.root(), root)
    assert.deepEqual(await trie.database().get(ROOT_DB_KEY), root)
    await trie.commit()
    assert.deepEqual(trie.root(), root)
    assert.deepEqual(await trie.database().get(ROOT_DB_KEY), root)
    assert.deepEqual(await trie.get(siblingKey, true), replacement)
    await expect(trie.get(emptyKey, true)).resolves.toBeNull()
    await expect(trie.get(targetKey, true)).rejects.toThrow('Missing node in DB')

    await trie.database().put(missing.dbKey, missing.encoded)
    await trie.put(targetKey, replacement)
    assert.deepEqual(await trie.get(targetKey, true), replacement)
  })

  it('allows writes proven by a sparse trie while rejecting writes through missing nodes', async () => {
    const { trie: complete } = await createFixture()
    const sparse = await createMPTFromProof(await createMerkleProof(complete, targetKey), {
      root: complete.root(),
    })
    await expect(sparse.get(siblingKey, true)).rejects.toThrow('Missing node in DB')

    await sparse.put(targetKey, replacement)
    await complete.put(targetKey, replacement)
    assert.deepEqual(sparse.root(), complete.root())
    assert.deepEqual(await sparse.get(targetKey, true), replacement)

    const root = sparse.root().slice()
    await expect(sparse.put(siblingKey, replacement)).rejects.toThrow('Missing node in DB')
    assert.deepEqual(sparse.root(), root)

    // A genuinely absent branch can still be populated without loading unrelated subtrees.
    const newKey = hexToBytes('0x30')
    await expect(sparse.get(newKey, true)).resolves.toBeNull()
    await sparse.put(newKey, replacement)
    await complete.put(newKey, replacement)
    assert.deepEqual(sparse.root(), complete.root())
    assert.deepEqual(await sparse.get(newKey, true), replacement)
  })
})
