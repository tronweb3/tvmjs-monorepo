import { EthereumJSErrorWithoutCode } from '@tvmjs/util'

import type { TronTransactionIdPolicy } from './types.ts'

/**
 * Runtime validation for JavaScript callers, where the TypeScript union is not enforced.
 * Keep this at public execution boundaries so an invalid policy is rejected before hooks,
 * checkpoints, hardfork changes, or state cleanup can run.
 */
export function validateTronTransactionIdPolicy(policy: unknown): TronTransactionIdPolicy {
  const resolved = policy ?? 'fallback-to-tx-hash'
  if (resolved !== 'fallback-to-tx-hash' && resolved !== 'require-explicit') {
    throw EthereumJSErrorWithoutCode(`Invalid TRON transaction ID policy: ${resolved}`)
  }
  return resolved
}
