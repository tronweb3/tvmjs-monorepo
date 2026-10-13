import { assert, afterEach, describe, expect, it, vi } from 'vitest'

import { ROOT_DB_KEY, createBinaryTree } from '../src/index.ts'

import type { BinaryTree } from '../src/index.ts'

const stemA = new Uint8Array(31)
const stemB = new Uint8Array(31).fill(0xff)
const values = [1, 2, 3].map((byte) => new Uint8Array(32).fill(byte))
type Mutation = [Uint8Array, number, Uint8Array | null]

afterEach(() => vi.restoreAllMocks())

function createGate() {
  let signal!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    signal = resolve
  })
  const resumed = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    reached,
    release,
    pause: async () => {
      signal()
      await resumed
    },
  }
}

function pauseFirstRead(tree: BinaryTree) {
  const gate = createGate()
  const findPath = tree.findPath.bind(tree)
  vi.spyOn(tree, 'findPath').mockImplementationOnce(async (stem) => {
    const path = await findPath(stem)
    await gate.pause()
    return path
  })
  return gate
}

async function runOverlapping(
  gate: ReturnType<typeof createGate>,
  firstOperation: () => Promise<void>,
  secondOperation: () => Promise<void>,
) {
  const first = firstOperation()
  try {
    await Promise.race([
      gate.reached,
      first.then(() => {
        throw new Error('First operation completed before reaching the pause')
      }),
    ])
    const results = Promise.allSettled([first, secondOperation()])
    // Let the second call run while the first is paused. A two-reader barrier would
    // deadlock a correctly serialized implementation, so release on the next event loop turn.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    gate.release()
    expect(await results).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ])
  } finally {
    gate.release()
  }
}

async function apply(tree: BinaryTree, [stem, suffix, value]: Mutation) {
  if (value === null) {
    await tree.del(stem, [suffix])
  } else {
    await tree.put(stem, [suffix], [value])
  }
}

async function assertSameState(actual: BinaryTree, expected: BinaryTree) {
  assert.deepEqual(actual.root(), expected.root())
  for (const stem of [stemA, stemB]) {
    assert.deepEqual(await actual.get(stem, [0, 1, 2]), await expected.get(stem, [0, 1, 2]))
  }
}

const scenarios: { name: string; initial: Mutation[]; updates: [Mutation, Mutation] }[] = [
  {
    name: 'different suffixes of the same stem',
    initial: [[stemA, 0, values[0]]],
    updates: [
      [stemA, 1, values[1]],
      [stemA, 2, values[2]],
    ],
  },
  {
    name: 'different stems below a shared root',
    initial: [
      [stemA, 0, values[0]],
      [stemB, 0, values[0]],
    ],
    updates: [
      [stemA, 1, values[1]],
      [stemB, 2, values[2]],
    ],
  },
  {
    name: 'inserting a new stem while updating another',
    initial: [[stemA, 0, values[0]]],
    updates: [
      [stemA, 1, values[1]],
      [stemB, 2, values[2]],
    ],
  },
  {
    name: 'put followed by deletion',
    initial: [[stemA, 0, values[0]]],
    updates: [
      [stemA, 1, values[1]],
      [stemA, 0, null],
    ],
  },
  {
    name: 'last value deletion followed by put',
    initial: [[stemA, 0, values[0]]],
    updates: [
      [stemA, 0, null],
      [stemA, 1, values[1]],
    ],
  },
]

describe.each([
  { cacheSize: 0, useRootPersistence: false },
  { cacheSize: 32, useRootPersistence: true },
])('concurrent tree mutations ($cacheSize cache, persistence $useRootPersistence)', (opts) => {
  it.each(scenarios)('preserves successful writes: $name', async ({ initial, updates }) => {
    const tree = await createBinaryTree(opts)
    const expected = await createBinaryTree()
    for (const mutation of initial) {
      await apply(tree, mutation)
      await apply(expected, mutation)
    }

    await runOverlapping(
      pauseFirstRead(tree),
      () => apply(tree, updates[0]),
      () => apply(tree, updates[1]),
    )
    for (const mutation of updates) await apply(expected, mutation)

    await assertSameState(tree, expected)
    if (opts.useRootPersistence) {
      const restored = await createBinaryTree({ db: tree['_db'].db, useRootPersistence: true })
      await assertSameState(restored, expected)
    }
  })

  it('waits for the initial node to be stored before starting another put', async () => {
    const tree = await createBinaryTree(opts)
    const expected = await createBinaryTree()
    const gate = createGate()
    const put = tree['_db'].put.bind(tree['_db'])
    vi.spyOn(tree['_db'], 'put').mockImplementationOnce(async (key, value) => {
      await gate.pause()
      await put(key, value)
    })

    await runOverlapping(
      gate,
      () => tree.put(stemA, [1], [values[1]]),
      () => tree.put(stemA, [2], [values[2]]),
    )
    await expected.put(stemA, [1, 2], [values[1], values[2]])
    await assertSameState(tree, expected)
  })

  it('waits for updated nodes to be stored before starting another put', async () => {
    const tree = await createBinaryTree(opts)
    const expected = await createBinaryTree()
    await tree.put(stemA, [0], [values[0]])
    const gate = createGate()
    const saveStack = tree.saveStack.bind(tree)
    vi.spyOn(tree, 'saveStack').mockImplementationOnce(async (stack) => {
      await gate.pause()
      await saveStack(stack)
    })

    await runOverlapping(
      gate,
      () => tree.put(stemA, [1], [values[1]]),
      () => tree.put(stemA, [2], [values[2]]),
    )
    await expected.put(stemA, [0, 1, 2], values)
    await assertSameState(tree, expected)
  })
})

