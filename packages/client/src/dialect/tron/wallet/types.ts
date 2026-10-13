/**
 * Three error dialects share this file:
 * - broadcast/validate errors: `{code, message(hex), result:false}` (Return pb)
 * - builder rejections: `{Error: '<message>'}`
 * - trigger-family validate errors: `{result: {code, message(hex)}}`
 */
import { TronWeb } from 'tronweb'
import { INT64_MAX, INT64_MIN } from '../../../intBounds.ts'

import { HTTP_METHOD } from '../../registry.ts'
import { mergeInt64Field } from '../mergeValue.ts'

import { requestKeyed } from '../../../lookup.ts'
import type { HandlerParams } from '../../registry.ts'

/** one entry of raw_data.contract as it travels in TRON tx JSON */
export interface TronContractJSON {
  parameter: { value: Record<string, unknown>; type_url: string }
  type: string
  Permission_id?: number
  provider?: string
  ContractName?: string
}

export interface TransactionAuthority {
  permission_name?: string
  account?: { name?: string; address?: string }
}

/** a signed TRON transaction as clients POST it to broadcasttransaction */
export interface SignedTronTx {
  visible?: boolean
  txID: string
  raw_data: {
    contract: TronContractJSON[]
    ref_block_bytes: string
    ref_block_num?: number | bigint
    ref_block_hash: string
    expiration: number
    auths?: TransactionAuthority[]
    scripts?: string
    timestamp: number
    fee_limit?: number
    /** memo, hex-encoded; charged a flat fee when present */
    data?: string
  }
  raw_data_hex: string
  signature?: string[]
}

/**
 * Each broadcast failure code carries a fixed prefix on the wire, applied where
 * the corresponding exception is caught. Codes absent here report their message
 * verbatim.
 */
const BROADCAST_PREFIX: Readonly<Record<string, string>> = requestKeyed({
  SIGERROR: 'Validate signature error: ',
  CONTRACT_VALIDATE_ERROR: 'Contract validate error : ',
  CONTRACT_EXE_ERROR: 'Contract execute error : ',
  OTHER_ERROR: 'Error: ',
})

export function broadcastError(code: string, message: string): Record<string, unknown> {
  const text = `${BROADCAST_PREFIX[code] ?? ''}${message}`
  return { code, message: TronWeb.fromUtf8(text).replace(/^0x/, ''), result: false }
}

export function servletError(message: string): Record<string, unknown> {
  return { Error: message }
}

export function triggerError(
  message: string,
  code = 'CONTRACT_VALIDATE_ERROR',
  visible = false,
): Record<string, unknown> {
  return {
    result: {
      code,
      message: visible ? message : TronWeb.fromUtf8(message).replace(/^0x/, ''),
    },
  }
}

/**
 * A message the servlet writes to the response itself, with no class-name
 * prefix.
 */
export class PlainError extends Error {}

/**
 * The first figure in a value past what the bundled encoder states unchanged.
 * A wider one is hashed as a neighbour of itself, so the id a signature covers
 * and the figure the contract carries would name different transfers.
 */
export function widestInt(held: unknown): bigint | undefined {
  if (typeof held === 'bigint') {
    return held > MAX_EXACT_INT || held < -MAX_EXACT_INT ? held : undefined
  }
  if (Array.isArray(held)) {
    for (const element of held) {
      const wide = widestInt(element)
      if (wide !== undefined) return wide
    }
    return undefined
  }
  if (typeof held === 'object' && held !== null) {
    for (const entry of Object.values(held)) {
      const wide = widestInt(entry)
      if (wide !== undefined) return wide
    }
  }
  return undefined
}

/** the widest an int64 travels through the transaction encoder unchanged */
export const MAX_EXACT_INT = 9007199254740991n

/** Route-local failures; the envelope carries the message alone. */
export class JavaExceptionError extends Error {}

/** A transaction field the protobuf encoder cannot represent without loss. */
export class TransactionEncodingError extends JavaExceptionError {}

/** the number parser rejecting a non-numeric field, or a missing one */
export class NumberFormatError extends JavaExceptionError {
  constructor(input: string | undefined) {
    super(input === undefined ? 'Cannot parse null string' : `For input string: "${input}"`)
  }
}

/** the protobuf merge refusing a field whose JSON type is wrong */
export class MergeParseError extends JavaExceptionError {
  constructor(message: string) {
    super(message)
  }
}

