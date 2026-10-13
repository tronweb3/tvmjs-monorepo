import { EthereumJSErrorWithoutCode } from '@tvmjs/util'

import { TronMainnet, TronNile, TronShasta } from './chains.ts'
import { Common } from './common.ts'

import type { BaseOpts, ChainConfig, CustomChainConfig } from './types.ts'

const CUSTOM_CHAIN_FIELDS = new Set([
  'name',
  'chainId',
  'comment',
  'url',
  'bootstrapNodes',
  'dnsNetworks',
])

/**
 * Creates a {@link Common} object with custom TRON identity and discovery fields.
 *
 * Execution settings are supplied through {@link BaseOpts}. Network metadata cannot
 * be added or replaced here; use `new Common({ chain: completeConfig })` to supply it.
 *
 * ```javascript
 * import { createCustomCommon, TronMainnet } from '@tvmjs/common'
 *
 * createCustomCommon({chainId: 123}, TronMainnet)
 * ```
 *
 * @param partialConfig Identity and discovery overrides
 * @param baseChain TRON execution configuration used as a base, e.g. `TronMainnet`
 * @param opts Custom chain options to set various {@link BaseOpts}
 */
export function createCustomCommon(
  partialConfig: CustomChainConfig,
  baseChain: ChainConfig,
  opts: BaseOpts = {},
): Common {
  if (partialConfig === null || typeof partialConfig !== 'object' || Array.isArray(partialConfig)) {
    throw EthereumJSErrorWithoutCode('createCustomCommon() overrides must be an object')
  }
  // Reject forbidden fields even when inherited or non-enumerable, rather than silently ignoring them.
  const fields = new Set<PropertyKey>(Reflect.ownKeys(partialConfig))
  for (const field of [
    'execution',
    'genesis',
    'consensus',
    'defaultHardfork',
    'hardforks',
    'customHardforks',
    'depositContractAddress',
  ]) {
    if (field in partialConfig) fields.add(field)
  }
  for (const field of fields) {
    if (typeof field !== 'string' || !CUSTOM_CHAIN_FIELDS.has(field)) {
      throw EthereumJSErrorWithoutCode(
        `createCustomCommon() cannot override ${String(field)}. Only identity and discovery fields are supported; supply network metadata in a complete TRON ChainConfig.`,
      )
    }
  }
  if ('chain' in opts) {
    throw EthereumJSErrorWithoutCode('createCustomCommon() options cannot override the base chain')
  }
  return new Common({
    ...opts,
    chain: {
      ...baseChain,
      ...partialConfig,
    },
  })
}

/**
 * TRON network identifiers for chainId presets.
 * These are execution-only presets for CHAINID opcode support, not full chain configurations.
 */
export type TronNetwork = 'mainnet' | 'nile' | 'shasta'

/**
 * TRON chainId values derived from block 0 hash of each network.
 * @see https://developers.tron.network/docs/networks
 */
const TRON_CHAIN_CONFIGS: Record<TronNetwork, ChainConfig> = {
  mainnet: TronMainnet,
  nile: TronNile,
  shasta: TronShasta,
}

/**
 * Creates a {@link Common} instance with TRON network chainId preset for CHAINID opcode execution.
 *
 * This is an execution-only preset that provides the correct chainId value for TRON networks
 * while using the independent TRON execution profile and capability matrix.
 * Genesis, consensus and network discovery data are intentionally omitted.
 * Use Common.hasGenesis() / hasConsensus() before accessing network metadata.
 *
 * Supply verified network metadata through a complete ChainConfig when needed.
 *
 * @param network - TRON network identifier ('mainnet', 'nile', or 'shasta')
 * @param opts - Optional configuration (e.g., activatedProposals, hardfork)
 * @returns A new {@link Common} instance with the specified TRON chainId
 *
 * @example
 * ```typescript
 * import { createTronChainIdCommon } from '@tvmjs/common'
 *
 * const common = createTronChainIdCommon('mainnet')
 * console.log(common.chainId()) // 728126428n
 * console.log(common.chainName()) // 'tron-mainnet'
 * ```
 */
export function createTronChainIdCommon(network: TronNetwork, opts: BaseOpts = {}): Common {
  if (!Object.prototype.hasOwnProperty.call(TRON_CHAIN_CONFIGS, network)) {
    throw EthereumJSErrorWithoutCode(
      `Invalid TRON network: ${network}. Valid options: ${Object.keys(TRON_CHAIN_CONFIGS).join(', ')}`,
    )
  }
  return new Common({
    ...opts,
    chain: TRON_CHAIN_CONFIGS[network],
  })
}

/**
 * Mainnet execution settings used by the local development client in v1.2.0.
 * For historical replay, supply the proposals and EIPs active at that block instead.
 */
export function createCurrentTronMainnetCommon(opts: BaseOpts = {}): Common {
  return createTronChainIdCommon('mainnet', {
    ...opts,
    activatedProposals: opts.activatedProposals ?? [65, 96],
    eips: opts.eips ?? [7939],
  })
}
