import { assert, describe, it } from 'vitest'

import { Common, TronMainnet } from '../src/index.ts'

describe('[Common/EIPs]: TRON capability selection', () => {
  it('keeps CLZ explicit and independent of governance proposals', () => {
    for (const activatedProposals of [[], [95], [96], [95, 96]]) {
      const common = new Common({ chain: TronMainnet, activatedProposals })
      assert.isFalse(common.isActivatedEIP(7939))
      common.setEIPs([7939, 7939])
      assert.isTrue(common.isActivatedEIP(7939))
      assert.deepEqual(common.eips(), [7939])
      common.setEIPs([])
      assert.isFalse(common.isActivatedEIP(7939))
    }
  })

  it('keeps shared baseline capabilities active independently of explicit selection', () => {
    const common = new Common({ chain: TronMainnet })
    for (const eip of [606, 607, 608, 609, 1013, 1679, 1153, 3855, 5656, 6780]) {
      assert.isTrue(common.isActivatedEIP(eip))
      assert.strictEqual(common.eipBlock(eip), 0n)
      assert.isNull(common.eipTimestamp(eip))
    }
    assert.isNull(common.eipBlock(4844))
    assert.isNull(common.eipTimestamp(4844))
  })

  it('rejects invalid or unavailable capabilities without changing state', () => {
    const common = new Common({ chain: TronMainnet, eips: [7939] })
    for (const eip of [
      NaN,
      Infinity,
      -1,
      0,
      7939.5,
      Number.MAX_SAFE_INTEGER + 1,
      99999,
      4844,
      4788,
      7516,
    ]) {
      assert.throws(() => common.setEIPs([eip]), /not supported/)
      assert.deepEqual(common.eips(), [7939])
    }
  })
})
