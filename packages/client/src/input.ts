import { hexToBytes } from '@tvmjs/util'

/** A bigint, safe integer number, or decimal / 0x-prefixed integer string. */
export type IntegerInput = bigint | number | string
/** Bytes or hexadecimal text, with an optional 0x prefix. */
export type BytesInput = Uint8Array | string

/** Exact integers at the program/configuration boundary. */
export function parseInteger(
  value: unknown,
  label: string,
  { min = 0n, max, unit }: { min?: bigint; max?: bigint; unit?: string } = {},
): bigint {
  const expected = `${label} must be an integer${unit === undefined ? '' : ` in ${unit}`}`
  if (typeof value === 'number' && !Number.isInteger(value)) throw new TypeError(expected)
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError(`${label} is past what a JSON number states exactly; write it as a string`)
  }
  if (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError(expected)
  }
  const text = String(value).trim()
  if (!/^(?:[+-]?\d+|0[xX][0-9a-fA-F]+)$/.test(text)) throw new TypeError(expected)
  const integer = BigInt(text)
  if (integer < min) throw new RangeError(`${label} must be at least ${min}, got ${integer}`)
  if (max !== undefined && integer > max) {
    throw new RangeError(`${label} must be at most ${max}, got ${integer}`)
  }
  return integer
}

/** Hexadecimal text or bytes, captured before asynchronous work begins. */
export function parseBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value.slice()
  if (typeof value !== 'string') throw new TypeError(`${label} must be hex text or a Uint8Array`)
  const hex = value.replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError(`${label} must contain hexadecimal bytes`)
  return hexToBytes(`0x${hex.length % 2 === 0 ? hex : `0${hex}`}`)
}
