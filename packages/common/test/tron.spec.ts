import { shanghaiTimeGethGenesis } from '@tvmjs/testdata'
import { assert, describe, it } from 'vitest'

import { tronHardforksDict } from '../src/hardforks.ts'
import {
  Common,
  Hardfork,
  Mainnet,
  TronMainnet,
  TronNile,
  TronShasta,
  createCommonFromGethGenesis,
  createCustomCommon,
  createTronChainIdCommon,
  tronProposalsDict,
} from '../src/index.ts'

import { paramsTest } from './data/paramsTest.ts'

import type { ChainConfig } from '../src/index.ts'

describe('[Common]: custom hardfork overlay resolution', () => {
  // Ethereum Mainnet has no TRON overlay and resolves from hardforksDict.
  const controlChain: ChainConfig = { ...Mainnet }
  delete controlChain.customHardforks

  const withDict = new Common({ chain: Mainnet })
  const control = new Common({ chain: controlChain })

  it('should keep the hardfork sequence identical', () => {
    assert.deepEqual(
      withDict.hardforks().map((hf) => hf.name),
      control.hardforks().map((hf) => hf.name),
      'hardfork sequence should match the Ethereum control',
    )
    assert.strictEqual(withDict.hardfork(), control.hardfork(), 'default hardfork should match')
  })

  it('should keep EIP activation results identical on every hardfork', () => {
    // All EIPs referenced anywhere in the hardfork sequence plus prominent ones
    const eipsToCheck = [
      1, 606, 607, 608, 609, 1013, 1153, 1559, 1679, 1716, 2384, 2537, 2565, 2718, 2929, 2930, 3198,
      3529, 3541, 3651, 3675, 3855, 3860, 4399, 4788, 4844, 4895, 5656, 6780, 7516, 7702,
    ]
    for (const hf of control.hardforks()) {
      const a = withDict.copy()
      const b = control.copy()
      a.setHardfork(hf.name)
      b.setHardfork(hf.name)
      for (const eip of eipsToCheck) {
        assert.strictEqual(
          a.isActivatedEIP(eip),
          b.isActivatedEIP(eip),
          `EIP-${eip} activation should match on hardfork ${hf.name}`,
        )
      }
    }
  })

  it('should keep the params cache and activated EIPs cache identical', () => {
    assert.deepEqual(
      (withDict as any)['_paramsCache'],
      (control as any)['_paramsCache'],
      'params cache should match the Ethereum control',
    )
    assert.deepEqual(
      (withDict as any)['_activatedEIPsCache'],
      (control as any)['_activatedEIPsCache'],
      'activated EIPs cache should match the Ethereum control',
    )
  })

  it('should resolve the full HARDFORK_CHANGES config identically to the control', () => {
    // Stronger than per-EIP checks: guards the entire resolved config
    // (eips, params, consensus) for every hardfork in the Mainnet sequence.
    assert.deepEqual(
      (withDict as any)['HARDFORK_CHANGES'],
      (control as any)['HARDFORK_CHANGES'],
      'resolved hardfork config must be byte-identical with and without tronHardforksDict',
    )
  })

  it('should keep param() results identical after injecting real params', () => {
    const withParams = new Common({ chain: Mainnet, params: paramsTest })
    const controlWithParams = new Common({ chain: controlChain, params: paramsTest })
    const paramKeys = ['minerReward', 'bn254AddGas', 'netSstoreNoopGas']
    for (const hf of controlWithParams.hardforks()) {
      for (const key of paramKeys) {
        // param() throws for keys with no config on the active hardfork;
        // compare the outcome (value or throw) on both instances.
        let aResult: bigint | string
        let bResult: bigint | string
        try {
          aResult = withParams.paramByHardfork(key, hf.name).toString()
        } catch {
          aResult = 'throw'
        }
        try {
          bResult = controlWithParams.paramByHardfork(key, hf.name).toString()
        } catch {
          bResult = 'throw'
        }
        assert.strictEqual(
          aResult,
          bResult,
          `param(${key}) on hardfork ${hf.name} should match with and without tronHardforksDict`,
        )
      }
    }
  })

  it('should actually take the customHardforks overlay branch (not silently fall back)', () => {
    // Proves the overlay path in the Common constructor is exercised: a custom
    // dict that overrides cancun with a distinct EIP set must win over
    // hardforksDict, while a hardfork absent from it (berlin) still falls back.
    const overlayChain: ChainConfig = {
      ...Mainnet,
      customHardforks: {
        ...tronHardforksDict,
        cancun: { eips: [1153] }, // drop 4844/4788/5656/6780/7516 vs. ethereum cancun
      },
    }
    const overlay = new Common({ chain: overlayChain })
    overlay.setHardfork('cancun')
    assert.isTrue(overlay.isActivatedEIP(1153), 'overridden cancun should keep EIP-1153')
    assert.isFalse(
      overlay.isActivatedEIP(4844),
      'overridden cancun should NOT activate EIP-4844 (overlay branch taken)',
    )
    // berlin is absent from the overlay dict -> must fall back to hardforksDict
    overlay.setHardfork('berlin')
    assert.isTrue(overlay.isActivatedEIP(2929), 'berlin should fall back to hardforksDict EIPs')
  })
})

