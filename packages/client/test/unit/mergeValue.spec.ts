import { assert, describe, it } from 'vitest'

import { RAW_BODY } from '../../src/dialect/registry.ts'
import {
  MergeError,
  checkMergeField,
  fieldPosition,
  fieldTokens,
  listOf,
  mergeInt64Field,
  parseMergeEnum,
  parseMergeInt32,
  parseMergeInt64,
  skipUnknownField,
  tokenPosition,
} from '../../src/dialect/tron/mergeValue.ts'

import type { HandlerParams } from '../../src/dialect/registry.ts'
import type { MergeToken } from '../../src/dialect/tron/mergeValue.ts'

/** a request whose fields were read off this exact body text */
function body(raw: string): HandlerParams {
  const params: HandlerParams = JSON.parse(raw)
  params[RAW_BODY] = raw
  return params
}

/** the token a field's value starts at, which every parse is reported against */
function token(raw: string, field = 'v'): MergeToken {
  const tokens = fieldTokens(body(raw), field)
  assert.isAtLeast(tokens.length, 1)
  return tokens[0]
}

const fails = (run: () => unknown): string => {
  try {
    run()
  } catch (err) {
    assert.instanceOf(err, MergeError)
    return (err as MergeError).message
  }
  assert.fail('expected a MergeError')
}