/** hex decoding rejecting a non-hex string */
export class HexDecodeError extends JavaExceptionError {
  /**
   * The decoder indexes a 128-entry table by character code, so a character
   * outside ASCII is reported by where it landed rather than as a bad digit.
   */
  constructor(text = '') {
    const wide = [...text].find((char) => char.charCodeAt(0) > 127)
    super(
      wide === undefined
        ? 'exception decoding Hex string: invalid characters encountered in Hex string'
        : `exception decoding Hex string: Index ${wide.charCodeAt(0)} out of bounds for length 128`,
    )
  }
}

/** protobuf refusing to parse the bytes it was handed */
export class ProtobufParseError extends JavaExceptionError {
  constructor() {
    super(
      'While parsing a protocol message, the input ended unexpectedly in the middle of a field.' +
        '  This could mean either that the input has been truncated or that an embedded message' +
        ' misreported its own length.',
    )
  }
}

/** the number parse over whatever text the query string carried, null included */
function parseLongText(text: string | undefined): void {
  if (text === undefined) throw new NumberFormatError(undefined)
  if (!/^[+-]?\d+$/.test(text)) throw new NumberFormatError(text)
  const parsed = BigInt(text)
  if (parsed > INT64_MAX || parsed < INT64_MIN) {
    throw new NumberFormatError(text)
  }
}

/** the longest decimal that still fits the compact representation */
const COMPACT_DECIMAL_DIGITS = 18

/**
 * The same field read out of a body, where it becomes a decimal first:
 * text that is not a number names the character it stopped at, and a value
 * with a fractional part is refused rather than rounded.
 */
function parseBigDecimalExact(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new JavaExceptionError('Rounding necessary')
    }
    return
  }
  // an object or a list is read back as the JSON it came in as
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  if (text === '') throw new JavaExceptionError('Zero length BigDecimal')
  if ((text.match(/\./g) ?? []).length > 1) {
    throw new JavaExceptionError('Character array contains more than one decimal point.')
  }
  const offending = /[^0-9.eE+-]/.exec(text)
  if (offending !== null) {
    // a value short enough to fit a long is read digit by digit and names the
    // character it stopped at; a longer one is read as a whole and reports
    // only that the exponent it was looking for is not there
    throw new JavaExceptionError(
      text.length > COMPACT_DECIMAL_DIGITS
        ? 'Character array is missing "e" notation exponential mark.'
        : `Character ${offending[0]} is neither a decimal digit number, decimal point, nor "e" notation exponential mark.`,
    )
  }
  if (/^[+-]?$/.test(text)) {
    throw new JavaExceptionError('No digits found.')
  }
  if (!/^[+-]?\d+$/.test(text)) {
    throw new JavaExceptionError('Rounding necessary')
  }
}

/**
 * A required numeric parameter: absent is a parameter error, non-numeric a
 * number-format one.
 */
export function requireLongParam(params: HandlerParams, key: string): void {
  const value = params[key]
  if (!isPostBody(params)) {
    parseLongText(value === undefined || value === null ? undefined : String(value))
    return
  }
  // the body read reports a missing key by name
  if (value === undefined || value === null) {
    throw new JavaExceptionError(`key [${key}] does not exist`)
  }
  parseBigDecimalExact(value)
}

/**
 * The paginated lists read each bound on its own. Off a query string that is
 * one number parse per bound, so either one missing fails; in a body both
 * are merged into a protobuf message, where an absent bound is simply zero.
 */
export function requireIntFields(params: HandlerParams, keys: string[]): void {
  if (!isPostBody(params)) {
    for (const key of keys) {
      const value = params[key]
      parseLongText(value === undefined || value === null ? undefined : String(value))
    }
    return
  }
  for (const key of keys) mergeInt64Field(params, key)
}

/** whether this request's fields follow the protobuf merge rules */
export function isPostBody(params: HandlerParams): boolean {
  return params[HTTP_METHOD] === 'POST'
}

/**
 * A numeric parameter a servlet reads but the answer here does not depend on.
 * It is still parsed, because a value that cannot be parsed is refused before
 * the store is consulted.
 */
export function requireNumericField(params: HandlerParams, key: string): void {
  const value = params[key]
  if (value === undefined || value === null) return
  if (!isPostBody(params)) {
    parseLongText(String(value))
    return
  }
  mergeInt64Field(params, key)
}

/**
 * A numeric field read as a decimal rather than merged: an absent one is
 * zero, and one with a fractional part is refused rather than rounded.
 */
export function longValue(params: HandlerParams, key: string): bigint {
  const value = params[key]
  if (value === undefined || value === null) return 0n
  parseBigDecimalExact(value)
  return BigInt(String(value))
}
