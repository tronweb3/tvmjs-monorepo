import { assert, describe, it } from 'vitest'

import { resolveConfig } from '../../src/config.ts'
import { allowHeader } from '../../src/dialect/httpDialect.ts'
import { createDefaultRegistry } from '../../src/dialect/index.ts'
import { HTTP_METHOD } from '../../src/dialect/registry.ts'
import { CONTRACT_TYPE } from '../../src/dialect/tron/contractTypes.ts'
import { createTronHttpDialect } from '../../src/dialect/tron/http.ts'
import {
  MERGED_MESSAGE,
  MERGE_ENUMS,
  MERGE_ENUM_NAMES,
  MESSAGE_FIELDS,
  SELF_FORMAT_FIELDS,
} from '../../src/dialect/tron/mergedFields.ts'
import {
  availableContractTypes,
  permissionError,
  permissionTypeOf,
} from '../../src/dialect/tron/permission.ts'
import { Float, omitDefaults } from '../../src/dialect/tron/proto.ts'
import { JAVA_TRON_ROUTES } from '../../src/dialect/tron/routeManifest.ts'
import { ADDRESS_FIELDS, NAME_FIELDS } from '../../src/dialect/tron/visible.ts'
import { abiEntries } from '../../src/dialect/tron/wallet/print.ts'
import {
  broadcastError,
  isPostBody,
  requireLongParam,
  servletError,
} from '../../src/dialect/tron/wallet/types.ts'

import type { HandlerParams } from '../../src/dialect/registry.ts'
import type { Permission } from '../../src/dialect/tron/permission.ts'

const permission = (over: Partial<Permission> = {}): Permission => ({
  type: 'Active',
  id: 2,
  permission_name: 'active',
  threshold: 1n,
  keys: [{ address: '41'.padEnd(42, '0'), weight: 1n }],
  ...over,
})

describe('allowHeader', () => {
  it('lists the verbs the servlet declared, plus the two the container adds', () => {
    assert.strictEqual(allowHeader('B'), 'GET, HEAD, POST, TRACE, OPTIONS')
    assert.strictEqual(allowHeader('S'), 'GET, HEAD, POST, TRACE, OPTIONS')
    assert.strictEqual(allowHeader('P'), 'POST, TRACE, OPTIONS')
    assert.strictEqual(allowHeader('G'), 'GET, HEAD, TRACE, OPTIONS')
  })

  it('gives an unclaimed path what the not-found servlet declares', () => {
    assert.strictEqual(allowHeader(undefined), 'GET, HEAD, TRACE, OPTIONS')
  })
})

describe('permission rules', () => {
  it('checks the key count before anything else about the keys', () => {
    assert.strictEqual(
      permissionError(permission({ keys: [] }), 5),
      "key's count should be greater than 0",
    )
    assert.strictEqual(
      permissionError(permission({ keys: [{ address: '41', weight: 1n }] }), 0),
      'number of keys in permission should not be greater than 0',
    )
  })

  it('checks Witness before it checks the operations bitmap', () => {
    assert.strictEqual(
      permissionError(
        permission({
          type: 'Witness',
          keys: [
            { address: '41', weight: 1n },
            { address: '42', weight: 1n },
          ],
        }),
        5,
      ),
      "Witness permission's key count should be 1",
    )
    // a non-Active permission carries no operations at all
    assert.isUndefined(permissionError(permission({ type: 'Witness' }), 5))
  })

  it('requires a positive threshold and a name that fits', () => {
    assert.strictEqual(
      permissionError(permission({ threshold: 0n }), 5),
      "permission's threshold should be greater than 0",
    )
    assert.strictEqual(
      permissionError(permission({ permission_name: 'x'.repeat(33) }), 5),
      "permission's name is too long",
    )
    // an Active permission still owes a 32-byte operations bitmap
    assert.strictEqual(
      permissionError(permission({ permission_name: 'x'.repeat(32) }), 5),
      'operations size must 32',
    )
    assert.isUndefined(
      permissionError(
        permission({ permission_name: 'x'.repeat(32), operations: '0'.repeat(64) }),
        5,
      ),
    )
  })

  it('reads a permission type off either spelling, and Owner off nothing at all', () => {
    assert.strictEqual(permissionTypeOf(undefined), 'Owner')
    assert.strictEqual(permissionTypeOf(0), 'Owner')
    assert.strictEqual(permissionTypeOf('0'), 'Owner')
    assert.strictEqual(permissionTypeOf('Owner'), 'Owner')
    assert.strictEqual(permissionTypeOf(1), 'Witness')
    assert.strictEqual(permissionTypeOf('Active'), 'Active')
    assert.isUndefined(permissionTypeOf('Nope'))
    assert.isUndefined(permissionTypeOf(3))
  })

  it('uses the node feature configuration for later operation bits', () => {
    const operations = `${'0'.repeat(14)}08${'0'.repeat(48)}`
    assert.strictEqual(
      permissionError(
        permission({ operations }),
        5,
        availableContractTypes({
          unfreezeDelayDays: 14,
          allowCancelAllUnfreezeV2: 0,
        }),
      ),
      "59 isn't a validate ContractType",
    )
    assert.isUndefined(
      permissionError(
        permission({ operations }),
        5,
        availableContractTypes({
          unfreezeDelayDays: 14,
          allowCancelAllUnfreezeV2: 1,
        }),
      ),
    )
  })
})

