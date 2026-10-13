import { rejects } from 'node:assert/strict'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { assert, beforeEach, describe, it, vi } from 'vitest'

import { Clock } from '../../src/core/clock.ts'
import type { TronNode } from '../../src/node.ts'
import { probeState } from '../stateProbe.ts'

describe('development block and clock inputs', () => {
  let node: TronNode
  let clock: Clock

  beforeEach(async () => {
    clock = new Clock(() => 1_800_000_000_000)
    node = await createNode({}, clock)
  })

  it.each(['mine', 'increaseTime', 'blockTime', 'clock'] as const)(
    '%s rejects invalid numbers without changing state or time',
    async (method) => {
      const state = await probeState(node)
      const time = clock.nowMs()
      for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
        await rejects(async () => {
          if (method === 'clock') clock.advanceMs(invalid as number)
          else await node.tre[method](invalid as number)
        }, /must be/)
        assert.deepEqual(await probeState(node), state)
        assert.strictEqual(clock.nowMs(), time)
      }
      await node.tre.mine(1)
    },
  )

  it('validates count, interval and time overflow before changing state', async () => {
    const before = await probeState(node)
    const time = clock.nowMs()
    for (const count of [0, 101]) await rejects(node.tre.mine(count), /must be/)
    await rejects(node.tre.blockTime(61), /must be/)
    await rejects(node.tre.increaseTime(Number.MAX_SAFE_INTEGER), /must be/)
    assert.throws(() => clock.advanceMs(Number.MAX_SAFE_INTEGER), /must be/)
    assert.deepEqual(await probeState(node), before)
    assert.strictEqual(clock.nowMs(), time)
    const height = nodeCore(node).head().number
    await node.tre.mine(100)
    await node.tre.increaseTime(0)
    assert.strictEqual(nodeCore(node).head().number, height + 101n)
  })

  it('keeps a running timer when its replacement is invalid', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await node.tre.blockTime(1)
      const height = nodeCore(node).head().number
      for (const seconds of [NaN, -1, 1.5, 61]) {
        await rejects(node.tre.blockTime(seconds), /must be/)
      }
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(nodeCore(node).head().number, height + 1n)
      await node.tre.blockTime(0)
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(nodeCore(node).head().number, height + 1n)
    } finally {
      await node.tre.blockTime(0)
      vi.useRealTimers()
    }
  })

  it('reports invalid block time through the returned promise', async () => {
    const caught = vi.fn()
    await node.tre.blockTime(61).catch(caught)
    assert.strictEqual(caught.mock.calls.length, 1)
    assert.instanceOf(caught.mock.calls[0][0], RangeError)
  })
})
