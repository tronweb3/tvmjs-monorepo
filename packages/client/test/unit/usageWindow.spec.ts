import { assert, describe, it } from 'vitest'

import { windowedUsage } from '../../src/core/node.ts'

/**
 * The usage ledgers run in the chain's fixed-point slot arithmetic: a 24h
 * window of 28800 three-second slots, averages at 1e6 precision, ceil on the
 * way in, round on decay, floor on the way out. Each value here is worked by
 * hand through those steps.
 */
describe('windowed usage', () => {
  const t0 = 3_000 * 1_000_000

  it('reads back what was charged in the same slot', () => {
    // ceil(279e6 / 28800) = 9688; floor(9688 × 28800 / 1e6) = 279
    assert.strictEqual(windowedUsage(0, t0, t0, 279), 279)
    assert.strictEqual(windowedUsage(279, t0, t0 + 2_999, 0), 279)
  })

  it('decays by whole slots, rounding the average', () => {
    // 60 slots later: round(9688 × 28740 / 28800) = 9668 → floor(278.44) = 278
    assert.strictEqual(windowedUsage(279, t0, t0 + 180_000, 0), 278)
    // a charge on top of the decayed average: floor((9668 + 9688) × 0.0288) = 557
    assert.strictEqual(windowedUsage(279, t0, t0 + 180_000, 279), 557)
  })

  it('is spent entirely once a window has passed', () => {
    assert.strictEqual(windowedUsage(279, t0, t0 + 86_400_000, 0), 0)
    assert.strictEqual(windowedUsage(279, t0, t0 + 86_400_000 * 2, 5), 5)
  })

  it('keeps small charges exact through the fixed point', () => {
    // ceil(1e6 / 28800) = 35 per byte; floor(35 × 0.0288) = 1, floor(70 × 0.0288) = 2
    assert.strictEqual(windowedUsage(0, t0, t0, 1), 1)
    assert.strictEqual(windowedUsage(1, t0, t0, 1), 2)
  })
})