describe('proto printing', () => {
  it('drops what a proto3 field is at default and keeps the rest', () => {
    assert.deepEqual(omitDefaults({ a: 0, b: 1, c: '', d: 'x', e: false, f: true }), {
      b: 1,
      d: 'x',
      f: true,
    })
  })

  it('keeps a whole-valued double a double', () => {
    assert.strictEqual(new Float(1).text, '1.0')
  })

  it('walks into nested objects and arrays', () => {
    assert.deepEqual(omitDefaults({ outer: { a: 0, b: 2 }, list: [{ a: 0, b: 3 }] }), {
      outer: { b: 2 },
      list: [{ b: 3 }],
    })
  })
})

describe('abi entries', () => {
  it('names the enums the stored message uses', () => {
    assert.deepEqual(abiEntries([{ type: 'function', stateMutability: 'view', name: 'f' }]), [
      { type: 'Function', stateMutability: 'View', name: 'f' },
    ])
  })

  it('drops an empty parameter list and the defaults inside a parameter', () => {
    assert.deepEqual(
      abiEntries([
        {
          type: 'function',
          name: 'f',
          inputs: [{ name: '', type: 'uint256', indexed: false }],
          outputs: [],
        },
      ]),
      [{ type: 'Function', name: 'f', inputs: [{ type: 'uint256' }] }],
    )
  })

  it('keeps anonymous only where it is set', () => {
    assert.deepEqual(abiEntries([{ type: 'event', name: 'E', anonymous: true }]), [
      { type: 'Event', name: 'E', anonymous: true },
    ])
    assert.deepEqual(abiEntries([{ type: 'event', name: 'E', anonymous: false }]), [
      { type: 'Event', name: 'E' },
    ])
  })

  it('passes anything that is not an entry object straight through', () => {
    assert.deepEqual(abiEntries(['x', 3]), ['x', 3])
  })
})

