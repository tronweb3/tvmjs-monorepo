import { Common, TronMainnet } from '@tvmjs/common'
import { MerkleStateManager } from '@tvmjs/statemanager'
import { TVMMockBlockchain, createTVM, getActivePrecompiles } from '@tvmjs/tvm'
import {
  Account,
  Address,
  EthereumJSErrorWithoutCode,
  createAccount,
  unprefixedHexToBytes,
} from '@tvmjs/util'

import { rejectRemovedTVMOptions } from './options.ts'
import { paramsVM } from './params.ts'
import { VM } from './vm.ts'

import type { VMOpts } from './types.ts'

/**
 * VM async constructor. Creates engine instance and initializes it.
 *
 * @param opts VM engine constructor options
 */
export async function createVM(opts: VMOpts = {}): Promise<VM> {
  rejectRemovedTVMOptions(opts)
  opts = { ...opts }
  // Save if a `StateManager` was passed (for activatePrecompiles)
  const didPassStateManager =
    opts.tvm?.stateManager !== undefined ||
    opts.tvmOpts?.stateManager !== undefined ||
    opts.stateManager !== undefined

  if (opts.tvm !== undefined && opts.tvmOpts !== undefined) {
    throw EthereumJSErrorWithoutCode('the tvm and tvmOpts options cannot be used in conjunction')
  }

  const commons = [opts.common, opts.tvmOpts?.common, opts.tvm?.common].filter(
    (common): common is Common => common !== undefined,
  )
  for (let i = 0; i < commons.length; i++) {
    for (let j = i + 1; j < commons.length; j++) {
      if (!commons[i].isCompatibleWith(commons[j])) {
        throw EthereumJSErrorWithoutCode(
          'Conflicting Common execution settings in common, tvmOpts.common or tvm.common',
        )
      }
    }
  }

  // Add common, SM, blockchain, TVM here. A supplied TVM already owns all three execution
  // resources. Otherwise a compatible tvmOpts value takes precedence over the top-level
  // option. Keep the exact same instances at the VM layer so transaction validation/state updates
  // and TVM execution cannot diverge.
  opts.common =
    opts.tvm?.common ?? opts.tvmOpts?.common ?? opts.common ?? new Common({ chain: TronMainnet })

  opts.stateManager =
    opts.tvm?.stateManager ??
    opts.tvmOpts?.stateManager ??
    opts.stateManager ??
    new MerkleStateManager({ common: opts.common })

  opts.blockchain =
    opts.tvm?.blockchain ?? opts.tvmOpts?.blockchain ?? opts.blockchain ?? new TVMMockBlockchain()

  if (opts.profilerOpts !== undefined) {
    const profilerOpts = opts.profilerOpts
    if (profilerOpts.reportAfterBlock === true && profilerOpts.reportAfterTx === true) {
      throw EthereumJSErrorWithoutCode(
        'Cannot have `reportProfilerAfterBlock` and `reportProfilerAfterTx` set to `true` at the same time',
      )
    }
  }

  if (opts.tvm === undefined) {
    let enableProfiler = false
    if (opts.profilerOpts?.reportAfterBlock === true || opts.profilerOpts?.reportAfterTx === true) {
      enableProfiler = true
    }
    const tvmOpts = opts.tvmOpts ?? {}
    opts.tvm = await createTVM({
      common: opts.common,
      stateManager: opts.stateManager,
      blockchain: opts.blockchain,
      profiler: {
        enabled: enableProfiler,
      },
      ...tvmOpts,
    })
  }

  // The TVM adds its parameter defaults during initialization. Compare again
  // with the final parameter set so a supplied top-level override cannot be
  // silently discarded by an initially empty tvmOpts.common instance.
  const executionCommon = opts.common.copy()
  executionCommon.updateParams(opts.params ?? paramsVM, opts.params !== undefined)
  for (const common of commons.slice(0, -1)) {
    const suppliedCommon = common.copy()
    if (opts.params !== undefined) suppliedCommon.updateParams(opts.params)
    if (!suppliedCommon.isCompatibleWith(executionCommon)) {
      throw EthereumJSErrorWithoutCode(
        'Conflicting Common execution settings after VM/TVM parameter initialization',
      )
    }
  }

  if (opts.activatePrecompiles === true && !didPassStateManager) {
    await opts.tvm.journal.checkpoint()
    // put 1 wei in each of the precompiles in order to make the accounts non-empty and thus not have them deduct `callNewAccount` gas.
    for (const [addressStr] of getActivePrecompiles(opts.common)) {
      const address = new Address(unprefixedHexToBytes(addressStr))
      let account = await opts.tvm.stateManager.getAccount(address)
      // Only do this if it is not overridden in genesis
      // Note: in the case that custom genesis has storage fields, this is preserved
      if (account === undefined) {
        account = new Account()
        const newAccount = createAccount({
          balance: 1,
          storageRoot: account.storageRoot,
        })
        await opts.tvm.stateManager.putAccount(address, newAccount)
      }
    }
    await opts.tvm.journal.commit()
  }

  return new VM(opts)
}
