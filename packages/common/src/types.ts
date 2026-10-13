import type { secp256k1 } from '@noble/curves/secp256k1.js'
import type { BigIntLike, PrefixedHexString } from '@tvmjs/util'
import type { ConsensusAlgorithm, ConsensusType, Hardfork } from './enums.ts'

export interface ChainName {
  [chainId: string]: string
}
export interface ChainsConfig {
  [key: string]: ChainConfig | ChainName
}

export interface CommonEvent {
  hardforkChanged: [hardfork: string]
}

export type CliqueConfig = {
  period: number
  epoch: number
}

export type EthashConfig = {}

export type CasperConfig = {}

type ConsensusConfig = {
  type: ConsensusType | string
  algorithm: ConsensusAlgorithm | string
  clique?: CliqueConfig
  ethash?: EthashConfig
  casper?: CasperConfig
}

export interface ChainConfig {
  name: string
  chainId: number | string
  /** Execution profile family. Ethereum network configurations are not executable. */
  execution: 'tron'
  /** Proposals enabled when the caller does not supply activatedProposals. */
  defaultActivatedProposals?: number[]
  defaultHardfork?: string
  comment?: string
  url?: string
  genesis?: GenesisBlockConfig
  hardforks: HardforkTransitionConfig[]
  customHardforks?: HardforksDict
  bootstrapNodes: BootstrapNodeConfig[]
  dnsNetworks?: string[]
  consensus?: ConsensusConfig
  depositContractAddress?: PrefixedHexString
}

/** A network configuration with explicitly supplied genesis and consensus data. */
export interface NetworkChainConfig extends ChainConfig {
  genesis: GenesisBlockConfig
  consensus: ConsensusConfig
}

/** Historical Ethereum network data. Not accepted by execution constructors. */
export interface EthereumChainData extends Omit<NetworkChainConfig, 'execution'> {
  execution?: never
}

/** A TRON execution preset without network genesis or consensus metadata. */
export interface TronExecutionChainConfig extends ChainConfig {
  execution: 'tron'
  genesis?: never
  consensus?: never
}

type CustomChainField = 'name' | 'chainId' | 'comment' | 'url' | 'bootstrapNodes' | 'dnsNetworks'

/**
 * Identity and discovery overrides for createCustomCommon().
 * Supply genesis and consensus explicitly in a complete ChainConfig instead.
 */
export type CustomChainConfig = Partial<Pick<ChainConfig, CustomChainField>> & {
  [K in Exclude<keyof ChainConfig, CustomChainField>]?: never
}

export interface GenesisBlockConfig {
  timestamp?: PrefixedHexString
  gasLimit: number | PrefixedHexString
  difficulty: number | PrefixedHexString
  nonce: PrefixedHexString
  extraData: PrefixedHexString
  baseFeePerGas?: PrefixedHexString
  requestsHash?: PrefixedHexString
}

export interface HardforkTransitionConfig {
  name: Hardfork | string
  block: number | null // null is used for hardforks that should not be applied -- since `undefined` isn't a valid value in JSON
  timestamp?: number | string
  forkHash?: PrefixedHexString | null
}

export interface BootstrapNodeConfig {
  ip: string
  port: number | string
  network?: string
  chainId?: number
  id: string
  location: string
  comment: string
}

export interface CustomCrypto {
  /**
   * Custom cryptographic primitives used by TVMJS execution packages.
   */
  keccak256?: (msg: Uint8Array) => Uint8Array
  ecrecover?: (
    msgHash: Uint8Array,
    v: bigint,
    r: Uint8Array,
    s: Uint8Array,
    chainId?: bigint,
  ) => Uint8Array
  sha256?: (msg: Uint8Array) => Uint8Array
  ecsign?: typeof secp256k1.sign
  ecdsaRecover?: (sig: Uint8Array, recId: number, hash: Uint8Array) => Uint8Array
}

export interface BaseOpts {
  /**
   * TRON execution profile. Only `tron` / {@link Hardfork.Tron} is supported.
   *
   * Default: Hardfork.Tron
   */
  hardfork?: string | Hardfork
  /**
   * Selected EIPs which can be activated, please use an array for instantiation
   * (e.g. `eips: [7939]`)
   *
   * Currently supported:
   *
   * - [EIP-7939](https://eips.ethereum.org/EIPS/eip-7939) - CLZ instruction
   */
  eips?: number[]
  /**
   * Optional parameter dictionaries, normally supplied by the consuming TVMJS
   * package. Use the `tron` group for TRON overrides; explicitly activated
   * optional EIP groups take precedence over that group.
   *
   * Example Format:
   *
   * ```ts
   * {
   *   tron: {
   *     callGas: 40,
   *   }
   * }
   * ```
   */
  params?: ParamsDict
  /**
   * This option can be used to replace the most common crypto primitives
   * (keccak256 hashing e.g.) within TVMJS packages
   * with alternative implementations (e.g. more performant WASM libraries).
   *
   * Note: please be aware that this is adding new dependencies for your
   * system setup to be used for sensitive/core parts of the functionality
   * and a choice on the libraries to add should be handled with care
   * and be made with eventual security implications considered.
   */
  customCrypto?: CustomCrypto
  /**
   * Activated TRON governance proposal IDs (e.g. `activatedProposals: [95, 96]`),
   * see the `tronProposalsDict` for supported proposals.
   *
   * Common stores proposal state without mutating EIPs or params. Execution
   * consumers can use `Common.isActivatedProposal()` to gate protocol
   * behavior. IDs are deduplicated and kept in ascending order; unknown IDs
   * throw on instantiation. An explicit array, including `[]`, overrides the
   * chain preset's defaults.
   */
  activatedProposals?: number[]
}

/**
 * Options for instantiating a {@link Common} instance.
 */
export interface CommonOpts extends BaseOpts {
  /**
   * TRON execution configuration, such as TronMainnet, TronNile or TronShasta.
   * Ethereum presets and hardfork schedules are rejected with a migration error.
   */
  chain: ChainConfig
}

export interface HardforkByOpts {
  blockNumber?: BigIntLike
  timestamp?: BigIntLike
}

export type EIPConfig = {
  minimumHardfork: Hardfork
  requiredEIPs?: number[]
}

export type ParamsConfig = {
  [key: string]: number | string | null
}

export type HardforkConfig = {
  eips?: number[]
  consensus?: ConsensusConfig
  params?: ParamsConfig
}

export type EIPsDict = {
  [key: string]: EIPConfig
}

export type ParamsDict = {
  [key: string]: ParamsConfig
}

export type HardforksDict = {
  [key: string]: HardforkConfig
}

export type TronProposalConfig = {
  readonly name: string
}

export type TronProposalsDict = {
  readonly [proposalId: string]: TronProposalConfig
}
