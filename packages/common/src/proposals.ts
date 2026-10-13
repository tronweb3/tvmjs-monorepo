import type { TronProposalsDict } from './types.ts'

/**
 * TRON governance proposals known to TVMJS.
 *
 * Entries register proposal IDs and names so activation state can be stored
 * and queried via `Common` (see `CommonOpts.activatedProposals` /
 * `Common.isActivatedProposal`). Common does not attach EIPs or params to a
 * proposal; execution consumers are responsible for applying the relevant
 * feature gates. Whether and in which combination these proposals activate on
 * a given network is subject to TRON governance.
 */
export const tronProposalsDict: TronProposalsDict = Object.freeze({
  /**
   * Proposal 65: ALLOW_HIGHER_LIMIT_FOR_MAX_CPU_TIME_OF_ONE_TX
   * Scope: adds 1 Energy to MLOAD, MSTORE and MSTORE8.
   */
  65: Object.freeze({ name: 'ALLOW_HIGHER_LIMIT_FOR_MAX_CPU_TIME_OF_ONE_TX' }),
  /**
   * Proposal 95: ALLOW_TVM_PRAGUE
   * Scope: EIP-2935 (execution gate not wired in TVMJS yet)
   */
  95: Object.freeze({ name: 'ALLOW_TVM_PRAGUE' }),
  /**
   * Proposal 96: ALLOW_TVM_OSAKA
   * Scope: EIP-7939, EIP-7823, EIP-7883, EIP-7951, TIP-854, TIP-871
   */
  96: Object.freeze({ name: 'ALLOW_TVM_OSAKA' }),
})
