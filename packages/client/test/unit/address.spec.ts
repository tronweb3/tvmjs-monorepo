import { assert, describe, it } from 'vitest'

import {
  boolParam,
  formatTronAddress,
  isHexText,
  isVisible,
  parseAnyAddress,
  parseRequestAddress,
  parseTronAddress,
  toBase58,
  toTronHex,
  tryParseTronAddress,
} from '../../src/dialect/tron/address.ts'

const BASE58 = 'TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm'
const HEX41 = '4171b0af54e0a1182a5e0947d6a64f3b22740ef318'

describe('address parsing', () => {
  it('accepts base58 and 41-hex, and lower-cases what it stores', () => {
    assert.strictEqual(toTronHex(parseTronAddress(BASE58)), HEX41)
    assert.strictEqual(toTronHex(parseTronAddress(HEX41.toUpperCase())), HEX41)
    assert.strictEqual(toBase58(parseTronAddress(HEX41)), BASE58)
  })

  it('refuses the evm form, which TronWeb would otherwise re-prefix to 41', () => {
    assert.throws(() => parseTronAddress(`0x${HEX41.slice(2)}`), 'Invalid address')
    assert.throws(() => parseTronAddress(`0X${HEX41.slice(2)}`), 'Invalid address')
  })

  it('refuses text that decodes to something other than a 21-byte 41 address', () => {
    assert.throws(() => parseTronAddress('nonsense'), 'Invalid address')
    assert.throws(() => parseTronAddress(''), 'Invalid address')
    assert.throws(() => parseTronAddress('4100'), 'Invalid address')
  })

  it('reports failure instead of throwing where the caller asks it to', () => {
    assert.isUndefined(tryParseTronAddress('nonsense'))
    assert.isDefined(tryParseTronAddress(BASE58))
  })

  it('takes the evm form on the dev-extension side only', () => {
    assert.strictEqual(toTronHex(parseAnyAddress(`0x${HEX41.slice(2)}`)), HEX41)
    assert.strictEqual(toTronHex(parseAnyAddress(BASE58)), HEX41)
  })

  it('holds a request to the form its visible flag claims', () => {
    assert.strictEqual(toTronHex(parseRequestAddress(BASE58, true)), HEX41)
    assert.strictEqual(toTronHex(parseRequestAddress(HEX41, false)), HEX41)
    // a mismatch is a parse error, never a silent conversion
    assert.throws(() => parseRequestAddress(BASE58, false), 'Invalid address')
    assert.throws(() => parseRequestAddress(HEX41, true), 'Invalid address')
  })

  it('prints in the form the reply was asked for', () => {
    const address = parseTronAddress(BASE58)
    assert.strictEqual(formatTronAddress(address), HEX41)
    assert.strictEqual(formatTronAddress(address, false), HEX41)
    assert.strictEqual(formatTronAddress(address, true), BASE58)
  })
})

describe('request flags', () => {
  it('reads the literal true in either the boolean or the query-string form', () => {
    assert.isTrue(boolParam(true))
    assert.isTrue(boolParam('true'))
    assert.isTrue(boolParam('TRUE'))
    assert.isFalse(boolParam('1'))
    assert.isFalse(boolParam(1))
    assert.isFalse(boolParam(false))
    assert.isFalse(boolParam(undefined))
  })

  it('reads visible off the request the same way', () => {
    assert.isTrue(isVisible({ visible: 'true' }))
    assert.isFalse(isVisible({}))
  })
})

describe('hex request text', () => {
  it('accepts any digit count, either case, with or without the prefix', () => {
    assert.isTrue(isHexText('41ab'))
    assert.isTrue(isHexText('0x41AB'))
    assert.isTrue(isHexText('0X41ab'))
    assert.isTrue(isHexText('abc'))
    assert.isTrue(isHexText(''))
    assert.isTrue(isHexText(undefined))
    assert.isTrue(isHexText(null))
  })

  it('refuses a non-digit and anything that is not text at all', () => {
    assert.isFalse(isHexText('zz'))
    assert.isFalse(isHexText(7))
    assert.isFalse(isHexText({}))
  })
})
