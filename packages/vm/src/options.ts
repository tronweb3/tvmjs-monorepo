import { EthereumJSErrorWithoutCode } from '@tvmjs/util'

import type { VMOpts } from './types.ts'

/** Check nested TVM options before spreading them or initializing shared state. */
export function rejectRemovedTVMOptions(opts: VMOpts) {
  if (opts.tvmOpts === undefined) return
  for (const option of ['allowUnlimitedContractSize', 'allowUnlimitedInitCodeSize']) {
    if (option in opts.tvmOpts) {
      throw EthereumJSErrorWithoutCode(
        `The tvmOpts.${option} option has been removed; TRON does not use EIP-170 or EIP-3860 size limits`,
      )
    }
  }
}
