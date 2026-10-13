import { BIGINT_0 } from '@tvmjs/util'

import type { Common } from '@tvmjs/common'
import type { RunState } from '../interpreter.ts'

/**
 * Returns the gas cost for accessing an address WITHOUT any side effects.
 * Use this to check if you have enough gas before committing to the access.
 *
 * @param {RunState} runState
 * @param {Uint8Array} address
 * @param {Common} common
 * @param {Boolean} chargeGas (default: true)
 * @param {Boolean} isSelfdestruct (default: false)
 * @returns {bigint} The gas cost for this address access
 */
export function getAddressAccessCost(
  runState: RunState,
  address: Uint8Array,
  common: Common,
  chargeGas = true,
  isSelfdestruct = false,
): bigint {
  if (!common.isActivatedEIP(2929)) return BIGINT_0

  const isCold = !runState.interpreter.journal.isWarmedAddress(address)

  if (isCold) {
    // CREATE, CREATE2 opcodes have the address warmed for free.
    // selfdestruct beneficiary address reads are charged an *additional* cold access
    // if binary tree not activated
    if (chargeGas && !common.isActivatedEIP(7864)) {
      return common.param('coldaccountaccessGas')
    } else if (chargeGas && common.isActivatedEIP(7864)) {
      // If binary tree is active, then the warmstoragereadGas should still be charged
      // This is because otherwise opcodes will have cost 0 (this is thus the base fee)
      return common.param('warmstoragereadGas')
    }
  } else if (chargeGas && !isSelfdestruct) {
    // Warm: (selfdestruct beneficiary address reads are not charged when warm)
    return common.param('warmstoragereadGas')
  }
  return BIGINT_0
}

/**
 * Warms an address (adds to EIP-2929 accessed addresses set).
 * Call this AFTER verifying you have enough gas for the access.
 *
 * @param {RunState} runState
 * @param {Uint8Array} address
 */
export function warmAddress(runState: RunState, address: Uint8Array): void {
  if (!runState.interpreter.journal.isWarmedAddress(address)) {
    runState.interpreter.journal.addWarmedAddress(address)
  }
}

/**
 * Adds address to accessedAddresses set if not already included.
 * Adjusts cost incurred for executing opcode based on whether address read
 * is warm/cold. (EIP 2929)
 *
 * Retained for the inactive EOF EXTCALL family. The TRON profile returns zero
 * before warming; ordinary TRON calls use their own Energy schedule.
 *
 * @param {RunState} runState
 * @param {Uint8Array}  address
 * @param {Common}   common
 * @param {Boolean}  chargeGas (default: true)
 * @param {Boolean}  isSelfdestruct (default: false)
 */
export function accessAddressEIP2929(
  runState: RunState,
  address: Uint8Array,
  common: Common,
  chargeGas = true,
  isSelfdestruct = false,
): bigint {
  if (!common.isActivatedEIP(2929)) return BIGINT_0

  const cost = getAddressAccessCost(runState, address, common, chargeGas, isSelfdestruct)
  warmAddress(runState, address)
  return cost
}
