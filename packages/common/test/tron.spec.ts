import { shanghaiTimeGethGenesis } from '@tvmjs/testdata'
import { assert, describe, it } from 'vitest'

import {
  Common,
  TronMainnet,
  TronNile,
  TronShasta,
  createCustomCommon,
  parseGethGenesis,
  tronProposalsDict,
} from '../src/index.ts'

describe('[Common]: TRON proposal gating state', () => {
  it('should default mainnet to proposal 65', () => {
    const c = new Common({ chain: TronMainnet })
    assert.deepEqual(c.activatedProposals(), [65])
    assert.isTrue(c.isActivatedProposal(65))
    assert.isFalse(c.isActivatedProposal(95))
    assert.isFalse(c.isActivatedProposal(96))
  })

  it('should default Nile to proposal 65', () => {
    const c = new Common({ chain: TronNile })
    assert.deepEqual(c.activatedProposals(), [65])
    assert.isTrue(c.isActivatedProposal(65))
  })

  it('should default Shasta to proposal 65', () => {
    const c = new Common({ chain: TronShasta })
    assert.deepEqual(c.activatedProposals(), [65])
    assert.isTrue(c.isActivatedProposal(65))
  })

  it('should allow historical execution to clear mainnet defaults', () => {
    const c = new Common({ chain: TronMainnet, activatedProposals: [] })
    assert.deepEqual(c.activatedProposals(), [])
    assert.isFalse(c.isActivatedProposal(65))
  })

  it('should allow historical execution to clear Nile defaults', () => {
    const c = new Common({ chain: TronNile, activatedProposals: [] })
    assert.deepEqual(c.activatedProposals(), [])
    assert.isFalse(c.isActivatedProposal(65))
  })

  it('should allow historical execution to clear Shasta defaults', () => {
    const c = new Common({ chain: TronShasta, activatedProposals: [] })
    assert.deepEqual(c.activatedProposals(), [])
    assert.isFalse(c.isActivatedProposal(65))
  })

  it('should activate proposal 95 only', () => {
    const c = new Common({ chain: TronMainnet, activatedProposals: [95] })
    assert.isTrue(c.isActivatedProposal(95))
    assert.isFalse(c.isActivatedProposal(96))
    assert.deepEqual(c.activatedProposals(), [95])
  })

  it('should activate proposal 96 only', () => {
    const c = new Common({ chain: TronMainnet, activatedProposals: [96] })
    assert.isFalse(c.isActivatedProposal(95))
    assert.isTrue(c.isActivatedProposal(96))
    assert.deepEqual(c.activatedProposals(), [96])
  })

  it('should activate proposals 95 and 96 together', () => {
    const c = new Common({ chain: TronMainnet, activatedProposals: [96, 95] })
    assert.isTrue(c.isActivatedProposal(95))
    assert.isTrue(c.isActivatedProposal(96))
    assert.deepEqual(c.activatedProposals(), [95, 96], 'should be stored in ascending order')
  })

  it('should deduplicate repeated IDs', () => {
    const c = new Common({ chain: TronMainnet, activatedProposals: [96, 95, 96, 95, 95] })
    assert.deepEqual(c.activatedProposals(), [95, 96])
  })

  it('should throw on unknown or invalid IDs at instantiation', () => {
    for (const invalid of [[999], [0], [-95], [95.5], [Number.MAX_SAFE_INTEGER + 1]]) {
      assert.throws(
        () => new Common({ chain: TronMainnet, activatedProposals: invalid }),
        undefined,
        undefined,
        `should throw for activatedProposals: [${invalid}]`,
      )
    }
  })

  it('should return false for unknown IDs on query', () => {
    const c = new Common({ chain: TronMainnet, activatedProposals: [95] })
    assert.isFalse(c.isActivatedProposal(999))
    assert.isFalse(c.isActivatedProposal(0))
  })

  it('should not be affected by external modification of the returned array', () => {
    const c = new Common({ chain: TronMainnet, activatedProposals: [95] })
    const external = c.activatedProposals()
    external.push(96)
    external.length = 0
    assert.deepEqual(c.activatedProposals(), [95], 'internal state should stay unchanged')
    assert.isFalse(c.isActivatedProposal(96))
  })

  it('should keep proposal state independent between copies', () => {
    const c = new Common({ chain: TronMainnet, activatedProposals: [95] })
    const copied = c.copy()
    assert.deepEqual(copied.activatedProposals(), [95], 'copy should carry the proposal state')
    // biome-ignore lint/complexity/useLiteralKeys: accessing protected state for isolation check
    ;(copied as any)['_activatedProposals'].push(96)
    assert.deepEqual(c.activatedProposals(), [95], 'original should not see copy mutations')
  })

  it('should not alter EIPs, params or hardfork state when proposals are activated', () => {
    const base = new Common({ chain: TronMainnet })
    const withProposals = new Common({ chain: TronMainnet, activatedProposals: [95, 96] })
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

  it('should register proposals 65/95/96 in tronProposalsDict', () => {
    assert.strictEqual(tronProposalsDict[65].name, 'ALLOW_HIGHER_LIMIT_FOR_MAX_CPU_TIME_OF_ONE_TX')
    assert.strictEqual(tronProposalsDict[95].name, 'ALLOW_TVM_PRAGUE')
    assert.strictEqual(tronProposalsDict[96].name, 'ALLOW_TVM_OSAKA')
  })

  it('should pass activatedProposals through createCustomCommon()', () => {
    const c = createCustomCommon({ chainId: 123 }, TronMainnet, { activatedProposals: [95, 96] })
    assert.isTrue(c.isActivatedProposal(95))
    assert.isTrue(c.isActivatedProposal(96))
    assert.deepEqual(c.activatedProposals(), [95, 96])
    const without = createCustomCommon({ chainId: 123 }, TronMainnet)
    assert.deepEqual(without.activatedProposals(), [65], 'should inherit the base-chain default')
  })

  it('rejects Ethereum genesis configuration even when TRON proposals are supplied', () => {
    assert.throws(
      () =>
        new Common({
          // @ts-expect-error Governance options do not turn raw Ethereum data into TRON config.
          chain: parseGethGenesis(shanghaiTimeGethGenesis, 'withdrawals'),
          activatedProposals: [95],
        }),
      /Only TRON execution configurations/,
    )
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
