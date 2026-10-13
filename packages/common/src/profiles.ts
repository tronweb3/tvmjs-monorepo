import { Hardfork } from './enums.ts'

/**
 * The TRON execution profile. Parameter groups are listed explicitly instead of
 * inheriting an Ethereum network's hardfork schedule or consensus transitions.
 *
 * EIP numbers identify shared implementations, not Ethereum network upgrades.
 * Energy accounting follows TRON, without Ethereum access warming or refunds.
 * EIP-2930 is retained for transaction encoding, not access-list pricing.
 * Group 607 retains shared EXP, replay-protection and nonce behavior, without
 * EIP-170 code size limits. EIP-3860 initcode limits and metering are absent.
 * Blob transactions, beacon roots, withdrawals and Ethereum consensus are absent.
 * Governance proposals remain independent of explicitly selected capabilities.
 */
export const tronExecutionProfile = Object.freeze({
  hardfork: Hardfork.Tron,
  eips: Object.freeze([
    1, 606, 608, 607, 609, 1013, 1716, 1679, 2565, 2718, 2930, 1559, 3198, 3541, 3855, 1153, 5656,
    6780,
  ]),
  optionalEIPs: Object.freeze([7939]),
})
