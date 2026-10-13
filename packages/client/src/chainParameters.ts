import type { ChainParameters } from './config.ts'

/**
 * GASPRICE reports the energy price only to version-one contracts, and a
 * deployment reaches version one only while the compatible-EVM proposal is
 * enabled. This chain keeps that proposal off, so the opcode reads zero. The
 * energy bill is settled from `energyFee` on its own path.
 */
export const TRON_VM_GAS_PRICE = 0n

/**
 * Legal range per chain parameter, mirroring the chain's own bounds: priced
 * parameters take the proposal-validation ranges (fees 1e17,
 * permission/multisign fees 1e11, memoFee 1e9, freeNetLimit 1e5,
 * totalNetLimit 1e12, maintenance interval [3·27s, 24h], and
 * maxDelegateLockPeriod up to one year of blocks). `unfreezeDelayDays` uses
 * the config-side clamp [0, 365]; gate flags hold 0 or 1. Floors of 1 on
 * energyFee and maxDelegateLockPeriod are this node's own: an energy price of
 * 0 breaks the budget arithmetic. Configuration values must also fit within
 * JavaScript's safe integer range, even when the protocol ceiling is higher.
 */
const CHAIN_PARAMETER_RANGES: Record<keyof ChainParameters, { floor: number; ceiling?: number }> = {
  energyFee: { floor: 1 },
  transactionFee: { floor: 0, ceiling: 100_000_000_000_000_000 },
  memoFee: { floor: 0, ceiling: 1_000_000_000 },
  forbidTransferToContract: { floor: 0, ceiling: 1 },
  allowMultiSign: { floor: 0, ceiling: 1 },
  allowUpdateAccountName: { floor: 0, ceiling: 1 },
  allowSameTokenName: { floor: 0, ceiling: 1 },
  allowDelegateResource: { floor: 0, ceiling: 1 },
  allowNewResourceModel: { floor: 0, ceiling: 1 },
  allowCancelAllUnfreezeV2: { floor: 0, ceiling: 1 },
  allowChangeDelegation: { floor: 0, ceiling: 1 },
  totalSignNum: { floor: 0 },
  updateAccountPermissionFee: { floor: 0, ceiling: 100_000_000_000 },
  multiSignFee: { floor: 0, ceiling: 100_000_000_000 },
  assetIssueFee: { floor: 0, ceiling: 100_000_000_000_000_000 },
  createAccountFee: { floor: 0, ceiling: 100_000_000_000_000_000 },
  createNewAccountFeeInSystemContract: { floor: 0, ceiling: 100_000_000_000_000_000 },
  freeNetLimit: { floor: 0, ceiling: 100_000 },
  totalNetLimit: { floor: 0, ceiling: 1_000_000_000_000 },
  totalEnergyCurrentLimit: { floor: 0, ceiling: 100_000_000_000_000_000 },
  maintenanceTimeIntervalMs: { floor: 81_000, ceiling: 86_400_000 },
  unfreezeDelayDays: { floor: 0, ceiling: 365 },
  checkFrozenTime: { floor: 0, ceiling: 1 },
  minFrozenTime: { floor: 0 },
  maxFrozenTime: { floor: 0 },
  maxDelegateLockPeriod: { floor: 1, ceiling: 10_512_000 },
  maxFeeLimit: { floor: 0, ceiling: 100_000_000_000_000_000 },
  accountUpgradeCost: { floor: 0, ceiling: 100_000_000_000_000_000 },
  maxCreateAccountTxSize: { floor: 500, ceiling: 10_000 },
  witnessPayPerBlock: { floor: 0, ceiling: 100_000_000_000_000_000 },
  witness127PayPerBlock: { floor: 0, ceiling: 100_000_000_000_000_000 },
}

/** What is wrong with a named parameter value, or undefined if it fits. */
export function chainParameterFault(name: string, value: unknown): string | undefined {
  const range = CHAIN_PARAMETER_RANGES[name as keyof ChainParameters]
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= range.floor &&
    (range.ceiling === undefined || value <= range.ceiling)
  ) {
    return undefined
  }
  // JSON parsing may already have rounded an unsafe integer before validation.
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return `must be a safe integer, got ${String(value)}`
  }
  return range.ceiling === undefined
    ? `must be an integer of at least ${range.floor}, got ${String(value)}`
    : `must be an integer between ${range.floor} and ${range.ceiling}, got ${String(value)}`
}
