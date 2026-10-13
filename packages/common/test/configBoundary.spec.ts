import { assert, describe, expectTypeOf, it } from 'vitest'

import * as commonExports from '../src/index.ts'
import {
  Common,
  Mainnet,
  TronMainnet,
  TronNile,
  TronShasta,
  createCustomCommon,
} from '../src/index.ts'

import type {
  BaseOpts,
  ChainConfig,
  CustomChainConfig,
  GenesisBlockConfig,
  parseGethGenesis,
} from '../src/index.ts'

describe('TRON configuration boundaries', () => {
  it('separates executable configuration from Ethereum data in the public types', () => {
    expectTypeOf<ChainConfig['execution']>().toEqualTypeOf<'tron'>()
    expectTypeOf<Omit<ChainConfig, 'execution'>>().not.toMatchTypeOf<ChainConfig>()
    expectTypeOf<typeof Mainnet>().not.toMatchTypeOf<ChainConfig>()
    expectTypeOf<ReturnType<typeof parseGethGenesis>>().not.toMatchTypeOf<ChainConfig>()
    expectTypeOf<{
      chainId: number
      genesis: GenesisBlockConfig
    }>().not.toMatchTypeOf<CustomChainConfig>()
    expectTypeOf<ChainConfig>().not.toMatchTypeOf<CustomChainConfig>()
  })

  it('does not export the retired Geth execution constructor', () => {
    assert.notProperty(commonExports, 'createCommonFromGethGenesis')
    assert.isFunction(commonExports.parseGethGenesis)
    assert.isFunction(commonExports.parseGethGenesisState)
  })

  for (const base of [TronMainnet, TronNile, TronShasta]) {
    describe(base.name, () => {
      it('preserves TRON execution while customizing identity and discovery data', () => {
        const overrides = Object.freeze({
          name: 'private-tron',
          chainId: 123,
          comment: 'Local execution simulation',
          url: 'https://example.invalid',
          bootstrapNodes: [],
          dnsNetworks: ['example.invalid'],
        })
        const common = createCustomCommon(overrides, base, {
          eips: [7939],
          activatedProposals: [95, 96],
          params: { tron: { testValue: 9 } },
        })
        assert.strictEqual(common.chainId(), 123n)
        assert.strictEqual(common.chainName(), overrides.name)
        assert.strictEqual(common.hardfork(), 'tron')
        assert.deepEqual(common.bootstrapNodes(), [])
        assert.deepEqual(common.dnsNetworks(), overrides.dnsNetworks)
        assert.isTrue(common.isActivatedEIP(7939))
        assert.isFalse(common.isActivatedEIP(2929))
        assert.strictEqual(common.param('testValue'), 9n)
        assert.deepEqual(common.activatedProposals(), [95, 96])
        assert.isFalse(common.hasGenesis())
        assert.isFalse(common.hasConsensus())
        common.dnsNetworks()!.push('copy.invalid')
        assert.deepEqual(overrides.dnsNetworks, ['example.invalid'])
        assert.strictEqual(new Common({ chain: base }).chainId(), BigInt(base.chainId))
      })

      it.each([
        ['genesis', Mainnet.genesis],
        ['genesis', undefined],
        ['consensus', Mainnet.consensus],
        ['consensus', { type: 'custom', algorithm: 'test' }],
        ['execution', 'tron'],
        ['defaultHardfork', 'tron'],
        ['hardforks', base.hardforks],
        ['customHardforks', {}],
        ['depositContractAddress', '0x0000000000000000000000000000000000000000'],
      ])('rejects a %s override (%j)', (field, value) => {
        const overrides = { [field as string]: value } as CustomChainConfig
        assert.throws(
          () => createCustomCommon(overrides, base),
          `createCustomCommon() cannot override ${field}`,
        )
      })

      it('rejects a missing or invalid execution marker at runtime', () => {
        for (const execution of [undefined, 'ethereum']) {
          const chain = { ...base, execution } as unknown as ChainConfig
          assert.throws(() => new Common({ chain }), /Only TRON execution configurations/)
          assert.throws(() => createCustomCommon({ chainId: 123 }, chain), /Only TRON execution/)
        }
      })

      it('rejects attempts to replace the base through options', () => {
        for (const opts of [{ chain: TronNile }, Object.create({ chain: Mainnet })]) {
          assert.throws(
            () => createCustomCommon({ chainId: 123 }, base, opts as BaseOpts),
            /options cannot override the base chain/,
          )
        }
      })

      it('preserves explicit metadata through a complete configuration', () => {
        const chain: ChainConfig = {
          ...base,
          name: 'local-metadata-fixture',
          genesis: {
            gasLimit: 1000000,
            difficulty: 0,
            nonce: '0x0000000000000000',
            extraData: '0x',
          },
          consensus: { type: 'custom', algorithm: 'test' },
        }
        const common = new Common({ chain })
        const copy = common.copy()
        assert.isTrue(common.hasGenesis())
        assert.isTrue(common.hasConsensus())
        assert.isTrue(common.isCompatibleWith(copy))
        assert.isFalse(common.isCompatibleWith(new Common({ chain: base })))
        assert.strictEqual(common.consensusAlgorithm(), 'test')
        const custom = createCustomCommon({ name: 'renamed-fixture' }, chain)
        assert.deepEqual(custom.genesis(), common.genesis())
        assert.strictEqual(custom.consensusType(), 'custom')
        custom.genesis().gasLimit = 1
        assert.strictEqual(chain.genesis!.gasLimit, 1000000)
        assert.strictEqual(common.genesis().gasLimit, 1000000)
      })
    })
  }

  it('rejects hidden or inherited metadata and unknown own override keys', () => {
    for (const overrides of [
      Object.create({ genesis: Mainnet.genesis }),
      Object.defineProperty({}, 'consensus', { value: Mainnet.consensus }),
      Object.create(Object.defineProperty({}, 'genesis', { value: Mainnet.genesis })),
      { unexpected: 1 },
      { [Symbol('metadata')]: Mainnet.genesis },
      { toJSON: () => ({ ...Mainnet }) },
    ]) {
      assert.throws(
        () => createCustomCommon(overrides, TronMainnet),
        /createCustomCommon\(\) cannot override/,
      )
    }
  })

  it('rejects non-object overrides and accepts a plain dictionary without a prototype', () => {
    for (const invalid of [null, undefined, 123, 'tron', []]) {
      assert.throws(
        () => createCustomCommon(invalid as CustomChainConfig, TronMainnet),
        /overrides must be an object/,
      )
    }
    const overrides = Object.assign(Object.create(null), { chainId: 123 })
    assert.strictEqual(createCustomCommon(overrides, TronMainnet).chainId(), 123n)
  })

  it('rejects non-array activatedProposals', () => {
    for (const invalid of [123, '65', new Set([65]), {}]) {
      assert.throws(
        () => new Common({ chain: TronMainnet, activatedProposals: invalid as any }),
        /activatedProposals must be an array of proposal IDs/,
      )
    }
  })
})
