import { MapDB } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createBinaryTree } from '../src/index.ts'

describe('delete', () => {
  it.each([
    { branch: 'right root child', firstByte: 0xff, lastByte: 0xff, siblingByte: 0 },
    { branch: 'left root child', firstByte: 0, lastByte: 0, siblingByte: 0xff },
    { branch: 'nested child', firstByte: 0x40, lastByte: 0, siblingByte: 0 },
    { branch: 'child after a 247-bit prefix', firstByte: 0, lastByte: 1, siblingByte: 0 },
  ])('removes the last value of a stem at the $branch', async (testCase) => {
    const tree = await createBinaryTree({ cacheSize: 0 })
    const siblingStem = new Uint8Array(31).fill(testCase.siblingByte)
    const stem = new Uint8Array(31).fill(testCase.firstByte)
    stem[30] = testCase.lastByte
    const siblingValues = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)]
    const value = new Uint8Array(32).fill(3)

    await tree.put(siblingStem, [0, 255], siblingValues)
    await tree.put(stem, [1], [value])
    assert.deepEqual(await tree.get(stem, [1]), [value])
    const originalRoot = tree.root().slice()
    const originalTree = tree.shallowCopy()

    await tree.del(stem, [1])

    assert.deepEqual(await tree.get(stem, [1]), [])
    assert.notDeepEqual(tree.root(), originalRoot)
    assert.deepEqual(await tree.get(siblingStem, [0, 255]), siblingValues)
    assert.deepEqual(await originalTree.get(stem, [1]), [value])

    const deletedRoot = tree.root().slice()
    await tree.del(stem, [1])
    assert.deepEqual(tree.root(), deletedRoot)
    await tree.put(stem, [1], [value])
    assert.deepEqual(await tree.get(stem, [1]), [value])
    assert.deepEqual(tree.root(), originalRoot)
  })

  it('preserves other values in the same stem when deleting only one suffix', async () => {
    const tree = await createBinaryTree()
    const siblingStem = new Uint8Array(31)
    const stem = new Uint8Array(31).fill(0xff)
    const value = new Uint8Array(32).fill(1)
    const remainingValue = new Uint8Array(32).fill(2)
    await tree.put(siblingStem, [0], [value])
    await tree.put(stem, [1, 255], [value, remainingValue])
    const originalRoot = tree.root().slice()

    await tree.del(stem, [1])

    assert.deepEqual(await tree.get(stem, [1, 255]), [null, remainingValue])
    assert.deepEqual(await tree.get(siblingStem, [0]), [value])
    assert.notDeepEqual(tree.root(), originalRoot)
  })

  it('removes a branch through put with null values', async () => {
    const tree = await createBinaryTree()
    const siblingStem = new Uint8Array(31)
    const stem = new Uint8Array(31).fill(0xff)
    const value = new Uint8Array(32).fill(3)
    await tree.put(siblingStem, [0], [value])
    await tree.put(stem, [0, 255], [value, value])
    const originalRoot = tree.root().slice()

    await tree.put(stem, [0, 255], [null, null])

    assert.deepEqual(await tree.get(stem, [0, 255]), [])
    assert.deepEqual(await tree.get(siblingStem, [0]), [value])
    assert.notDeepEqual(tree.root(), originalRoot)
  })

  it('removes empty internal branches after deleting their remaining stems', async () => {
    const tree = await createBinaryTree()
    const siblingStem = new Uint8Array(31)
    const stems = [new Uint8Array(31).fill(0x80), new Uint8Array(31).fill(0xc0)]
    const value = new Uint8Array(32).fill(3)
    await tree.put(siblingStem, [0], [value])
    for (const stem of stems) {
      await tree.put(stem, [1], [value])
    }
    const originalRoot = tree.root().slice()

    for (const stem of stems) {
      await tree.del(stem, [1])
      assert.deepEqual(await tree.get(stem, [1]), [])
      assert.deepEqual(await tree.get(siblingStem, [0]), [value])
    }
    for (const stem of stems) {
      assert.deepEqual(await tree.get(stem, [1]), [])
      await tree.put(stem, [1], [value])
    }
    assert.deepEqual(tree.root(), originalRoot)

    await tree.del(siblingStem, [0])
    for (const stem of stems) {
      await tree.del(stem, [1])
    }
    assert.deepEqual(tree.root(), tree.EMPTY_TREE_ROOT)
    assert.deepEqual(await tree.get(siblingStem, [0]), [])
  })

  it.each([0, 32])('can revert and commit stem deletion with cacheSize %i', async (cacheSize) => {
    const tree = await createBinaryTree({ cacheSize })
    const siblingStem = new Uint8Array(31)
    const stem = new Uint8Array(31).fill(0xff)
    const value = new Uint8Array(32).fill(3)
    await tree.put(siblingStem, [0], [value])
    await tree.put(stem, [1], [value])
    const originalRoot = tree.root().slice()

    tree.checkpoint()
    await tree.del(stem, [1])
    const deletedRoot = tree.root().slice()
    assert.deepEqual(await tree.get(stem, [1]), [])
    await tree.revert()
    assert.deepEqual(tree.root(), originalRoot)
    assert.deepEqual(await tree.get(stem, [1]), [value])

    tree.checkpoint()
    await tree.del(stem, [1])
    await tree.commit()
    assert.deepEqual(tree.root(), deletedRoot)
    assert.deepEqual(await tree.get(stem, [1]), [])
    assert.deepEqual(await tree.shallowCopy(false).get(stem, [1]), [])
    assert.deepEqual(await tree.get(siblingStem, [0]), [value])
  })

  it('matches the root of a tree built from the remaining stems', async () => {
    // Deterministic LCG so failures are reproducible.
    let seed = 7
    const nextByte = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return seed >>> 24
    }
    for (let trial = 0; trial < 100; trial++) {
      const unique = new Map<string, Uint8Array>()
      for (let i = 0; i < 2 + (trial % 7); i++) {
        const stem = new Uint8Array(31).map(nextByte)
        // Every third trial shares a 240-bit prefix to exercise deep branches.
        if (trial % 3 === 0) stem.fill(0, 0, 30)
        unique.set(stem.join(','), stem)
      }
      const stems = [...unique.values()]
      const valueFor = (stem: Uint8Array) => new Uint8Array(32).fill(stem[30] | 1)
      const tree = await createBinaryTree({ cacheSize: trial % 2 === 0 ? 0 : 32 })
      for (const stem of stems) await tree.put(stem, [stem[30]], [valueFor(stem)])

      const removed = stems.filter((_, i) => (i + trial) % 2 === 0)
      const kept = stems.filter((_, i) => (i + trial) % 2 !== 0)
      for (const stem of removed) await tree.del(stem, [stem[30]])

      const expected = await createBinaryTree()
      for (const stem of kept) await expected.put(stem, [stem[30]], [valueFor(stem)])
      assert.deepEqual(tree.root(), expected.root(), `trial ${trial}`)
      for (const stem of kept) assert.deepEqual(await tree.get(stem, [stem[30]]), [valueFor(stem)])
      for (const stem of removed) assert.deepEqual(await tree.get(stem, [stem[30]]), [])
    }
  })

  it('persists the root after puts and deletions', async () => {
    const db = new MapDB<string, Uint8Array>()
    const tree = await createBinaryTree({ db, useRootPersistence: true })
    const stems = [new Uint8Array(31), new Uint8Array(31).fill(0xff)]
    const value = new Uint8Array(32).fill(1)

    for (const stem of stems) {
      await tree.put(stem, [0], [value])
      assert.deepEqual(
        (await createBinaryTree({ db, useRootPersistence: true })).root(),
        tree.root(),
      )
    }
    for (const stem of stems) {
      await tree.del(stem, [0])
      assert.deepEqual(
        (await createBinaryTree({ db, useRootPersistence: true })).root(),
        tree.root(),
      )
    }
    assert.deepEqual(tree.root(), tree.EMPTY_TREE_ROOT)
  })
})