describe('write lock boundaries', () => {
  it.each([0, 32])('keeps root persistence in write order with cacheSize %i', async (cacheSize) => {
    const tree = await createBinaryTree({ cacheSize, useRootPersistence: true })
    await tree.put(stemA, [0], [values[0]])
    const gate = createGate()
    const put = tree['_db'].put.bind(tree['_db'])
    vi.spyOn(tree['_db'], 'put').mockImplementationOnce(async (key, value) => {
      assert.deepEqual(key, ROOT_DB_KEY)
      await gate.pause()
      await put(key, value)
    })

    await runOverlapping(
      gate,
      () => tree.put(stemA, [1], [values[1]]),
      () => tree.put(stemA, [2], [values[2]]),
    )

    const expected = await createBinaryTree()
    await expected.put(stemA, [0, 1, 2], values)
    await assertSameState(tree, expected)
    const restored = await createBinaryTree({ db: tree['_db'].db, useRootPersistence: true })
    await assertSameState(restored, expected)
  })

  it.each(['commit', 'revert'] as const)('orders %s after a pending put', async (operation) => {
    const tree = await createBinaryTree({ useRootPersistence: true })
    const expected = await createBinaryTree()
    await tree.put(stemA, [0], [values[0]])
    await expected.put(stemA, [0], [values[0]])
    tree.checkpoint()
    let rootAtCompletion: Uint8Array | undefined

    await runOverlapping(
      pauseFirstRead(tree),
      () => tree.put(stemA, [1], [values[1]]),
      async () => {
        await tree[operation]()
        rootAtCompletion = tree.root().slice()
      },
    )

    if (operation === 'commit') await expected.put(stemA, [1], [values[1]])
    assert.deepEqual(rootAtCompletion, expected.root())
    await assertSameState(tree, expected)
    assert.isFalse(tree.hasCheckpoints())
    const restored = await createBinaryTree({ db: tree['_db'].db, useRootPersistence: true })
    await assertSameState(restored, expected)
  })

  it.each(['commit', 'revert'] as const)(
    'rechecks checkpoint availability after waiting for %s',
    async (operation) => {
      const tree = await createBinaryTree()
      await tree.put(stemA, [0], [values[0]])
      tree.checkpoint()
      const results = await Promise.allSettled([tree[operation](), tree[operation]()])

      expect(results[0].status).toBe('fulfilled')
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { message: `trying to ${operation} when not checkpointed` },
      })
      await tree.put(stemA, [1], [values[1]])
      assert.deepEqual(await tree.get(stemA, [0, 1]), [values[0], values[1]])
    },
  )

  it.each(['findPath', 'saveStack', 'persistRoot'] as const)(
    'releases the write lock when %s fails',
    async (method) => {
      const tree = await createBinaryTree({ useRootPersistence: true })
      await tree.put(stemA, [0], [values[0]])
      const root = tree.root().slice()
      const failure = new Error('injected write failure')
      vi.spyOn(tree, method).mockRejectedValueOnce(failure)

      await expect(tree.put(stemA, [1], [values[1]])).rejects.toBe(failure)

      // Recover the known root after the simulated storage failure before retrying.
      tree.root(root)
      await tree.put(stemA, [2], [values[2]])
      assert.deepEqual(await tree.get(stemA, [0, 1, 2]), [values[0], null, values[2]])
    },
  )

  it.each(['commit', 'revert'] as const)(
    'releases the shared lock when %s storage fails',
    async (operation) => {
      const tree = await createBinaryTree()
      await tree.put(stemA, [0], [values[0]])
      tree.checkpoint()
      const failure = new Error('injected checkpoint failure')
      vi.spyOn(tree['_db'], operation).mockRejectedValueOnce(failure)

      await expect(tree[operation]()).rejects.toBe(failure)

      await tree.put(stemA, [1], [values[1]])
      assert.deepEqual(await tree.get(stemA, [0, 1]), [values[0], values[1]])
    },
  )
})
