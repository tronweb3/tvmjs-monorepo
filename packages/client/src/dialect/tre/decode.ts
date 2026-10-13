/**
 * Argument decoding for the dev surface. Every `tre_*` / `debug_*` parameter
 * is stated as text, and every value this file refuses is answered as an
 * invalid-params error carrying the message the surface names for it.
 *
 * A decoder runs before the method's own rules, so an argument that fails here
 * never reaches the chain: `tre_setAccountBalance` decides the amount is
 * unreadable before it decides whether it is negative.
 */
import { bytesToHex, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { TronWeb } from 'tronweb'

import { INT32_MAX, INT32_MIN, INT64_MAX, INT64_MIN } from '../../intBounds.ts'
import { InvalidParamsError } from '../../provider.ts'

import type { Address } from '@tvmjs/util'

/** a decoded address is 21 bytes: the mainnet prefix, then the 20 that identify it */
const ADDRESS_PREFIX = 0x41
const ADDRESS_BYTES = 21
/** base58 addresses are this long, and the hex forms are the 21 bytes plus an optional `0x` */
const BASE58_LENGTH = 34
const ADDRESS_HEX_MAX = ADDRESS_BYTES * 2 + 2

/**
 * The scalar as the text a string parameter receives. A composite value has no
 * such form, and reads as a decode failure wherever one is expected.
 */
export function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return undefined
}

/**
 * Bytes from hex, with the leading `0x` optional and an odd digit count read as
 * a leading zero (`0x1` is one byte). Throws for anything that is not hex.
 */
function fromHexString(text: string): Uint8Array {
  const body = text.replace(/^0x/, '')
  if (body === '') return new Uint8Array()
  if (!/^[0-9a-fA-F]+$/.test(body)) throw new Error('not hex')
  return hexToBytes(`0x${body.length % 2 === 0 ? body : `0${body}`}`)
}

/**
 * An integer literal in the radix its prefix names: a lowercase `0x` selects
 * base 16 and everything else is decimal, either one carrying an optional
 * sign. Out of range counts as unreadable, the way a fixed-width parse does.
 */
function decodeIntegerIn(value: unknown, min: bigint, max: bigint): bigint {
  // an absent parameter reads as -1, which every range below this rejects
  if (value === undefined || value === null) return -1n
  const text = scalarText(value)
  if (text === undefined) throw new InvalidParamsError('integer decode error')
  const radix = text.startsWith('0x') ? 16 : 10
  const body = radix === 16 ? text.slice(2) : text
  const digits = /^[+-]/.test(body) ? body.slice(1) : body
  const pattern = radix === 16 ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/
  if (!pattern.test(digits)) throw new InvalidParamsError('integer decode error')
  const magnitude = radix === 16 ? BigInt(`0x${digits}`) : BigInt(digits)
  const parsed = body.startsWith('-') ? -magnitude : magnitude
  if (parsed < min || parsed > max) throw new InvalidParamsError('integer decode error')
  return parsed
}

export function decodeInt(value: unknown): number {
  return Number(decodeIntegerIn(value, INT32_MIN, INT32_MAX))
}

/**
 * An `int` parameter taken from the JSON value itself: a number is truncated
 * toward zero, a string is trimmed and read as a decimal, and an empty string
 * reads as zero. Anything else names no integer at all.
 */
export function decodeBoundInt(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidParamsError('integer decode error')
    const whole = BigInt(Math.trunc(value))
    if (whole < INT32_MIN || whole > INT32_MAX) throw new InvalidParamsError('integer decode error')
    return Number(whole)
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return 0
    if (!/^[+-]?[0-9]+$/.test(text)) throw new InvalidParamsError('integer decode error')
    const parsed = BigInt(text)
    if (parsed < INT32_MIN || parsed > INT32_MAX)
      throw new InvalidParamsError('integer decode error')
    return Number(parsed)
  }
  throw new InvalidParamsError('integer decode error')
}

export function decodeLong(value: unknown): bigint {
  return decodeIntegerIn(value, INT64_MIN, INT64_MAX)
}

/**
 * Hex bytes from a value that names itself as hex: the `0x` prefix is required
 * here. The address forms below take it either way.
 */
export function decodeHex(value: unknown): Uint8Array {
  const text = scalarText(value)
  if (text === undefined || !text.startsWith('0x')) {
    throw new InvalidParamsError('hex must begin with 0x')
  }
  try {
    return fromHexString(text)
  } catch {
    throw new InvalidParamsError('hex decode error')
  }
}

export function decodeHash(value: unknown): Uint8Array {
  const hash = decodeHex(value)
  if (hash.length !== 32) throw new InvalidParamsError('hash must be 32 bytes')
  return hash
}

export function decodeDataWord(value: unknown): Uint8Array {
  const data = decodeHex(value)
  if (data.length > 32) {
    throw new InvalidParamsError('data word should not longer than 32 bytes')
  }
  const word = new Uint8Array(32)
  word.set(data, 32 - data.length)
  return word
}

/**
 * An address in any form the dev surface takes: base58, or hex with the `0x`
 * and the `41` prefix each optional. Twenty hex bytes name the same account as
 * the twenty-one they get the prefix prepended to.
 */
export function decodeAddress(value: unknown): Address {
  const text = scalarText(value)
  if (text === undefined) throw new InvalidParamsError('invalid address')
  if (text.length === BASE58_LENGTH && text.startsWith('T')) {
    if (!TronWeb.isAddress(text)) throw new InvalidParamsError('base58 address decode error')
    return createAddressFromString(
      `0x${(TronWeb.address.toHex(text) as string).slice(2).toLowerCase()}`,
    )
  }
  if (text.length > ADDRESS_HEX_MAX) throw new InvalidParamsError('invalid address')
  let bytes: Uint8Array
  try {
    bytes = fromHexString(text)
  } catch {
    throw new InvalidParamsError('invalid address')
  }
  if (bytes.length === ADDRESS_BYTES) {
    if (bytes[0] !== ADDRESS_PREFIX) throw new InvalidParamsError('invalid address')
    bytes = bytes.subarray(1)
  } else if (bytes.length !== ADDRESS_BYTES - 1) {
    throw new InvalidParamsError('invalid address')
  }
  return createAddressFromString(bytesToHex(bytes))
}