describe('merge-stage value reader', () => {
  describe('token positions', () => {
    it('reports the line and column a value starts at', () => {
      assert.strictEqual(tokenPosition(token('{"v":123}')), '1:6')
      assert.strictEqual(tokenPosition(token('{\n  "v": 123\n}')), '2:8')
    })

    it('numbers array elements from where each one starts', () => {
      const tokens = fieldTokens(body('{"v":[1, 22, 333]}'), 'v')
      assert.deepEqual(tokens.map(tokenPosition), ['1:7', '1:10', '1:14'])
    })

    it('walks an array of objects instead of stopping at the first brace', () => {
      const tokens = fieldTokens(body('{"v":[{"a":1},{"a":2}]}'), 'v')
      assert.strictEqual(tokens.length, 2)
      assert.deepEqual(
        tokens.map((t) => t.text),
        ['{', '{'],
      )
    })

    it('places a field the body never carried at the end of the text', () => {
      // the walk runs off the end looking for it, and blames where it stopped
      assert.deepEqual(fieldPosition(body('{"v":1}'), 'absent'), { line: 1, column: 11 })
    })
  })

  describe('integer parsing', () => {
    it('takes the radix from the prefix of an unquoted token', () => {
      assert.strictEqual(parseMergeInt64(token('{"v":16}')), 16n)
      assert.strictEqual(parseMergeInt64(token('{"v":-16}')), -16n)
    })

    it('blames the token as written, so quotes reach the message and defeat the radix', () => {
      // the parse works on the raw token: a quoted 0x10 is the six characters
      // "0x10" with its quotes, which no radix reads
      assert.strictEqual(
        fails(() => parseMergeInt64(token('{"v":"0x10"}'))),
        '1:6: Couldn\'t parse integer: For input string: ""0x10""',
      )
      assert.strictEqual(
        fails(() => parseMergeInt64(token('{"v":"abc"}'))),
        '1:6: Couldn\'t parse integer: For input string: ""abc""',
      )
    })

    it('names its own range for a value too wide for the type', () => {
      const wide = fails(() => parseMergeInt64(token('{"v":9223372036854775808}')))
      assert.include(wide, 'out of range')
      const narrow = fails(() => parseMergeInt32(token('{"v":2147483648}')))
      assert.include(narrow, 'out of range')
    })

    it('reads a long token one word at a time, so only the first group is blamed', () => {
      // past fifteen characters the parse goes word by word, nine decimal
      // digits at a time, and gets no further than the first group
      assert.strictEqual(
        fails(() => parseMergeInt64(token(`{"v":"${'9'.repeat(15)}x"}`))),
        '1:6: Couldn\'t parse integer: For input string: ""99999999"',
      )
      assert.strictEqual(
        fails(() => parseMergeInt64(token(`{"v":"${'9'.repeat(20)}x"}`))),
        '1:6: Couldn\'t parse integer: For input string: ""9999"',
      )
    })

    it('reports an embedded sign before it reports any digits', () => {
      assert.strictEqual(
        fails(() => parseMergeInt64(token(`{"v":"1${'2'.repeat(20)}-3"}`))),
        "1:6: Couldn't parse integer: Illegal embedded sign character",
      )
    })

    it('reads a field off the body by name', () => {
      assert.strictEqual(mergeInt64Field(body('{"num":42}'), 'num'), 42n)
      assert.strictEqual(mergeInt64Field(body('{}'), 'num'), 0n)
    })
  })

  describe('enums', () => {
    const values = { Normal: 0, AssetIssue: 1, Contract: 2 }

    it('accepts a member by name or by number', () => {
      assert.strictEqual(parseMergeEnum(token('{"v":"AssetIssue"}'), 'AccountType', values), 1)
      assert.strictEqual(parseMergeEnum(token('{"v":2}'), 'AccountType', values), 2)
    })

    it('capitalises an all-lower-case name before looking it up', () => {
      assert.strictEqual(parseMergeEnum(token('{"v":"normal"}'), 'AccountType', values), 0)
    })

    it('names the enum, and which way it was stated, when the member is unknown', () => {
      assert.strictEqual(
        fails(() => parseMergeEnum(token('{"v":"Nope"}'), 'AccountType', values)),
        '1:6: Enum type "AccountType" has no value named "Nope".',
      )
      assert.strictEqual(
        fails(() => parseMergeEnum(token('{"v":9}'), 'AccountType', values)),
        '1:6: Enum type "AccountType" has no value with number 9.',
      )
    })

    it('refuses a name carrying a character an identifier cannot hold', () => {
      assert.strictEqual(
        fails(() => parseMergeEnum(token('{"v":"a-b"}'), 'AccountType', values)),
        '1:6: Expected identifier. --',
      )
    })
  })

  describe('field kinds', () => {
    it('requires a brace for a message', () => {
      assert.strictEqual(
        fails(() => checkMergeField(token('{"v":1}'), 'message')),
        '1:6: Expected "{".',
      )
      checkMergeField(token('{"v":{}}'), 'message')
    })

    it('requires a quoted value for bytes and string', () => {
      assert.strictEqual(
        fails(() => checkMergeField(token('{"v":1}'), 'string')),
        '1:6: Expected string.',
      )
      checkMergeField(token('{"v":"anything"}'), 'string')
    })

    it('reads bytes as hex, with an optional prefix and any digit count', () => {
      checkMergeField(token('{"v":"41ab"}'), 'bytes')
      checkMergeField(token('{"v":"0x41ab"}'), 'bytes')
      checkMergeField(token('{"v":"abc"}'), 'bytes')
      checkMergeField(token('{"v":""}'), 'bytes')
      assert.strictEqual(
        fails(() => checkMergeField(token('{"v":"zz"}'), 'bytes')),
        '1:6: INVALID hex String',
      )
      // the prefix is matched exactly, so an upper-case one is not a prefix
      assert.strictEqual(
        fails(() => checkMergeField(token('{"v":"0X41"}'), 'bytes')),
        '1:6: INVALID hex String',
      )
    })

    it('reads a bytes field as base58 only where the request says so', () => {
      const context = { visible: true, selfFormat: 'address' as const, fieldName: 'protocol.X.y' }
      checkMergeField(token('{"v":"TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm"}'), 'bytes', context)
      assert.strictEqual(
        fails(() => checkMergeField(token('{"v":"nonsense"}'), 'bytes', context)),
        '1:6: invalid address for field: protocol.X.y',
      )
      // without visible the same value is read as hex
      assert.strictEqual(
        fails(() => checkMergeField(token('{"v":"nonsense"}'), 'bytes', { selfFormat: 'address' })),
        '1:6: INVALID hex String',
      )
    })

    it('lets a name field carry its text under visible', () => {
      checkMergeField(token('{"v":"my token"}'), 'bytes', { visible: true, selfFormat: 'name' })
    })

    it('passes a literal null whatever the kind', () => {
      checkMergeField(token('{"v":null}'), 'message')
      checkMergeField(token('{"v":null}'), 'bytes')
    })
  })

  describe('unknown fields', () => {
    it('fails an object at its closing brace', () => {
      const message = fails(() => skipUnknownField(body('{"nope":{}}'), 'nope'))
      assert.include(message, 'Expected identifier.')
    })

    it('reads a value that starts with a digit as an integer', () => {
      skipUnknownField(body('{"nope":12}'), 'nope')
    })
  })

  describe('listOf', () => {
    it('leaves an array alone and wraps everything else', () => {
      assert.deepEqual(listOf([1, 2]), [1, 2])
      assert.deepEqual(listOf('x'), ['x'])
      assert.deepEqual(listOf(undefined), [])
    })
  })
})

