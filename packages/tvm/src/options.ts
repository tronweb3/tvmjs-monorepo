import { EthereumJSErrorWithoutCode } from '@tvmjs/util'

import type { TVMOpts } from './types.ts'

/** Reject obsolete options before copying input or initializing execution resources. */
export function rejectRemovedSizeOptions(opts: TVMOpts = {}) {
  for (const option of ['allowUnlimitedContractSize', 'allowUnlimitedInitCodeSize']) {
    if (option in opts) {
      throw EthereumJSErrorWithoutCode(
        `The ${option} option has been removed; TRON does not use EIP-170 or EIP-3860 size limits`,
      )
    }
  }
}
