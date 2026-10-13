import { parseInteger } from './input.ts'
import { INT64_MAX } from './intBounds.ts'

/** Read a JSON-safe balance value as an exact non-negative sun amount. */
export function parseBalance(value: unknown, label: string): bigint {
  return parseInteger(value, label, { max: INT64_MAX, unit: 'sun' })
}