/**
 * The body is read as JSON, so a field is the member the outermost object
 * declares. What the request names its fields is text it chose, and text is
 * not a pattern.
 */
describe('locating a field in the request text', () => {
  it('reads the member the outer object declares, not one nested inside it', () => {
    const params = body('{"nested":{"v":7777},"v":1000}')
    assert.deepEqual(
      fieldTokens(params, 'v').map((t) => t.text),
      ['1000'],
    )
  })

  it('steps over a field name that appears inside a string', () => {
    const params = body('{"memo":"x\\"v\\":7777","v":1000}')
    assert.deepEqual(
      fieldTokens(params, 'v').map((t) => t.text),
      ['1000'],
    )
  })

  it('keeps every value a name was stated with, in the order they were written', () => {
    const params = body('{"v":1000,"v":2000}')
    assert.deepEqual(
      fieldTokens(params, 'v').map((t) => t.text),
      ['1000', '2000'],
    )
    // the merge reads them in order, so setting a singular field twice keeps the last
    assert.strictEqual(mergeInt64Field(params, 'v'), 2000n)
  })

  it('takes a name holding regex punctuation as the name it is', () => {
    const params = body('{"[":1,"(a+)+$":2,"v":1000}')
    assert.deepEqual(
      fieldTokens(params, 'v').map((t) => t.text),
      ['1000'],
    )
    assert.deepEqual(
      fieldTokens(params, '(a+)+$').map((t) => t.text),
      ['2'],
    )
    assert.deepEqual(
      fieldTokens(params, 'a').map((t) => t.text),
      [],
    )
  })

  it('gives a name that is not a member no position of its own', () => {
    assert.deepEqual(fieldPosition(body('{"v":1}'), 'absent'), { line: 1, column: 11 })
  })

  it('stops an unknown value nested deeper than the reader goes', () => {
    const nest = (depth: number): string => `${'['.repeat(depth)}1${']'.repeat(depth)}`
    const deep = body(`{"deep":${nest(30)},"v":1}`)
    assert.throws(() => skipUnknownField(deep, 'deep'), MergeError, 'Hit recursion limit.')
    // a body inside the limit is stepped over without complaint
    skipUnknownField(body(`{"deep":${nest(5)},"v":1}`), 'deep')
  })

  it('refuses an unknown value that states an empty list or object', () => {
    // a list is read one element at a time and an object a pair at a time, so
    // the reader is looking for an element where the closer stands
    assert.throws(
      () => skipUnknownField(body('{"u":[],"v":1}'), 'u'),
      MergeError,
      'Expected string.',
    )
    assert.throws(
      () => skipUnknownField(body('{"u":{},"v":1}'), 'u'),
      MergeError,
      'Expected identifier.',
    )
  })

  it('reads a name stated as many times as a whole body can state it', () => {
    // 4 MiB is the ceiling the transport reads a body up to
    const member = '"v":"410000000000000000000000000000000000000000"'
    const count = Math.floor((4 * 1024 * 1024 - 2) / (member.length + 1))
    const params = body(`{${Array.from({ length: count }, () => member).join(',')}}`)
    const started = performance.now()
    const tokens = fieldTokens(params, 'v')
    const elapsed = performance.now() - started
    assert.lengthOf(tokens, count)
    assert.strictEqual(tokens[count - 1].line, 1)
    assert.strictEqual(tokens[count - 1].column, (member.length + 1) * (count - 1) + 6)
    assert.isBelow(elapsed, 2_000)
  }, 30_000)

  it('terminates and does not hang on malformed array with unexpected token', () => {
    const raw = '{"amount":[}]}&amount=1'
    const params: HandlerParams = { amount: 1 }
    params[RAW_BODY] = raw
    const tokens = fieldTokens(params, 'amount')
    assert.isTrue(tokens.length >= 1)
  })
})