describe('[Common]: TRON proposal gating state', () => {
  it('should default to no activated proposals', () => {
    const c = new Common({ chain: Mainnet })
    assert.deepEqual(c.activatedProposals(), [], 'no proposal should be activated by default')
    assert.isFalse(c.isActivatedProposal(95))
    assert.isFalse(c.isActivatedProposal(96))
  })

  it('should activate proposal 95 only', () => {
    const c = new Common({ chain: Mainnet, activatedProposals: [95] })
    assert.isTrue(c.isActivatedProposal(95))
    assert.isFalse(c.isActivatedProposal(96))
    assert.deepEqual(c.activatedProposals(), [95])
  })

  it('should activate proposal 96 only', () => {
    const c = new Common({ chain: Mainnet, activatedProposals: [96] })
    assert.isFalse(c.isActivatedProposal(95))
    assert.isTrue(c.isActivatedProposal(96))
    assert.deepEqual(c.activatedProposals(), [96])
  })

  it('should activate proposals 95 and 96 together', () => {
    const c = new Common({ chain: Mainnet, activatedProposals: [96, 95] })
    assert.isTrue(c.isActivatedProposal(95))
    assert.isTrue(c.isActivatedProposal(96))
    assert.deepEqual(c.activatedProposals(), [95, 96], 'should be stored in ascending order')
  })

  it('should deduplicate repeated IDs', () => {
    const c = new Common({ chain: Mainnet, activatedProposals: [96, 95, 96, 95, 95] })
    assert.deepEqual(c.activatedProposals(), [95, 96])
  })

  it('should throw on unknown or invalid IDs at instantiation', () => {
    for (const invalid of [[999], [0], [-95], [95.5], [Number.MAX_SAFE_INTEGER + 1]]) {
      assert.throws(
        () => new Common({ chain: Mainnet, activatedProposals: invalid }),
        undefined,
        undefined,
        `should throw for activatedProposals: [${invalid}]`,
      )
    }
  })

  it('should return false for unknown IDs on query', () => {
    const c = new Common({ chain: Mainnet, activatedProposals: [95] })
    assert.isFalse(c.isActivatedProposal(999))
    assert.isFalse(c.isActivatedProposal(0))
  })

  it('should not be affected by external modification of the returned array', () => {
    const c = new Common({ chain: Mainnet, activatedProposals: [95] })
    const external = c.activatedProposals()
    external.push(96)
    external.length = 0
    assert.deepEqual(c.activatedProposals(), [95], 'internal state should stay unchanged')
    assert.isFalse(c.isActivatedProposal(96))
  })

  it('should keep proposal state independent between copies', () => {
    const c = new Common({ chain: Mainnet, activatedProposals: [95] })
    const copied = c.copy()
    assert.deepEqual(copied.activatedProposals(), [95], 'copy should carry the proposal state')
    // biome-ignore lint/complexity/useLiteralKeys: accessing protected state for isolation check
    ;(copied as any)['_activatedProposals'].push(96)
    assert.deepEqual(c.activatedProposals(), [95], 'original should not see copy mutations')
  })

  it('should not alter EIPs, params or hardfork state when proposals are activated', () => {
    const base = new Common({ chain: Mainnet })
    const withProposals = new Common({ chain: Mainnet, activatedProposals: [95, 96] })
    assert.strictEqual(withProposals.hardfork(), base.hardfork())
    for (const eip of [1153, 2929, 2935, 4844, 5656, 7516, 7823, 7883, 7939, 7951]) {
      assert.strictEqual(
        withProposals.isActivatedEIP(eip),
        base.isActivatedEIP(eip),
        `EIP-${eip} activation should not change`,
      )
    }
    assert.deepEqual(
      (withProposals as any)['_paramsCache'],
      (base as any)['_paramsCache'],
      'params cache should not change when proposals are activated',
    )
    assert.isFalse(
      withProposals.isActivatedEIP(7939),
      'Proposal 96 must not activate EIP-7939 until proposal behavior is wired',
    )
  })

  it('should register proposals 95/96 in tronProposalsDict', () => {
    assert.strictEqual(tronProposalsDict[95].name, 'ALLOW_TVM_PRAGUE')
    assert.strictEqual(tronProposalsDict[96].name, 'ALLOW_TVM_OSAKA')
  })

  it('should pass activatedProposals through createCustomCommon()', () => {
    const c = createCustomCommon({ chainId: 123 }, Mainnet, { activatedProposals: [95, 96] })
    assert.isTrue(c.isActivatedProposal(95))
    assert.isTrue(c.isActivatedProposal(96))
    assert.deepEqual(c.activatedProposals(), [95, 96])
    const without = createCustomCommon({ chainId: 123 }, Mainnet)
    assert.deepEqual(without.activatedProposals(), [], 'should stay empty when not passed')
  })

  it('should pass activatedProposals through createCommonFromGethGenesis()', () => {
    const c = createCommonFromGethGenesis(shanghaiTimeGethGenesis, {
      chain: 'withdrawals',
      activatedProposals: [95],
    })
    assert.isTrue(c.isActivatedProposal(95))
    assert.isFalse(c.isActivatedProposal(96))
    assert.deepEqual(c.activatedProposals(), [95])
    const without = createCommonFromGethGenesis(shanghaiTimeGethGenesis, {
      chain: 'withdrawals',
    })
    assert.deepEqual(without.activatedProposals(), [], 'should stay empty when not passed')
  })

  it('should keep tronProposalsDict immutable (frozen)', () => {
    assert.isTrue(Object.isFrozen(tronProposalsDict), 'dict itself should be frozen')
    assert.isTrue(Object.isFrozen(tronProposalsDict[95]), 'each entry should be frozen')
    // Mutations must not take effect (throw in strict mode / silently ignored otherwise)
    assert.throws(() => {
      ;(tronProposalsDict as any)[97] = { name: 'ALLOW_TVM_FUTURE' }
    })
    assert.throws(() => {
      ;(tronProposalsDict[95] as any).name = 'MUTATED'
    })
    assert.isUndefined((tronProposalsDict as any)[97], 'new key must not be added')
    assert.strictEqual(tronProposalsDict[95].name, 'ALLOW_TVM_PRAGUE', 'name must be unchanged')
  })
})

