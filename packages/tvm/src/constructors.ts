import { Common, Mainnet } from '@tvmjs/common'
import { SimpleStateManager } from '@tvmjs/statemanager'

import { TVM } from './index.ts'
import { NobleBN254 } from './precompiles/index.ts'
import { TVMMockBlockchain } from './types.ts'

import type { TVMOpts } from './index.ts'

/**
 * Use this async static constructor for the initialization
 * of an TVM object
 *
 * @param createOpts The TVM options
 * @returns A new TVM
 */
export async function createTVM(createOpts?: TVMOpts) {
  const opts = createOpts ?? ({} as TVMOpts)

  opts.bn254 = new NobleBN254()

  if (opts.common === undefined) {
    opts.common = new Common({ chain: Mainnet })
  }

  if (opts.blockchain === undefined) {
    opts.blockchain = new TVMMockBlockchain()
  }

  if (opts.stateManager === undefined) {
    opts.stateManager = new SimpleStateManager()
  }

  return new TVM(opts)
}