describe('error envelopes', () => {
  it('hex-encodes the message behind the prefix its code carries', () => {
    const envelope = broadcastError('CONTRACT_VALIDATE_ERROR', 'nope')
    assert.strictEqual(envelope.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(envelope.result, false)
    const bytes = Uint8Array.from(String(envelope.message).match(/../g) ?? [], (pair) =>
      Number.parseInt(pair, 16),
    )
    assert.strictEqual(new TextDecoder().decode(bytes), 'Contract validate error : nope')
  })

  it('states a servlet failure with its semantic message', () => {
    assert.deepEqual(servletError('nope'), {
      Error: 'nope',
    })
  })
})

describe('the visible leaf tables', () => {
  // The response side converts on the leaf name alone, because a deep walk
  // never sees which message a leaf belongs to. That is only sound while a
  // leaf name means the same thing everywhere it appears, so the classification
  // is checked against the table generated from the `.proto` files.
  const kindsByLeaf = new Map<string, Set<string>>()
  for (const fields of Object.values(SELF_FORMAT_FIELDS)) {
    for (const [field, kind] of Object.entries(fields)) {
      kindsByLeaf.set(field, (kindsByLeaf.get(field) ?? new Set()).add(kind))
    }
  }

  it('classify every leaf the same way the generated table does', () => {
    for (const [name, table, want] of [
      ['ADDRESS_FIELDS', ADDRESS_FIELDS, 'address'],
      ['NAME_FIELDS', NAME_FIELDS, 'name'],
    ] as const) {
      for (const leaf of table) {
        const kinds = kindsByLeaf.get(leaf)
        // a leaf the request side never carries is only in the response tables
        if (kinds === undefined) continue
        assert.deepEqual([...kinds], [want], `${name}: ${leaf}`)
      }
    }
  })

  it('keep the two tables disjoint', () => {
    const both = [...NAME_FIELDS].filter((leaf) => ADDRESS_FIELDS.has(leaf))
    assert.deepEqual(both, [])
  })
})

describe('values the JSON number grammar cannot state', () => {
  const dialect = createTronHttpDialect(createDefaultRegistry())
  const read = async (body: string): Promise<Record<string, unknown>> =>
    (await dialect.readParams({
      httpMethod: 'POST',
      path: 'wallet/getaccount',
      query: new URLSearchParams(),
      body: async () => body,
      formEncoded: false,
      accept: '',
    })) as Record<string, unknown>

  it('reads an integer past 2^53 as a bigint and the rest as numbers', async () => {
    const held = await read(
      '{"a":9007199254740993,"b":9007199254740991,"c":1.5,"d":-9223372036854775808}',
    )
    assert.strictEqual(held.a, 9_007_199_254_740_993n)
    assert.strictEqual(held.b, 9_007_199_254_740_991)
    assert.strictEqual(held.c, 1.5)
    assert.strictEqual(held.d, -9_223_372_036_854_775_808n)
  })

  it('reads bodies with a BOM and surrounding whitespace for both small and wide integers', async () => {
    for (const padding of ['\uFEFF', '\u00A0', '\u2028', ' \t\r\n']) {
      for (const [literal, expected] of [
        ['1', 1],
        ['9007199254740993', 9_007_199_254_740_993n],
        ['-9223372036854775808', -9_223_372_036_854_775_808n],
      ] as const) {
        const held = await read(
          `${padding}{"amount":${literal},"text":"\\uFEFF9007199254740993"}${padding}`,
        )
        assert.strictEqual(held.amount, expected)
        assert.strictEqual(held.text, '\uFEFF9007199254740993')
      }
    }
  })

  it('reads a token as the kind its first character names', async () => {
    // a string spelling the writer's own shape is still a string
    const held = await read('{"a":"\\u0000bigint:42","b":"9007199254740993","c":9007199254740993}')
    assert.strictEqual(typeof held.a, 'string')
    assert.strictEqual(held.a, '\u0000bigint:42')
    assert.strictEqual(held.b, '9007199254740993')
    assert.strictEqual(held.c, 9_007_199_254_740_993n)
  })

  it('states a member as its own property, whatever the member is called', async () => {
    // `__proto__` written as a key is a member; assigning it would have
    // replaced the prototype instead, and every read of an absent field
    // would then have found whatever the body put there
    const held = await read('{"address":"41aa","__proto__":{"visible":true}}')
    const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
    assert.isTrue(own(held, '__proto__'))
    assert.strictEqual(Object.getPrototypeOf(held), Object.prototype)
    assert.isUndefined(held.visible)
    const named = await read('{"constructor":{"prototype":{"x":1}}}')
    assert.isTrue(own(named, 'constructor'))
    assert.deepEqual(named.constructor as unknown, { prototype: { x: 1 } })
  })

  it('preserves JSON strings, nested values and last-key-wins semantics with wide integers', async () => {
    const held = await read(
      '{"a":9007199254740993,"a":"9007199254740995","b":0,"b":9007199254740997,' +
        '"nested":[{"n":-9223372036854775808},"9007199254740993",null,1.5,1e20],' +
        '"text":"\\"9007199254740993\\"\\n\\\\",' +
        '"__proto__":{"n":9007199254740993},"\\u0063":9007199254740999}',
    )
    assert.strictEqual(held.a, '9007199254740995')
    assert.strictEqual(held.b, 9_007_199_254_740_997n)
    assert.deepEqual(held.nested, [
      { n: -9_223_372_036_854_775_808n },
      '9007199254740993',
      null,
      1.5,
      1e20,
    ])
    assert.strictEqual(held.text, '"9007199254740993"\n\\')
    assert.strictEqual(held.c, 9_007_199_254_740_999n)
    assert.strictEqual(Object.getPrototypeOf(held), Object.prototype)
    assert.isTrue(Object.prototype.hasOwnProperty.call(held, '__proto__'))
    assert.deepEqual(held.__proto__, { n: 9_007_199_254_740_993n })
  })

  it('reads and writes the shapes a bigint-aware reader is measured on', async () => {
    // the round trip json-bigint pins its own parser to
    const input =
      '{"big":92233720368547758070,"small":123,"deci":1234567890.0123456,"shortExp":1.79e+308,"longExp":1.7976931348623157e+308}'
    const held = await read(input)
    assert.strictEqual(typeof held.big, 'bigint')
    assert.strictEqual(String(held.big), '92233720368547758070')
    assert.strictEqual(held.small, 123)
    assert.strictEqual(typeof held.deci, 'number')
    assert.strictEqual(String(held.deci), '1234567890.0123456')
    assert.strictEqual(String(held.shortExp), '1.79e+308')
    assert.strictEqual(String(held.longExp), '1.7976931348623157e+308')
    assert.strictEqual(dialect.serialize(held), input)
  })

  it('writes an int64 and a protobuf double whole, and a string as a string', () => {
    const write = (value: unknown): string => dialect.serialize(value)
    assert.strictEqual(write({ v: 9_223_372_036_854_775_807n }), '{"v":9223372036854775807}')
    assert.strictEqual(write({ v: new Float(1) }), '{"v":1.0}')
    assert.strictEqual(write({ v: '\u0000bigint:42' }), '{"v":"\\u0000bigint:42"}')
    assert.strictEqual(write({ v: '\u0000float:+' }), '{"v":"\\u0000float:+"}')
    // and the whole reply still parses
    assert.isObject(JSON.parse(write({ a: '\u0000float:+', b: 1n, c: new Float(2.5) })))
  })
})

describe('JSON request bodies', () => {
  const dialect = createTronHttpDialect(createDefaultRegistry())
  const failure = async (path: string, body: string): Promise<string> => {
    try {
      await dialect.readParams({
        httpMethod: 'POST',
        path,
        query: new URLSearchParams(),
        body: async () => body,
        formEncoded: false,
        accept: '',
      })
    } catch (err) {
      return (err as Error).message
    }
    return 'no failure'
  }

  it('requires standard JSON syntax across wallet routes', async () => {
    for (const path of [
      'wallet/getblockbynum',
      'wallet/broadcasttransaction',
      'wallet/broadcasthex',
    ]) {
      for (const body of [
        '{"n":1,}',
        '{n:1}',
        '{"n":01}',
        '{"n":NaN}',
        '{/*comment*/}',
        '{"n":9007199254740993,}',
        '{"n":9007199254740993,"text":"\n"}',
      ]) {
        assert.strictEqual(
          await failure(path, body),
          `Unrecognized token: ${body.trim().slice(0, 32)}`,
          body,
        )
      }
    }
  })

  it('keeps the non-object body error', async () => {
    for (const body of ['[]', '1', 'true', '"text"']) {
      assert.strictEqual(
        await failure('wallet/broadcasttransaction', body),
        'can not cast to JSONObject.',
      )
    }
  })

  it('fails an empty body inside the merge for the routes that merge it', async () => {
    assert.strictEqual(await failure('wallet/getblockbynum', ''), '1:1: Expected "{".')
  })

  it('names the accessor each broadcast route reached for instead', async () => {
    assert.strictEqual(
      await failure('wallet/broadcasttransaction', ''),
      'Cannot invoke "org.tron.json.JSONObject.getJSONObject(String)" because "jsonTransaction" is null',
    )
    assert.strictEqual(
      await failure('wallet/broadcasthex', ''),
      'Cannot invoke "org.tron.json.JSONObject.getString(String)" because the return value of "org.tron.json.JSONObject.parseObject(String)" is null',
    )
    assert.strictEqual(
      await failure('wallet/broadcasthex', 'null'),
      'Cannot invoke "org.tron.json.JSONObject.getString(String)" because the return value of "org.tron.json.JSONObject.parseObject(String)" is null',
    )
    assert.strictEqual(
      await failure('wallet/broadcasttransaction', 'null'),
      'Cannot invoke "org.tron.json.JSONObject.containsKey(String)" because "jsonObject" is null',
    )
  })
})

describe('verb-dependent field reading', () => {
  const get = (fields: Record<string, unknown> = {}): HandlerParams => ({
    ...fields,
    [HTTP_METHOD]: 'GET',
  })
  const post = (fields: Record<string, unknown> = {}): HandlerParams => ({
    ...fields,
    [HTTP_METHOD]: 'POST',
  })

  it('tells the two verbs apart', () => {
    assert.isTrue(isPostBody(post()))
    assert.isFalse(isPostBody(get()))
    assert.isFalse(isPostBody({}))
  })

  it('reports a missing parameter differently on each side', () => {
    // a query string is one bare number parse, which has no key to name
    assert.throws(() => requireLongParam(get(), 'id'), 'Cannot parse null string')
    // a body is read as a decimal off a named key
    assert.throws(() => requireLongParam(post(), 'id'), 'key [id] does not exist')
  })

  it('accepts an integer on either side', () => {
    assert.doesNotThrow(() => requireLongParam(get({ id: '7' }), 'id'))
    assert.doesNotThrow(() => requireLongParam(post({ id: 7 }), 'id'))
  })
})

describe('the signature recovery byte', () => {
  // Read before any curve work: a value below 27 is lifted into the header
  // range, and the range is closed at 34. Past that it would be an Ethereum
  // chain-id encoding, which this chain does not use — reading it as one
  // would accept a signature the chain refuses.
  const header = (stated: number): number => (stated < 27 ? stated + 27 : stated)
  const accepted = (stated: number): boolean => header(stated) >= 27 && header(stated) <= 34

  it('lifts a bare recovery id into the header range', () => {
    assert.isTrue(accepted(0))
    assert.isTrue(accepted(1))
    assert.isTrue(accepted(7))
    assert.strictEqual(header(1), 28)
  })

  it('closes the range at 34, so a chain-id encoding is out', () => {
    assert.isTrue(accepted(34))
    assert.isFalse(accepted(35))
    assert.isFalse(accepted(36))
    assert.isFalse(accepted(255))
  })

  it('leaves the gap between the two halves out', () => {
    assert.isFalse(accepted(8))
    assert.isFalse(accepted(26))
  })

  it('states the normalised header in the failure, not the byte as sent', () => {
    assert.strictEqual(header(26), 53)
    assert.strictEqual(header(8), 35)
  })
})

/**
 * `constructor`, `toString` and their kind are ordinary strings to a caller and
 * properties of every object literal to JavaScript. A table keyed by request
 * content has to miss on them like it misses on any other unknown key.
 */
describe('names Object.prototype carries', () => {
  const PROTOTYPE_NAMES = [
    'constructor',
    'toString',
    'valueOf',
    '__proto__',
    'hasOwnProperty',
    'isPrototypeOf',
  ]

  it('reads back nothing from the tables the request indexes', () => {
    const tables: [string, Record<string, unknown>][] = [
      ['JAVA_TRON_ROUTES', JAVA_TRON_ROUTES],
      ['CONTRACT_TYPE', CONTRACT_TYPE],
      ['MESSAGE_FIELDS', MESSAGE_FIELDS],
      ['MERGED_MESSAGE', MERGED_MESSAGE],
      ['MERGE_ENUMS', MERGE_ENUMS],
      ['MERGE_ENUM_NAMES', MERGE_ENUM_NAMES],
      ['SELF_FORMAT_FIELDS', SELF_FORMAT_FIELDS],
    ]
    for (const [name, table] of tables) {
      for (const key of PROTOTYPE_NAMES) {
        assert.strictEqual(table[key], undefined, `${name}[${key}]`)
        assert.isFalse(key in table, `${key} in ${name}`)
      }
    }
  })

  it('reads back nothing from a nested table either', () => {
    for (const fields of Object.values(MESSAGE_FIELDS)) {
      for (const key of PROTOTYPE_NAMES) assert.strictEqual(fields[key], undefined, key)
    }
    for (const values of Object.values(MERGE_ENUMS)) {
      for (const key of PROTOTYPE_NAMES) assert.strictEqual(values[key], undefined, key)
    }
  })

  it('rejects prototype names as chain parameters', () => {
    for (const name of PROTOTYPE_NAMES) {
      assert.throws(
        () => resolveConfig({ chainParameters: { [name]: 1 } }),
        `Unknown chain parameter "${name}"`,
      )
    }
  })
})
