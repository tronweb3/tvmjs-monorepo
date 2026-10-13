/**
 * Fixed identity and client conventions of the dev chain. Tunable chain
 * parameters live in config (ChainParameters) — this file is only for values
 * that are not parameters of the chain itself.
 */

/**
 * An absent fee_limit is zero, not a courtesy default — proto3 omits the field
 * at its default, so the execution side gets no energy budget at all.
 */
export const DEFAULT_FEE_LIMIT_SUN = 0

/** per-contract allowance the bandwidth charge adds for the result field */
export const MAX_RESULT_SIZE_IN_TX = 64

/** issuance may lock at most this many tranches of its own supply */
export const MAX_FROZEN_SUPPLY_NUMBER = 10
/** the lock window a tranche may name, in days */
export const MIN_FROZEN_SUPPLY_TIME = 1
export const MAX_FROZEN_SUPPLY_TIME = 3652

/** the chain-wide daily free bandwidth an issuance may not meet or exceed */
export const ONE_DAY_NET_LIMIT = 57_600_000_000

/** one frozen-supply day, in milliseconds */
export const FROZEN_PERIOD_MS = 86_400_000
