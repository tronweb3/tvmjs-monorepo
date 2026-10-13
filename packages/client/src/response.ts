import { TextBody } from './dialect/registry.ts'
import { Float } from './dialect/tron/proto.ts'

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)

/** Copy replies; program transaction integers use number when exactly representable. */
export function responseSnapshot(value: unknown, wire: boolean, transaction = false): unknown {
  if (!wire && value instanceof Float) return Number(value.text)
  if (!wire && value instanceof TextBody) return value.text
  if (
    !wire &&
    transaction &&
    typeof value === 'bigint' &&
    value >= -MAX_SAFE_INTEGER &&
    value <= MAX_SAFE_INTEGER
  ) {
    return Number(value)
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((entry) => responseSnapshot(entry, wire, transaction))
  }
  if (value instanceof Uint8Array) return value.slice()
  const inTransaction =
    transaction || ('raw_data' in value && 'raw_data_hex' in value && 'txID' in value)
  // Wire printers retain their wrappers; ordinary data remains detached from node state.
  return Object.create(
    Object.getPrototypeOf(value),
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        {
          value: responseSnapshot(entry, wire, inTransaction),
          enumerable: true,
          writable: true,
          configurable: true,
        },
      ]),
    ),
  )
}
