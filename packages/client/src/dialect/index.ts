import { Registry } from './registry.ts'
import { registerTreDialect } from './tre/index.ts'
import { registerTronDialect } from './tron/wallet/index.ts'

/**
 * Dialects served by this dev node, side by side on one core:
 * - tron: the TRON REST surface (wallet / walletsolidity),
 *         and nothing beyond it
 * - tre:  dev-node extensions — cheat codes (tre_*), debug_* tracing,
 *         account discovery (admin/accounts-json); caller-contract driven,
 *         part of neither the TRON nor the Ethereum protocol
 * - eth:  reserved (eth_* JSON-RPC on the same core)
 */
export function createDefaultRegistry(): Registry {
  const registry = new Registry()
  registerTronDialect(registry)
  registerTreDialect(registry)
  return registry
}

// Routes contain no node state. The provider and HTTP transport use the same
// package-private table for dispatch and response formatting.
export const defaultRegistry = createDefaultRegistry()
