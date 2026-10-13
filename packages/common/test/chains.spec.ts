import { assert, describe, it } from 'vitest'

import {
  Common,
  Hardfork,
  Holesky,
  Hoodi,
  Mainnet,
  Sepolia,
  TronMainnet,
  TronNile,
  TronShasta,
  getPresetChainConfig,
} from '../src/index.ts'

// Ethereum preset data remains available for migration diagnostics; it cannot
// be used to instantiate an execution configuration in v1.2.0.
describe('[Common/Chains]: TRON initialization and lookup', () => {
  for (const chain of [TronMainnet, TronNile, TronShasta]) {
    it(`initializes and resolves ${chain.name}`, () => {
      const common = new Common({ chain })
      assert.strictEqual(common.chainName(), chain.name)
      assert.strictEqual(common.chainId(), BigInt(chain.chainId))
      assert.strictEqual(common.hardfork(), Hardfork.Tron)
      assert.strictEqual(getPresetChainConfig(chain.name), chain)
      assert.strictEqual(getPresetChainConfig(chain.chainId), chain)
    })
  }

  for (const chain of [Mainnet, Sepolia, Holesky, Hoodi]) {
    it(`rejects the retired ${chain.name} execution configuration`, () => {
      assert.throws(
        // @ts-expect-error Ethereum data is intentionally rejected at the execution boundary.
        () => new Common({ chain }),
        /Only TRON execution configurations/,
      )
      assert.throws(() => getPresetChainConfig(chain.name), /Unsupported chain/)
      assert.throws(() => getPresetChainConfig(chain.chainId), /Unsupported chain/)
    })
  }

  it('never falls back to Ethereum for unknown chain inputs', () => {
    for (const input of ['unknown', '__proto__', 'toString', 0, -1, 1234]) {
      assert.throws(() => getPresetChainConfig(input), /Unsupported chain/)
    }
  })

  it('copies parameters and event listeners independently', () => {
    const common = new Common({ chain: TronMainnet, params: { tron: { testValue: 10 } } })
    common.events.on('hardforkChanged', () => {})
    common.events.on('hardforkChanged', () => {})
    const copy = common.copy()
    copy.updateParams({ tron: { testValue: 20 } })
    assert.strictEqual(common.param('testValue'), 10n)
    assert.strictEqual(copy.param('testValue'), 20n)
    assert.strictEqual(common.events.listenerCount('hardforkChanged'), 2)
    assert.strictEqual(copy.events.listenerCount('hardforkChanged'), 0)
    common.updateParams({ tron: { testValue: 30 } })
    assert.strictEqual(copy.param('testValue'), 20n)
  })
})
