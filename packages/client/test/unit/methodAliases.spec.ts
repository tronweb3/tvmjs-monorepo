import { TronWeb } from 'tronweb'
import { assert, describe, it } from 'vitest'

import { createDefaultRegistry } from '../../src/dialect/index.ts'
import { Registry } from '../../src/dialect/registry.ts'
import { createTronHttpDialect } from '../../src/dialect/tron/http.ts'
import { MERGED_MESSAGE } from '../../src/dialect/tron/mergedFields.ts'
import { requestInput } from '../../src/requestInput.ts'

import type { RequestFacts } from '../../src/dialect/httpDialect.ts'

const ADDRESS = '41b6c5b2cb034e6119d1eb715a97cff5858d23d1bf'
const BASE58 = TronWeb.address.fromHex(ADDRESS)
const facts = (path: string, body = '{}', query = ''): RequestFacts => ({
  path,
  httpMethod: 'POST',
  body: async () => body,
  query: new URLSearchParams(query),
  formEncoded: false,
  accept: '',
})

describe('registered method aliases', () => {
  it('gives every real mirror one definition without duplicating its input schema', () => {
    const registry = createDefaultRegistry()
    const aliases = registry.methods().filter((name) => registry.resolve(name)!.name !== name)
    assert.lengthOf(aliases, 40)
    for (const alias of aliases) {
      const definition = registry.resolve(alias)!
      assert.strictEqual(definition, registry.resolve(definition.name), alias)
      assert.isTrue(Object.isFrozen(definition), alias)
      assert.isUndefined(MERGED_MESSAGE[alias], `${alias} must inherit its input schema`)
    }
    const independent = registry.resolve('walletsolidity/getpaginatednowwitnesslist')!
    assert.strictEqual(independent.name, 'walletsolidity/getpaginatednowwitnesslist')
    assert.notStrictEqual(
      independent.handler,
      registry.resolve('wallet/getpaginatednowwitnesslist')!.handler,
    )
  })

  it('a newly registered mirror inherits smart-contract integers and address rules', () => {
    // This mirror exists only in this test registry, not in the served API.
    const registry = new Registry()
    registry.register('wallet/deploycontract', () => ({}), { solidity: true })
    const alias = registry.resolve('walletsolidity/deploycontract')!
    const input = {
      owner_address: BASE58,
      call_value: '0x11',
      fee_limit: '20000',
      origin_energy_limit: 32,
      consume_user_resource_percent: 100n,
    }
    const before = structuredClone(input)
    assert.deepEqual(requestInput(alias, input), {
      owner_address: ADDRESS,
      call_value: 17n,
      fee_limit: 20_000n,
      origin_energy_limit: 32n,
      consume_user_resource_percent: 100n,
    })
    assert.deepEqual(input, before)
    assert.throws(() => requestInput(alias, { call_value: true }), /call_value must be an integer/)
    assert.throws(
      () => requestInput(alias, { call_value: 1n << 63n }),
      /call_value must be at most/,
    )
  })

  it('a newly registered mirror inherits nested protobuf input rules', () => {
    const registry = new Registry()
    registry.register('wallet/accountpermissionupdate', () => ({}), { solidity: true })
    const alias = registry.resolve('walletsolidity/accountpermissionupdate')!
    const input = {
      owner_address: BASE58,
      owner: { threshold: '0x1', keys: [{ address: BASE58, weight: '2' }] },
    }
    assert.deepEqual(requestInput(alias, input), {
      owner_address: ADDRESS,
      owner: { threshold: 1n, keys: [{ address: ADDRESS, weight: 2n }] },
    })
    assert.throws(
      () => requestInput(alias, { owner: { threshold: 1.5 } }),
      /owner.threshold must be an integer/,
    )
  })

  it('inherits HTTP query/body selection and protobuf validation from the same definition', async () => {
    const registry = new Registry()
    registry.register('wallet/getchainparameters', () => ({}), { solidity: true })
    registry.register('wallet/accountpermissionupdate', () => ({}), { solidity: true })
    const dialect = createTronHttpDialect(registry)
    const query = await dialect.readParams(
      facts('walletsolidity/getchainparameters', 'not JSON', 'visible=true'),
    )
    assert.strictEqual(query.visible, 'true')
    for (const path of [
      'wallet/accountpermissionupdate',
      'walletsolidity/accountpermissionupdate',
    ]) {
      const valid = facts(path, '{"owner":{"threshold":1}}')
      dialect.prepare(valid, await dialect.readParams(valid))
      const invalid = facts(path, '{"owner":{"threshold":"1"}}')
      const fields = await dialect.readParams(invalid)
      assert.throws(() => dialect.prepare(invalid, fields), /parse integer/)
    }
  })

  it('inherits reply printing flags and route-specific int64 formatting', () => {
    const registry = new Registry()
    registry.register('wallet/getnextmaintenancetime', () => ({}), { solidity: true })
    registry.register('wallet/getnodeinfo', () => ({}), {
      solidity: true,
      verbatim: true,
      selfPrinted: true,
    })
    const dialect = createTronHttpDialect(registry)
    const get = (path: string) => ({
      ...facts(path, '', 'int64_as_string=true'),
      httpMethod: 'GET',
    })
    assert.deepEqual(
      dialect.render(get('walletsolidity/getnextmaintenancetime'), { num: 17n, empty: 0 }),
      { num: '17' },
    )
    assert.deepEqual(
      dialect.render(get('walletsolidity/getnodeinfo'), { balance: 17n, empty: 0 }),
      { balance: 17n, empty: 0 },
    )
  })

  it('does not turn an unregistered or differently cased name into a registered method', () => {
    const registry = createDefaultRegistry()
    for (const name of [
      'walletsolidity/deploycontract',
      'Wallet/getaccount',
      'walletsolidity/getbrokerage',
      'walletsolidity/totaltransaction',
    ]) {
      assert.isUndefined(registry.resolve(name), name)
    }
    assert.throws(
      () => registry.register('net/listnodes', () => ({}), { solidity: true }),
      /Not a wallet method/,
    )
  })

  it('rejects collisions atomically so an alias cannot diverge from its definition', () => {
    const registry = new Registry()
    registry.register('walletsolidity/getaccount', () => ({ independent: true }))
    const original = registry.resolve('walletsolidity/getaccount')
    assert.throws(
      () => registry.register('wallet/getaccount', () => ({}), { solidity: true }),
      /already registered/,
    )
    assert.isUndefined(registry.resolve('wallet/getaccount'))
    assert.strictEqual(registry.resolve('walletsolidity/getaccount'), original)
    registry.register('wallet/getnowblock', () => ({}), { solidity: true })
    assert.throws(() => registry.register('wallet/getnowblock', () => ({})), /already registered/)
    assert.throws(
      () => registry.register('walletsolidity/getnowblock', () => ({})),
      /already registered/,
    )
    assert.strictEqual(
      registry.resolve('wallet/getnowblock'),
      registry.resolve('walletsolidity/getnowblock'),
    )
  })
})
