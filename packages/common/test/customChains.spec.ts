// cspell:ignore dpos
import { assert, describe, it } from 'vitest'

import {
  Common,
  Hardfork,
  Mainnet,
  TronMainnet,
  TronNile,
  TronShasta,
  createCustomCommon,
} from '../src/index.ts'

import type { ChainConfig } from '../src/index.ts'

describe('[Common]: custom TRON configuration', () => {
  it('preserves custom identity, parameters and governance state', () => {
    const common = createCustomCommon({ name: 'private-tron', chainId: 123 }, TronMainnet, {
      params: { tron: { testValue: 9 } },
      activatedProposals: [96],
      eips: [7939],
    })
    assert.strictEqual(common.chainName(), 'private-tron')
    assert.strictEqual(common.chainId(), 123n)
    assert.strictEqual(common.param('testValue'), 9n)
    assert.isTrue(common.isActivatedProposal(96))
    assert.isTrue(common.isActivatedEIP(7939))
    assert.isFalse(common.hasConsensus())
  })

  it('rejects Ethereum bases and custom hardfork overrides', () => {
    assert.throws(
      // @ts-expect-error Ethereum data is not an executable chain configuration.
      () => createCustomCommon({ chainId: 123 }, Mainnet),
      /Only TRON execution/,
    )
    const variants: Partial<ChainConfig>[] = [
      { defaultHardfork: Hardfork.Cancun },
      { hardforks: [{ name: Hardfork.Cancun, block: 0 }] },
      { hardforks: [...TronMainnet.hardforks, { name: Hardfork.Cancun, block: 1 }] },
      { hardforks: [{ name: Hardfork.Tron, block: 0, timestamp: 1 }] },
      { hardforks: [{ name: Hardfork.Tron, block: 0, forkHash: '0x12345678' }] },
      { customHardforks: { tron: { eips: [4844] } } },
      { customHardforks: { tron: { consensus: { type: 'pow', algorithm: 'ethash' } } } },
    ]
    for (const variant of variants) {
      assert.throws(
        // @ts-expect-error Schedule overrides are rejected at both type and runtime boundaries.
        () => createCustomCommon(variant, TronMainnet),
        /createCustomCommon\(\) cannot override/,
      )
    }
  })

  it('returns network metadata only when explicitly supplied and copies it independently', () => {
    const chain: ChainConfig = {
      ...TronMainnet,
      name: 'test-network-metadata',
      genesis: { gasLimit: 1, difficulty: 0, nonce: '0x0000000000000000', extraData: '0x' },
      consensus: { type: 'dpos', algorithm: 'dpos' },
    }
    const common = new Common({ chain })
    const copy = common.copy()
    assert.isTrue(common.hasGenesis())
    assert.isTrue(common.hasConsensus())
    assert.strictEqual(common.consensusType(), 'dpos')
    assert.strictEqual(common.consensusAlgorithm(), 'dpos')
    assert.deepEqual(common.consensusConfig(), {})
    assert.deepEqual(common.genesis(), chain.genesis)
    copy.genesis().gasLimit = 2
    assert.strictEqual(common.genesis().gasLimit, 1)
    assert.strictEqual(chain.genesis!.gasLimit, 1)
    assert.isFalse(new Common({ chain: TronMainnet }).hasGenesis())
  })
})

describe.each([TronMainnet, TronNile, TronShasta])(
  '[Common]: configuration compatibility on $name',
  (base) => {
    it('compares complete metadata independently of object key order', () => {
      const genesis = {
        gasLimit: 1000000,
        difficulty: 0,
        nonce: '0x0000000000000000',
        extraData: '0x',
      } as const
      const consensus = {
        type: 'poa',
        algorithm: 'clique',
        clique: { period: 3, epoch: 30000 },
      }
      const chain = { ...base, genesis, consensus }
      const common = new Common({ chain })
      const reordered = new Common({
        chain: {
          ...base,
          genesis: {
            extraData: '0x',
            nonce: '0x0000000000000000',
            difficulty: 0,
            gasLimit: 1000000,
          },
          consensus: {
            clique: { epoch: 30000, period: 3 },
            algorithm: 'clique',
            type: 'poa',
          },
        },
      })
      assert.isTrue(common.isCompatibleWith(reordered))
      assert.isTrue(reordered.isCompatibleWith(common))

      for (const conflictingChain of [
        base,
        { ...base, genesis },
        { ...base, consensus },
        { ...chain, genesis: { ...genesis, gasLimit: 2000000 } },
        { ...chain, consensus: { ...consensus, clique: { period: 6, epoch: 30000 } } },
      ]) {
        const conflicting = new Common({ chain: conflictingChain })
        assert.isFalse(common.isCompatibleWith(conflicting))
        assert.isFalse(conflicting.isCompatibleWith(common))
      }
      assert.isTrue(common.isCompatibleWith(common.copy()))
    })

    it('compares active parameter values as defaults and optional capabilities are loaded', () => {
      const common = new Common({
        chain: base,
        params: { tron: { callGas: 40 }, 7939: { clzGas: 5 } },
      })
      const other = new Common({
        chain: base,
        params: { tron: { callGas: '40', balanceGas: 20 }, 7939: { clzGas: 7 } },
        eips: [607],
      })
      // Missing defaults and inactive parameter groups do not create conflicts.
      assert.isTrue(common.isCompatibleWith(other))
      assert.isTrue(other.isCompatibleWith(common))

      other.setEIPs([7939])
      assert.isFalse(common.isCompatibleWith(other))
      assert.isFalse(other.isCompatibleWith(common))
      common.setEIPs([7939])
      assert.isFalse(common.isCompatibleWith(other))
      assert.isFalse(other.isCompatibleWith(common))

      other.updateParams({ 7939: { clzGas: 5 } })
      assert.isTrue(common.isCompatibleWith(other))
      assert.isTrue(other.isCompatibleWith(common))
      other.updateParams({ tron: { callGas: 41 } })
      assert.isFalse(common.isCompatibleWith(other))
      assert.isFalse(other.isCompatibleWith(common))
      assert.strictEqual(common.param('callGas'), 40n)
    })
  },
)
