import { bytesToHex, createAddressFromString } from '@tvmjs/util'
import { TronWeb } from 'tronweb'

import { MergeError, fieldTokens } from './mergeValue.ts'

import { RAW_BODY } from '../registry.ts'
import type { HandlerParams } from '../registry.ts'
import type { MergeToken } from './mergeValue.ts'

import type { Address } from '@tvmjs/util'

/** a decoded address is 21 bytes and its first byte is the mainnet prefix */
const TRON_ADDRESS = /^41[0-9a-fA-F]{40}$/

/**
 * Parse a TRON-facing address (base58 T… or 41-prefixed hex) into the internal
 * 20-byte TVMJS Address. Any other prefix or length is a parse error: the first
 * byte is part of the address.
 */
export function parseTronAddress(input: string): Address {
  const text = input.startsWith('0x') ? input.slice(2) : input
  // Hex addresses retain the TRON network byte, including after a 0x prefix.
  if (input.startsWith('0X') || (input.startsWith('0x') && !TRON_ADDRESS.test(text))) {
    throw new Error(`Invalid address: ${input}`)
  }
  let hex: string
  try {
    hex = TronWeb.address.toHex(text) // accepts base58 and 41-hex
  } catch {
    throw new Error(`Invalid address: ${input}`)
  }
  if (!TRON_ADDRESS.test(hex)) {
    throw new Error(`Invalid address: ${input}`)
  }
  return createAddressFromString(`0x${hex.slice(2).toLowerCase()}`)
}

/** the same parse, reporting failure instead of throwing */
export function tryParseTronAddress(input: string): Address | undefined {
  try {
    return parseTronAddress(input)
  } catch {
    return undefined
  }
}

/**
 * Dev extensions also accept 0x-prefixed, 20-byte EVM addresses.
 */
export function parseAnyAddress(input: string): Address {
  if ((input.startsWith('0x') || input.startsWith('0X')) && input.length === 42) {
    return createAddressFromString(`0x${input.slice(2).toLowerCase()}`)
  }
  return parseTronAddress(input)
}

/** TVMJS Address → '41' + 40 hex (TRON hex, no 0x) */
export function toTronHex(address: Address): string {
  return `41${bytesToHex(address.bytes).slice(2)}`
}

/** TVMJS Address → base58 T… */
export function toBase58(address: Address): string {
  return TronWeb.address.fromHex(toTronHex(address))
}

/** response-side formatting: hex by default, base58 when visible=true */
export function formatTronAddress(address: Address, visible = false): string {
  return visible ? toBase58(address) : toTronHex(address)
}

/**
 * Boolean request flags: true only for the
 * literal `true`, case-insensitive, and false for anything else including
 * absent. Query strings deliver every value as a string, so both forms arrive.
 */
export function boolParam(value: unknown): boolean {
  if (value === true) return true
  return typeof value === 'string' && value.toLowerCase() === 'true'
}

/** the visible request flag; query strings deliver it as 'true' */
export function isVisible(params: HandlerParams): boolean {
  return boolParam(params.visible)
}

/**
 * Request-side address parsing with the real merge semantics: visible=true
 * expects base58, visible=false expects 41-hex — a mismatch is a parse error,
 * never a silent conversion.
 */
export function parseRequestAddress(input: string, visible: boolean): Address {
  if (visible !== input.startsWith('T')) {
    throw new Error(`Invalid address: ${input}`)
  }
  return parseTronAddress(input)
}

/** the merge failure for an unparseable address field */
export class AddressMergeError extends MergeError {}

/** whether a request field is text the lenient hex decoder accepts */
export function isHexText(value: unknown): boolean {
  if (value !== undefined && value !== null && typeof value !== 'string') return false
  const raw = String(value ?? '').replace(/^0x/i, '')
  return raw === '' || /^[0-9a-fA-F]+$/.test(raw)
}

/** A decoder failure preserves the useful message without leaking its origin. */
export class HexDecoderError extends Error {
  constructor(text = '') {
    const wide = [...text].find((char) => char.charCodeAt(0) > 127)
    super(
      wide === undefined
        ? 'exception decoding Hex string: invalid characters encountered in Hex string'
        : `exception decoding Hex string: Index ${wide.charCodeAt(0)} out of bounds for length 128`,
    )
  }
}

/**
 * The 1-based column a field's value starts at. A POST is judged against the
 * body as it arrived; a query string is rebuilt into a one-field object first,
 * which puts the value right after `{"<field>":`.
 */
export function mergeColumn(params: HandlerParams, field: string): number {
  const raw = params[RAW_BODY]
  const body = typeof raw === 'string' ? raw : ''
  if (body === '') return field.length + 5
  const token = fieldTokens(params, field)[0]
  return token === undefined ? field.length + 5 : token.column
}

/** the merge stage's judgement of an address field, without the lookup */
export function mergeAddressField(params: HandlerParams, key: string, field: string): void {
  optionalRequestAddress(params, key, field)
}

/**
 * One address token as the merge reads it. The merge decodes a single form —
 * hex bytes, or base58 under `visible` — so a value in neither fails here; one
 * in the right form but the wrong length gets through, and the store simply
 * finds nothing under it.
 */
export function mergeAddressToken(
  token: MergeToken,
  visible: boolean,
  field: string,
): Address | undefined {
  // a bytes field wants a string token; a number or a boolean never gets as
  // far as being decoded
  if (!token.quoted) throw new AddressMergeError(token, 'Expected string.')
  const raw = token.text.slice(1, -1)
  if (raw === '') return undefined
  // the prefix is matched exactly, and what follows may be any number of hex
  // digits
  if (!visible && !/^[0-9a-fA-F]*$/.test(raw.startsWith('0x') ? raw.slice(2) : raw)) {
    throw new AddressMergeError(token, 'INVALID hex String')
  }
  try {
    return parseRequestAddress(raw, visible)
  } catch {
    if (!visible) return undefined
    throw new AddressMergeError(token, `invalid address for field: ${field}`)
  }
}

/**
 * Request-side address parsing that distinguishes absent from malformed: an
 * omitted field leaves the protobuf at its default and the query simply finds
 * nothing, while a present-but-unparseable value fails the merge.
 */
export function optionalRequestAddress(
  params: HandlerParams,
  key: string,
  field: string,
): Address | undefined {
  const visible = isVisible(params)
  let address: Address | undefined
  for (const token of fieldTokens(params, key)) {
    if (token.text === 'null') continue
    address = mergeAddressToken(token, visible, field)
  }
  return address
}
