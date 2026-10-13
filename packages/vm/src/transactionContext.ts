import { EthereumJSErrorWithoutCode } from '@tvmjs/util'

import type { TypedTransaction } from '@tvmjs/tx'

/** Reject retired transaction contexts before events or state checkpoints. */
export function validateTransactionContext(tx: TypedTransaction) {
  const type = Number(tx.type)
  if (type === 3) {
    throw EthereumJSErrorWithoutCode('Blob transaction type 0x03 is no longer supported')
  }
  if (type === 4) {
    throw EthereumJSErrorWithoutCode('EIP-7702 transaction type 0x04 is no longer supported')
  }
  for (const field of ['authorizationList', 'authorization_list']) {
    if (field in tx) {
      throw EthereumJSErrorWithoutCode(`EIP-7702 transaction field ${field} is no longer supported`)
    }
  }
}
