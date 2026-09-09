import { EthereumJSErrorWithoutCode } from '@tvmjs/util'

import { TronMainnet, TronNile, TronShasta } from './chains.ts'
import { Common, parseGethGenesis } from './index.ts'

import type { GethGenesis } from './gethGenesis.ts'
import type { BaseOpts, ChainConfig, GethConfigOpts } from './index.ts'

/**
 * Creates a {@link Common} object for a custom chain, based on a standard one.
 *
 * It uses all the {@link Chain} parameters from the {@link baseChain} option except the ones overridden
 * in a provided {@link chainParamsOrName} dictionary. Some usage example:
 *
 * ```javascript
 * import { createCustomCommon, Mainnet } from '@tvmjs/common'
 *
 * createCustomCommon({chainId: 123}, Mainnet)
 * ```
 *
 * @param partialConfig Custom parameter dict
 * @param baseChain `ChainConfig` chain configuration taken as a base chain, e.g. `Mainnet` (exported at root level)
 * @param opts Custom chain options to set various {@link BaseOpts}
 */
export function createCustomCommon(
  partialConfig: Partial<ChainConfig>,
  baseChain: ChainConfig,
  opts: BaseOpts = {},
): Common {
  return new Common({
    chain: {
      ...baseChain,
      ...partialConfig,
    },
    ...opts,
  })
}

/**
 * Static method to load and set common from a geth genesis object
 * @param genesisJSON GethGenesis object
 * @returns a new {@link Common} object
 */
export function createCommonFromGethGenesis(
  genesisJSON: GethGenesis,
  { chain, eips, genesisHash, hardfork, params, customCrypto, activatedProposals }: GethConfigOpts,
): Common {
  const genesisParams = parseGethGenesis(genesisJSON, chain)
  const common = new Common({
    chain: {
      ...genesisParams,
      name: genesisParams.name ?? 'Custom chain',
    } as ChainConfig, // Typecasting because of `string` -> `PrefixedHexString` mismatches
    eips,
    params,
    hardfork: hardfork ?? genesisParams.hardfork,
    customCrypto,
    activatedProposals,
  })
  if (genesisHash !== undefined) {
    common.setForkHashes(genesisHash)
  }
  return common
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
 * while using the TRON execution hardfork sequence and parameter overlay.
 * It does NOT represent a complete TRON chain configuration: genesis and consensus details are
 * inherited from Mainnet, and network discovery data is intentionally omitted.
 *
 * Full TRON chain configurations with verified genesis and network data will be added in a future release.
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
