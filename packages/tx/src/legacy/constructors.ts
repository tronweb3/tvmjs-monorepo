import { RLP } from '@tvmjs/rlp'
import { EthereumJSErrorWithoutCode, validateNoLeadingZeroes } from '@tvmjs/util'

import { LegacyTx } from './tx.ts'

import type { TxOptions } from '../types.ts'
import type { TxData, TxValuesArray } from './tx.ts'

/**
 * Instantiate a transaction from a data dictionary.
 *
 * Format: { nonce, gasPrice, gasLimit, to, value, data, v, r, s }
 *
 * Notes:
 * - All parameters are optional and have some basic default values
 */
export function createLegacyTx(txData: TxData, opts: TxOptions = {}) {
  return new LegacyTx(txData, opts)
}

/**
 * Create a transaction from an array of byte encoded values ordered according to the devp2p network encoding - format noted below.
 *
 * Format: `[nonce, gasPrice, gasLimit, to, value, data, v, r, s]`
 */
export function createLegacyTxFromBytesArray(values: TxValuesArray, opts: TxOptions = {}) {
  // If length is not 8, it has length 11. If v/r/s are empty Uint8Arrays, it is still an unsigned transaction
  // This happens if you get the RLP data from `raw()`
  if (values.length !== 6 && values.length !== 9 && values.length !== 8 && values.length !== 11) {
    throw EthereumJSErrorWithoutCode(
      'Invalid transaction. Only expecting 6 (for eth unsigned tx)/9 values (for eth signed tx) 8 (for tron unsigned tx)/11 values (for tron signed tx).',
    )
  }

  let nonce, gasPrice, gasLimit, to, value, tokenId, tokenValue, data, v, r, s
  if (values.length === 6 || values.length === 9) {
    ;[nonce, gasPrice, gasLimit, to, value, data, v, r, s] = values
  } else {
    ;[nonce, gasPrice, gasLimit, to, value, tokenId, tokenValue, data, v, r, s] = values
  }

  validateNoLeadingZeroes({ nonce, gasPrice, gasLimit, value, v, r, s })

  return new LegacyTx(
    {
      nonce,
      gasPrice,
      gasLimit,
      to,
      value,
      tokenId,
      tokenValue,
      data,
      v,
      r,
      s,
    },
    opts,
  )
}

/**
 * Instantiate a transaction from a RLP serialized tx.
 *
 * Format: `rlp([nonce, gasPrice, gasLimit, to, value, data,
 * signatureV, signatureR, signatureS])`
 */
export function createLegacyTxFromRLP(serialized: Uint8Array, opts: TxOptions = {}) {
  const values = RLP.decode(serialized)

  if (!Array.isArray(values)) {
    throw EthereumJSErrorWithoutCode('Invalid serialized tx input. Must be array')
  }

  return createLegacyTxFromBytesArray(values as TxValuesArray, opts)
}
