import { assert, describe, it } from 'vitest'

import { Common, Hardfork, TronMainnet } from '../src/index.ts'
import { paramsTest } from './data/paramsTest.ts'

describe('[Common]: TRON parameters', () => {
  it('merges and resets shared parameter dictionaries without modifying input', () => {
    const common = new Common({ chain: TronMainnet, params: paramsTest })
    assert.strictEqual(common.param('bn254AddGas'), 150n)
    assert.strictEqual(common.paramByEIP('bn254AddGas', 1679), 150n)
    common.updateParams({ 1679: { bn254AddGas: 250 } })
    assert.strictEqual(common.param('bn254AddGas'), 250n)
    assert.strictEqual(paramsTest[1679].bn254AddGas, 150)
    common.resetParams({ 1679: { bn254AddGas: 350 } })
    assert.strictEqual(common.param('bn254AddGas'), 350n)
    assert.throws(() => common.param('netSstoreNoopGas'), /Missing parameter/)
  })

  it('uses profile overrides consistently across direct, profile and block queries', () => {
    const common = new Common({
      chain: TronMainnet,
      params: { ...paramsTest, tron: { bn254AddGas: 200 } },
    })
    assert.strictEqual(common.param('bn254AddGas'), 200n)
    assert.strictEqual(common.paramByHardfork('bn254AddGas', Hardfork.Tron), 200n)
    assert.strictEqual(common.paramByBlock('bn254AddGas', 0), 200n)
    assert.strictEqual(common.paramByBlock('bn254AddGas', 4370000, 1710338135), 200n)
    assert.throws(() => common.paramByHardfork('bn254AddGas', Hardfork.Byzantium), /not supported/)
    assert.strictEqual(common.param('netSstoreNoopGas'), 0n)
  })

  it('applies explicitly selected capability parameters after profile defaults', () => {
    const params = { 1: { testValue: 1 }, tron: { testValue: 2 }, 7939: { testValue: 3 } }
    const common = new Common({ chain: TronMainnet, params, eips: [7939] })
    assert.strictEqual(common.param('testValue'), 3n)
    assert.strictEqual(common.paramByHardfork('testValue', Hardfork.Tron), 2n)
    assert.strictEqual(common.paramByEIP('testValue', 7939), 3n)
    const copy = common.copy()
    copy.setEIPs([])
    copy.updateParams({ tron: { testValue: 4 } })
    assert.strictEqual(copy.param('testValue'), 4n)
    assert.strictEqual(common.param('testValue'), 3n)
    assert.strictEqual(params.tron.testValue, 2)
  })

  it('reports missing parameters and unknown EIPs', () => {
    const common = new Common({ chain: TronMainnet, params: paramsTest })
    assert.throws(() => common.param('unknown'), /Missing parameter/)
    assert.throws(() => common.paramByHardfork('unknown', Hardfork.Tron), /Missing parameter/)
    assert.throws(() => common.paramByEIP('unknown', 7939), /Missing parameter/)
    assert.throws(() => common.paramByEIP('unknown', 999999), /not supported/)
  })

  it('keeps TRON pricing when an already active capability is explicitly selected', () => {
    const common = new Common({
      chain: TronMainnet,
      params: { 2930: { accessListAddressGas: 2400 }, tron: { accessListAddressGas: 0 } },
      eips: [2930],
    })
    assert.strictEqual(common.param('accessListAddressGas'), 0n)
    assert.strictEqual(common.copy().param('accessListAddressGas'), 0n)
    assert.strictEqual(common.paramByHardfork('accessListAddressGas', Hardfork.Tron), 0n)
  })

  it('loads defaults without replacing caller overrides when requested', () => {
    const common = new Common({ chain: TronMainnet, params: { tron: { balanceGas: 21 } } })
    const defaults = { tron: { balanceGas: 20, sloadGas: 50 } }
    common.updateParams(defaults, false)
    assert.strictEqual(common.param('balanceGas'), 21n)
    assert.strictEqual(common.param('sloadGas'), 50n)
    common.updateParams({ tron: { balanceGas: 22 } })
    assert.strictEqual(common.param('balanceGas'), 22n)
    assert.deepEqual(defaults, { tron: { balanceGas: 20, sloadGas: 50 } })
  })

  it('queries supported optional parameters without activating the capability', () => {
    const common = new Common({ chain: TronMainnet, params: { 7939: { clzGas: 5 } } })
    assert.isFalse(common.isActivatedEIP(7939))
    assert.strictEqual(common.paramByEIP('clzGas', 7939), 5n)
    assert.isFalse(common.isActivatedEIP(7939))
    assert.deepEqual(common.eips(), [])
    assert.throws(() => common.param('clzGas'), /Missing parameter/)

    common.setEIPs([7939])
    assert.strictEqual(common.param('clzGas'), 5n)
  })

  it.each([2929, 3529, 3651, 4788, 4844, 4895, 7516, 7702])(
    'rejects parameter queries and activation for retired EIP %s even when parameters exist',
    (eip) => {
      const common = new Common({
        chain: TronMainnet,
        params: { [eip]: { testValue: 7 } },
        eips: [7939],
      })
      const message = `EIP ${eip} is not supported by the TRON execution profile`
      assert.throws(() => common.paramByEIP('testValue', eip), message)
      assert.throws(() => common.setEIPs([eip]), message)
      assert.deepEqual(common.eips(), [7939])
      assert.isFalse(common.isActivatedEIP(eip))
    },
  )

  it('rejects invalid EIP identifiers in parameter queries', () => {
    const common = new Common({ chain: TronMainnet, params: { 7939: { clzGas: 5 } } })
    for (const eip of [0, -1, NaN, Infinity, 7939.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => common.paramByEIP('clzGas', eip), /not supported/)
    }
    assert.throws(() => common.paramByEIP('clzGas', '7939' as any), /not supported/)
  })
})