describe('[Common]: TRON execution profile identity', () => {
  it('identifies every TRON preset independently of the selected hardfork', () => {
    for (const chain of [TronMainnet, TronNile, TronShasta]) {
      assert.isTrue(new Common({ chain }).isTron())
      assert.isTrue(new Common({ chain, hardfork: Hardfork.Shanghai }).isTron())
    }
  })

  it('does not identify Ethereum Mainnet as TRON', () => {
    assert.isFalse(new Common({ chain: Mainnet }).isTron())
    assert.isFalse(new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai }).isTron())
  })

  it('identifies the normalized legacy Mainnet + tron form and its copies', () => {
    const legacy = new Common({ chain: Mainnet, hardfork: Hardfork.Tron })
    assert.isTrue(legacy.isTron())
    assert.isTrue(legacy.copy().isTron())
  })
})

describe('[Common]: TRON network chainId presets (execution-only)', () => {
  const mainnetBaseline = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
  it('should expose named execution-only chain configurations', () => {
    const configs = [
      [TronMainnet, 'tron-mainnet', 728126428n],
      [TronNile, 'tron-nile', 3448148188n],
      [TronShasta, 'tron-shasta', 2494104990n],
    ] as const

    for (const [chain, name, chainId] of configs) {
      const common = new Common({ chain })
      assert.strictEqual(common.chainName(), name)
      assert.strictEqual(common.chainId(), chainId)
      assert.strictEqual(chain.defaultHardfork, 'tron')
      assert.strictEqual(chain.customHardforks, tronHardforksDict)
      assert.deepEqual(chain.bootstrapNodes, [])
      assert.deepEqual(chain.dnsNetworks, [])
      assert.isUndefined(chain.url)
      assert.isUndefined(chain.depositContractAddress)
    }
  })

  it('should return correct chainId for each TRON network', () => {
    const mainnet = createTronChainIdCommon('mainnet')
    assert.strictEqual(mainnet.chainId(), 728126428n, 'mainnet chainId should be 728126428')
    assert.strictEqual(mainnet.chainName(), 'tron-mainnet')

    const nile = createTronChainIdCommon('nile')
    assert.strictEqual(nile.chainId(), 3448148188n, 'nile chainId should be 3448148188')
    assert.strictEqual(nile.chainName(), 'tron-nile')

    const shasta = createTronChainIdCommon('shasta')
    assert.strictEqual(shasta.chainId(), 2494104990n, 'shasta chainId should be 2494104990')
    assert.strictEqual(shasta.chainName(), 'tron-shasta')
  })

  it('should not allow an untyped chain option to replace the selected TRON preset', () => {
    const common = createTronChainIdCommon('mainnet', { chain: Mainnet } as any)
    assert.strictEqual(common.chainId(), 728126428n)
    assert.strictEqual(common.chainName(), 'tron-mainnet')
  })

  it('should keep Ethereum Mainnet chainId unchanged', () => {
    const ethMainnet = new Common({ chain: Mainnet })
    assert.strictEqual(ethMainnet.chainId(), 1n, 'Mainnet chainId should stay 1 (Ethereum)')
    assert.strictEqual(ethMainnet.chainName(), 'mainnet')
  })

  it('should normalize the legacy Mainnet + tron call to TronMainnet', () => {
    const legacy = new Common({ chain: Mainnet, hardfork: 'tron' })
    const recommended = new Common({ chain: TronMainnet })

    assert.strictEqual(legacy.chainId(), 728126428n)
    assert.strictEqual(legacy.chainName(), 'tron-mainnet')
    assert.strictEqual(legacy.hardfork(), Hardfork.Tron)
    assert.deepEqual(legacy.hardforks(), recommended.hardforks())
    assert.deepEqual(legacy.activatedProposals(), [])
  })

  it('should keep the legacy normalization scoped to the exported Mainnet preset', () => {
    assert.throws(
      () => new Common({ chain: { ...Mainnet }, hardfork: Hardfork.Tron }),
      /Hardfork with name tron not supported/,
    )
  })

  it('should preserve proposal options when normalizing the legacy TRON call', () => {
    const legacy = new Common({
      chain: Mainnet,
      hardfork: Hardfork.Tron,
      activatedProposals: [96],
    })

    assert.isTrue(legacy.isActivatedProposal(96))
    assert.strictEqual(legacy.chainId(), 728126428n)
  })

  it('should extend the Ethereum hardfork sequence with the TRON execution hardfork', () => {
    const tron = createTronChainIdCommon('mainnet')
    const ethereum = new Common({ chain: Mainnet })
    assert.strictEqual(ethereum.hardfork(), Hardfork.Prague)
    assert.isFalse(ethereum.hardforks().some((hf) => hf.name === Hardfork.Tron))
    assert.isUndefined(Mainnet.customHardforks)
    assert.strictEqual(tron.hardfork(), Hardfork.Tron)
    assert.deepEqual(
      tron.hardforks().slice(0, -1),
      ethereum
        .hardforks()
        .filter((hardfork) =>
          (
            [
              Hardfork.Chainstart,
              Hardfork.Homestead,
              Hardfork.Dao,
              Hardfork.TangerineWhistle,
              Hardfork.SpuriousDragon,
              Hardfork.Byzantium,
              Hardfork.Constantinople,
              Hardfork.Petersburg,
              Hardfork.Istanbul,
              Hardfork.Berlin,
              Hardfork.London,
              Hardfork.Paris,
              Hardfork.Shanghai,
              Hardfork.Cancun,
            ] as Hardfork[]
          ).includes(hardfork.name as Hardfork),
        ),
    )
    assert.strictEqual(tron.hardforks().at(-1)?.name, Hardfork.Tron)
    assert.isFalse(tron.hardforks().some((hardfork) => hardfork.name === Hardfork.Prague))
  })

  it('should inherit consensus type and algorithm from Mainnet baseline', () => {
    const tron = createTronChainIdCommon('mainnet')
    assert.strictEqual(
      tron.consensusType(),
      mainnetBaseline.consensusType(),
      'consensus type should match Mainnet',
    )
    assert.strictEqual(
      tron.consensusAlgorithm(),
      mainnetBaseline.consensusAlgorithm(),
      'consensus algorithm should match Mainnet',
    )
  })

  it('should inherit EIP activations from Mainnet baseline', () => {
    const tron = createTronChainIdCommon('mainnet')
    const eipsToCheck = [1153, 1559, 2929, 2930, 3198, 3529, 3541, 3651, 3855, 3860]
    for (const eip of eipsToCheck) {
      assert.strictEqual(
        tron.isActivatedEIP(eip),
        mainnetBaseline.isActivatedEIP(eip),
        `EIP-${eip} activation should match Mainnet baseline`,
      )
    }
  })

  it('should inherit execution configuration but omit Mainnet network discovery data', () => {
    const tron = createTronChainIdCommon('mainnet')
    const baseline = mainnetBaseline.copy()

    // Execution-only fields still use the Mainnet baseline.
    assert.deepEqual(tron.genesis(), baseline.genesis(), 'genesis should match')
    assert.deepEqual(
      tron.consensusConfig(),
      baseline.consensusConfig(),
      'consensusConfig should match',
    )

    // Ethereum network discovery data must not leak into a named TRON preset.
    assert.deepEqual(tron.bootstrapNodes(), [])
    assert.deepEqual(tron.dnsNetworks(), [])

    assert.notStrictEqual(tron.chainId(), baseline.chainId(), 'chainId should differ')
    assert.notStrictEqual(tron.chainName(), baseline.chainName(), 'chainName should differ')
  })

  it('should return independent Common instances on each call', () => {
    const a = createTronChainIdCommon('mainnet')
    const b = createTronChainIdCommon('mainnet')
    assert.notStrictEqual(a, b, 'each call should return a new instance')
    assert.strictEqual(a.chainId(), b.chainId(), 'but both should have the same chainId')
  })

  it('should throw on invalid network name at runtime', () => {
    assert.throws(
      () => createTronChainIdCommon('invalid' as any),
      /Invalid TRON network: invalid/,
      'should throw with clear error message',
    )
  })

  it('should throw on inherited property names (prototype pollution guard)', () => {
    assert.throws(
      () => createTronChainIdCommon('toString' as any),
      /Invalid TRON network: toString/,
      'should reject toString',
    )
    assert.throws(
      () => createTronChainIdCommon('__proto__' as any),
      /Invalid TRON network: __proto__/,
      'should reject __proto__',
    )
  })

  it('should pass through activatedProposals option', () => {
    const withProposals = createTronChainIdCommon('mainnet', { activatedProposals: [95, 96] })
    assert.isTrue(withProposals.isActivatedProposal(95))
    assert.isTrue(withProposals.isActivatedProposal(96))
    assert.deepEqual(withProposals.activatedProposals(), [95, 96])

    const withoutProposals = createTronChainIdCommon('mainnet')
    assert.deepEqual(withoutProposals.activatedProposals(), [], 'should default to empty')
  })

  it('should pass through hardfork option', () => {
    const onCancun = createTronChainIdCommon('mainnet', { hardfork: 'cancun' })
    assert.strictEqual(onCancun.hardfork(), 'cancun', 'should use specified hardfork')
    assert.strictEqual(onCancun.chainId(), 728126428n, 'chainId should still be correct')
  })
})
