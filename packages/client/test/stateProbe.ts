import { bytesToHex } from '@tvmjs/util'
import { nodeCore } from '../src/core/nodeAccess.ts'

import type { TronNode } from '../src/node.ts'

/**
 * Full-state fingerprint. The merkle root covers every account, balance,
 * nonce, code and storage slot; the other fields cover everything the node
 * keeps beside the trie — block identity, the tx index, both registries, the
 * name and id tables, the burn counter and the whole per-account side table.
 * Two equal probes mean an operation left no trace anywhere — the invariant
 * every rejected broadcast must satisfy.
 *
 * The side table is sampled raw rather than as decayed readings: usage decays
 * with time, so two different ledgers read equal at any single instant and a
 * rejected broadcast could shift a recovery window or a billing stamp
 * unnoticed.
 */
export interface StateProbe {
  stateRoot: string
  height: bigint
  headBlockID: string
  /** txids sealed into the head block, in order */
  headTxs: string
  /** every indexed txid */
  txIds: string
  assets: string
  contracts: string
  accountNames: string
  accountIds: string
  /** every per-account record beside the trie */
  accountRecords: string
  /** Stake 2.0 delegation entries and the pair index, serialised */
  delegations: string
  delegationPairs: string
  /** Stake 1.0 delegation entries and the pair index, serialised */
  legacyDelegations: string
  legacyDelegationPairs: string
  /** chain-wide staked weights, net/energy in TRX */
  stakeWeights: string
  burnedSun: string
}

/** JSON with sorted keys and stringified bigints: content, not identity */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'bigint') return entry.toString()
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    }
    return entry
  })
}

export async function probeState(node: TronNode): Promise<StateProbe> {
  const core = nodeCore(node)
  const head = core.head()
  return {
    stateRoot: bytesToHex(await core.stateManager.getStateRoot()),
    height: core.blocks.height(),
    headBlockID: head.blockID,
    headTxs: head.txs.map((tx) => tx.txid).join(','),
    txIds: [...core.txs.keys()].sort().join(','),
    assets: canonical(core.assets.list()),
    contracts: canonical([...core.contracts].sort(([a], [b]) => (a < b ? -1 : 1))),
    accountNames: canonical([...core.accountNames].sort()),
    accountIds: canonical([...core.accountIds].sort()),
    accountRecords: canonical(core.accountRecordEntries()),
    delegations: canonical([...core.delegations].sort(([a], [b]) => (a < b ? -1 : 1))),
    delegationPairs: core.delegationPairKeys().join(','),
    legacyDelegations: canonical(
      core
        .legacyDelegationEntries()
        .sort((a, b) => (`${a.fromKey}>${a.toKey}` < `${b.fromKey}>${b.toKey}` ? -1 : 1)),
    ),
    legacyDelegationPairs: core.legacyDelegationPairKeys().join(','),
    stakeWeights: `${core.totalNetWeightTrx}/${core.totalEnergyWeightTrx}`,
    burnedSun: core.burnedSun.toString(),
  }
}
