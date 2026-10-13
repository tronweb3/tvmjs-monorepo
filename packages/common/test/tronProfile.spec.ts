import { assert, describe, it } from 'vitest'

import {
  Common,
  Hardfork,
  Mainnet,
  TronMainnet,
  TronNile,
  TronShasta,
  createCurrentTronMainnetCommon,
  createTronChainIdCommon,
  tronExecutionProfile,
} from '../src/index.ts'

describe('[Common]: independent TRON execution profile', () => {
  for (const [chain, chainId] of [
    [TronMainnet, 728126428n],
    [TronNile, 3448148188n],
    [TronShasta, 2494104990n],
  ] as const) {
    it(`${chain.name}: execution configuration has no inherited network metadata`, () => {
      assert.notProperty(chain, 'genesis')
      assert.notProperty(chain, 'consensus')
      assert.notProperty(chain, 'depositContractAddress')
      const common = new Common({ chain })
      for (const instance of [common, common.copy()]) {
        assert.strictEqual(instance.chainId(), chainId)
        assert.isTrue(instance.isTron())
        assert.strictEqual(instance.hardfork(), Hardfork.Tron)
        assert.deepEqual(instance.hardforks(), [{ name: Hardfork.Tron, block: 0 }])
        assert.deepEqual(instance.bootstrapNodes(), [])
        assert.deepEqual(instance.dnsNetworks(), [])
        assert.isFalse(instance.hasGenesis())
        assert.isFalse(instance.hasConsensus())
        assert.throws(() => instance.genesis(), /Genesis metadata is not available/)
        assert.throws(() => instance.consensusType(), /Consensus metadata is not available/)
        assert.throws(() => instance.consensusAlgorithm(), /Consensus metadata is not available/)
        assert.throws(() => instance.consensusConfig(), /Consensus metadata is not available/)
      }
    })
  }

  it('rejects the old implicit Mainnet + tron mapping', () => {
    for (const chain of [Mainnet, { ...Mainnet }]) {
      assert.throws(
        // @ts-expect-error Selecting TRON does not make Ethereum data executable.
        () => new Common({ chain, hardfork: Hardfork.Tron }),
        /Use TronMainnet/,
      )
    }
  })

  it('cannot restore retired capabilities through proposals or explicit EIPs', () => {
    for (const activatedProposals of [[], [95], [96], [95, 96]]) {
      const common = new Common({ chain: TronMainnet, activatedProposals })
      for (const eip of [
        170, 2929, 3529, 3651, 3675, 3860, 4399, 4788, 4844, 4895, 7516, 7702, 7918,
      ]) {
        assert.isFalse(common.isActivatedEIP(eip), `EIP ${eip}`)
        assert.throws(() => common.setEIPs([eip]), /not supported by the TRON execution profile/)
        assert.isFalse(common.isActivatedEIP(eip))
      }
    }
  })

  it('owns EIP and schedule arrays and keeps profile definitions immutable', () => {
    const eips = [7939]
    const common = new Common({ chain: TronMainnet, eips })
    eips.push(4844)
    common.eips().push(4788)
    common.hardforks().push({ name: Hardfork.Cancun, block: 1 })
    assert.isFalse(common.isActivatedEIP(4844))
    assert.isFalse(common.isActivatedEIP(4788))
    assert.isFalse(common.gteHardfork(Hardfork.Cancun))
    assert.throws(() => common.setHardfork(Hardfork.Cancun), /not supported/)
    assert.throws(() => (tronExecutionProfile.eips as number[]).push(4844))
    assert.throws(() => (tronExecutionProfile.optionalEIPs as number[]).push(4844))
  })

  it('failed EIP changes preserve the previously active capabilities', () => {
    const common = new Common({ chain: TronMainnet, eips: [7939] })
    assert.throws(() => common.setEIPs([4844]), /not supported/)
    assert.deepEqual(common.eips(), [7939])
    assert.isTrue(common.isActivatedEIP(7939))
    common.setEIPs([])
    assert.isFalse(common.isActivatedEIP(7939))
  })

  it('copies crypto configuration without replacing shared implementation references', () => {
    const customCrypto = { keccak256: (_input: Uint8Array) => new Uint8Array(32) }
    const common = new Common({ chain: TronMainnet, customCrypto })
    const copy = common.copy()
    assert.strictEqual(copy.customCrypto.keccak256, customCrypto.keccak256)
    customCrypto.keccak256 = () => new Uint8Array(32).fill(1)
    assert.notStrictEqual(common.customCrypto.keccak256, customCrypto.keccak256)
    copy.customCrypto.keccak256 = customCrypto.keccak256
    assert.notStrictEqual(copy.customCrypto.keccak256, common.customCrypto.keccak256)
    assert.isFalse(common.isCompatibleWith(copy))
  })

  it('factory network selection cannot be replaced through untyped options', () => {
    const common = createTronChainIdCommon('nile', { chain: Mainnet } as any)
    assert.strictEqual(common.chainId(), 3448148188n)
    for (const network of ['invalid', '__proto__', 'toString']) {
      assert.throws(() => createTronChainIdCommon(network as any), /Invalid TRON network/)
    }
  })

  it('offers current mainnet execution settings with historical overrides', () => {
    const baseline = new Common({ chain: TronMainnet })
    const current = createCurrentTronMainnetCommon()
    assert.deepEqual(baseline.activatedProposals(), [65])
    assert.deepEqual(current.activatedProposals(), [65, 96])
    assert.isTrue(current.isActivatedEIP(7939))
    assert.strictEqual(current.chainId(), baseline.chainId())
    assert.deepEqual(createCurrentTronMainnetCommon().copy().activatedProposals(), [65, 96])
    assert.deepEqual(
      createCurrentTronMainnetCommon({ activatedProposals: undefined }).activatedProposals(),
      [65, 96],
    )

    const historical = createCurrentTronMainnetCommon({ activatedProposals: [], eips: [] })
    assert.deepEqual(historical.activatedProposals(), [])
    assert.isFalse(historical.isActivatedEIP(7939))
  })

  it('compares independent execution settings before VM initialization', () => {
    const common = new Common({ chain: TronMainnet, activatedProposals: [95, 96] })
    assert.isTrue(common.isCompatibleWith(common.copy()))
    assert.isTrue(
      common.isCompatibleWith(new Common({ chain: TronMainnet, activatedProposals: [96, 95] })),
    )
    assert.isFalse(
      common.isCompatibleWith(new Common({ chain: TronNile, activatedProposals: [95, 96] })),
    )
    assert.isFalse(
      common.isCompatibleWith(new Common({ chain: TronMainnet, activatedProposals: [95] })),
    )
    assert.isFalse(
      common.isCompatibleWith(
        new Common({ chain: TronMainnet, activatedProposals: [95, 96], eips: [7939] }),
      ),
    )
  })
})
