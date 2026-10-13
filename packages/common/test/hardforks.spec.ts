import { assert, describe, it } from 'vitest'

import { Common, Hardfork, TronMainnet } from '../src/index.ts'

describe('[Common]: TRON profile selection', () => {
  for (const hardfork of Object.values(Hardfork).filter((name) => name !== Hardfork.Tron)) {
    it(`rejects Ethereum hardfork ${hardfork} at construction and mutation`, () => {
      assert.throws(() => new Common({ chain: TronMainnet, hardfork }), /not supported/)
      const common = new Common({ chain: TronMainnet })
      let changes = 0
      common.events.on('hardforkChanged', () => changes++)
      assert.throws(() => common.setHardfork(hardfork), /not supported/)
      assert.strictEqual(common.hardfork(), Hardfork.Tron)
      assert.isFalse(common.gteHardfork(hardfork))
      assert.strictEqual(changes, 0)
    })
  }

  it('keeps the selected profile across block and timestamp contexts', () => {
    const common = new Common({ chain: TronMainnet })
    for (const blockNumber of [0n, 1n, 12965000n, 9007199254740993n]) {
      for (const timestamp of [undefined, 0n, 1710338135n]) {
        assert.strictEqual(common.getHardforkBy({ blockNumber, timestamp }), Hardfork.Tron)
        assert.strictEqual(common.setHardforkBy({ blockNumber, timestamp }), Hardfork.Tron)
      }
    }
    assert.strictEqual(common.hardforkBlock(), 0n)
    assert.isNull(common.hardforkTimestamp())
    assert.isNull(common.nextHardforkBlockOrTimestamp())
    assert.isTrue(common.activeOnBlock(0n))
    assert.isTrue(common.hardforkGteHardfork(Hardfork.Tron, Hardfork.Tron))
    assert.isNull(common.hardforkBlock(Hardfork.London))
  })

  it('does not emit a transition when selecting the current profile', () => {
    const common = new Common({ chain: TronMainnet })
    let changes = 0
    common.events.on('hardforkChanged', () => changes++)
    common.setHardfork(Hardfork.Tron)
    assert.strictEqual(changes, 0)
  })

  it('does not invent Ethereum fork identifiers for a TRON preset', () => {
    const common = new Common({ chain: TronMainnet })
    assert.throws(() => common.forkHash(), /Ethereum fork hashes are not supported/)
    assert.throws(() => common.forkHash(Hardfork.Tron, new Uint8Array(32)), /not supported/)
    assert.throws(() => common.setForkHashes(new Uint8Array(32)), /not supported/)
    assert.isNull(common.hardforkForForkHash('0xcb6b9941'))
  })
})
