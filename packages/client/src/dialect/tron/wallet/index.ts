import type { Registry } from '../../registry.ts'

import { registerAccountHandlers } from './account.ts'
import { registerAssetHandlers } from './asset.ts'
import { registerBroadcastHandlers } from './broadcast.ts'
import { registerChainHandlers } from './chain.ts'
import { registerContractHandlers } from './contract.ts'
import { registerNodeInfoHandlers } from './nodeinfo.ts'
import { registerSignWeightHandlers } from './signWeight.ts'
import { registerStakeQueryHandlers } from './stake.ts'
import { registerStubHandlers } from './stubs.ts'
import { registerTxHandlers } from './tx.ts'

/**
 * The TRON REST dialect: the wallet / walletsolidity surfaces,
 * exactly the wallet route manifest — nothing else belongs here
 * (dev extensions live in the tre dialect).
 */
export function registerTronDialect(registry: Registry): void {
  // read surfaces
  registerChainHandlers(registry)
  registerAccountHandlers(registry)
  registerSignWeightHandlers(registry)
  registerStakeQueryHandlers(registry)
  registerStubHandlers(registry)
  registerAssetHandlers(registry)
  registerContractHandlers(registry)
  registerTxHandlers(registry)
  registerNodeInfoHandlers(registry)
  // write surface (builders + broadcast)
  registerBroadcastHandlers(registry)
}
