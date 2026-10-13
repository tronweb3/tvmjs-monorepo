import { EthereumJSErrorWithoutCode, TypeOutput, toType } from '@tvmjs/util'
import { EventEmitter } from 'eventemitter3'

import { Hardfork } from './enums.ts'
import { tronExecutionProfile } from './profiles.ts'
import { tronProposalsDict } from './proposals.ts'

import type { BigIntLike, PrefixedHexString } from '@tvmjs/util'
import type { ConsensusAlgorithm, ConsensusType } from './enums.ts'
import type {
  BootstrapNodeConfig,
  CasperConfig,
  ChainConfig,
  CliqueConfig,
  CommonEvent,
  CommonOpts,
  CustomCrypto,
  EthashConfig,
  GenesisBlockConfig,
  HardforkByOpts,
  HardforkConfig,
  HardforkTransitionConfig,
  ParamsConfig,
  ParamsDict,
} from './types.ts'

function assertSupportedEIP(eip: number): void {
  if (
    !Number.isSafeInteger(eip) ||
    (!tronExecutionProfile.eips.includes(eip) && !tronExecutionProfile.optionalEIPs.includes(eip))
  ) {
    throw EthereumJSErrorWithoutCode(`EIP ${eip} is not supported by the TRON execution profile`)
  }
}

/** JSON with object keys sorted at every level, so equal metadata compares equal regardless of key order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  )
}

/**
 * Common class to access chain and hardfork parameters and to provide
 * a unified and shared view on the network and hardfork state.
 *
 * Use the {@link createCustomCommon} constructor for creating simple
 * custom chain {@link Common} objects (more complete custom chain setups
 * can be created via the main constructor).
 *
 * Only TRON execution profiles are accepted. Geth genesis parsing remains
 * available as a data utility, but does not create a supported execution profile.
 */
export class Common {
  readonly DEFAULT_HARDFORK: string | Hardfork

  protected _chainParams: ChainConfig
  protected _hardfork: string | Hardfork
  protected _eips: number[] = []
  protected _params: ParamsDict

  public readonly customCrypto: CustomCrypto

  protected _paramsCache: ParamsConfig = {}
  protected _activatedEIPsCache: number[] = []
  protected _activatedProposals: number[] = []

  protected HARDFORK_CHANGES: [string, HardforkConfig][]

  public events: EventEmitter<CommonEvent>

  constructor(opts: CommonOpts) {
    this.events = new EventEmitter<CommonEvent>()

    const chain = opts.chain
    if (chain?.execution !== 'tron') {
      throw EthereumJSErrorWithoutCode(
        'Only TRON execution configurations are supported. Use TronMainnet, TronNile or TronShasta; Mainnet + hardfork: tron is no longer mapped implicitly.',
      )
    }
    if (
      (chain.defaultHardfork !== undefined && chain.defaultHardfork !== Hardfork.Tron) ||
      chain.hardforks.length !== 1 ||
      chain.hardforks[0].name !== Hardfork.Tron ||
      chain.hardforks[0].block !== 0 ||
      chain.hardforks[0].timestamp !== undefined ||
      (chain.hardforks[0].forkHash !== undefined && chain.hardforks[0].forkHash !== null) ||
      Object.keys(chain.customHardforks ?? {}).length !== 0
    ) {
      throw EthereumJSErrorWithoutCode(
        'Only the TRON execution profile is supported; Ethereum and custom hardfork schedules are not supported. Use params, eips and activatedProposals for execution settings.',
      )
    }
    if (opts.customCrypto && 'kzg' in opts.customCrypto) {
      throw EthereumJSErrorWithoutCode('customCrypto.kzg is no longer supported')
    }
    if (chain.genesis && ('excessBlobGas' in chain.genesis || 'blobGasUsed' in chain.genesis)) {
      throw EthereumJSErrorWithoutCode('Blob gas fields are not supported in TRON genesis metadata')
    }
    this._chainParams = JSON.parse(JSON.stringify(chain)) // copy
    this.DEFAULT_HARDFORK = this._chainParams.defaultHardfork ?? Hardfork.Tron
    this.HARDFORK_CHANGES = [[Hardfork.Tron, { eips: [...tronExecutionProfile.eips] }]]
    this._hardfork = this.DEFAULT_HARDFORK
    this._params = opts.params ? JSON.parse(JSON.stringify(opts.params)) : {} // copy

    if (opts.hardfork !== undefined) {
      this.setHardfork(opts.hardfork)
    }
    if (opts.eips) {
      this.setEIPs(opts.eips)
    }
    if (opts.activatedProposals !== undefined && !Array.isArray(opts.activatedProposals)) {
      throw EthereumJSErrorWithoutCode(
        `activatedProposals must be an array of proposal IDs, received ${typeof opts.activatedProposals}`,
      )
    }
    const activatedProposals = opts.activatedProposals ?? chain.defaultActivatedProposals ?? []
    if (activatedProposals.length > 0) {
      const supported = Object.keys(tronProposalsDict).join(', ')
      for (const proposalId of activatedProposals) {
        if (!Number.isSafeInteger(proposalId) || proposalId <= 0) {
          throw EthereumJSErrorWithoutCode(
            `Invalid proposal ID: ${proposalId} (must be a positive safe integer), supported proposals: ${supported}`,
          )
        }
        if (!Object.prototype.hasOwnProperty.call(tronProposalsDict, proposalId)) {
          throw EthereumJSErrorWithoutCode(
            `Proposal with ID ${proposalId} not supported, supported proposals: ${supported}`,
          )
        }
      }
      this._activatedProposals = [...new Set(activatedProposals)].sort((a, b) => a - b)
    }
    this.customCrypto = { ...opts.customCrypto }

    if (Object.keys(this._paramsCache).length === 0) {
      this._buildParamsCache()
      this._buildActivatedEIPsCache()
    }
  }

  /**
   * Update the internal Common EIP params set. Existing values
   * will get preserved unless there is a new value for a parameter
   * provided with params.
   *
   * Example Format:
   *
   * ```ts
   * {
   *   1559: {
   *     initialBaseFee: 1000000000,
   *   }
   * }
   * ```
   *
   * @param params
   * @param overwrite Set to false when loading defaults to preserve caller overrides.
   */
  updateParams(params: ParamsDict, overwrite = true) {
    for (const [eip, paramsConfig] of Object.entries(params)) {
      if (!(eip in this._params)) {
        this._params[eip] = JSON.parse(JSON.stringify(paramsConfig)) // copy
      } else {
        this._params[eip] = JSON.parse(
          JSON.stringify(
            overwrite
              ? { ...this._params[eip], ...paramsConfig }
              : { ...paramsConfig, ...this._params[eip] },
          ),
        ) // copy
      }
    }

    this._buildParamsCache()
  }

  /**
   * Fully resets the internal Common EIP params set with the values provided.
   *
   * Example Format:
   *
   * ```ts
   * {
   *   1559: {
   *     initialBaseFee: 1000000000,
   *   }
   * }
   * ```
   *
   * @param params
   */
  resetParams(params: ParamsDict) {
    this._params = JSON.parse(JSON.stringify(params)) // copy
    this._buildParamsCache()
  }

  /**
   * Sets the hardfork to get params for
   * @param hardfork The supported 'tron' identifier or {@link Hardfork.Tron}
   */
  setHardfork(hardfork: string | Hardfork): void {
    let existing = false
    for (const hfChanges of this.HARDFORK_CHANGES) {
      if (hfChanges[0] === hardfork) {
        if (this._hardfork !== hardfork) {
          this._hardfork = hardfork
          this._buildParamsCache()
          this._buildActivatedEIPsCache()
          this.events.emit('hardforkChanged', hardfork)
        }
        existing = true
      }
    }
    if (!existing) {
      throw EthereumJSErrorWithoutCode(`Hardfork with name ${hardfork} not supported`)
    }
  }

  /**
   * Returns the TRON profile for a block or timestamp context.
   * The block-zero marker is not a historical network activation schedule.
   *
   * @param opts Block number or timestamp
   * @returns The name of the HF
   */
  getHardforkBy(opts: HardforkByOpts): string {
    const blockNumber: bigint | undefined = toType(opts.blockNumber, TypeOutput.BigInt)
    const timestamp: bigint | undefined = toType(opts.timestamp, TypeOutput.BigInt)

    // Filter out hardforks with no block number, no timestamp (i.e. unapplied hardforks)
    const hfs = this.hardforks().filter((hf) => hf.block !== null || hf.timestamp !== undefined)

    // Find the first hardfork that has a block number greater than `blockNumber`
    // If timestamp is not provided, it also skips timestamps hardforks to continue
    // discovering/checking number hardforks.
    let hfIndex = hfs.findIndex(
      (hf) =>
        (blockNumber !== undefined && hf.block !== null && BigInt(hf.block) > blockNumber) ||
        (timestamp !== undefined && hf.timestamp !== undefined && BigInt(hf.timestamp) > timestamp),
    )

    if (hfIndex === -1) {
      // all hardforks apply, set hfIndex to the last one as that's the candidate
      hfIndex = hfs.length
    } else if (hfIndex === 0) {
      // cannot have a case where a block number is before all applied hardforks
      // since the chain has to start with a hardfork
      throw Error('Must have at least one hardfork at block 0')
    }

    // If timestamp is not provided, we need to rollback to the last hf with block
    if (timestamp === undefined) {
      const stepBack = hfs
        .slice(0, hfIndex)
        .reverse()
        .findIndex((hf) => hf.block !== null)
      hfIndex = hfIndex - stepBack
    }
    // Move hfIndex one back to arrive at candidate hardfork
    hfIndex = hfIndex - 1

    const hfStartIndex = hfIndex
    // Move the hfIndex to the end of the hardforks that might be scheduled on the same block/timestamp
    // This won't anyway be the case with Merge hfs
    for (; hfIndex < hfs.length - 1; hfIndex++) {
      // break out if hfIndex + 1 is not scheduled at hfIndex
      if (
        hfs[hfIndex].block !== hfs[hfIndex + 1].block ||
        hfs[hfIndex].timestamp !== hfs[hfIndex + 1].timestamp
      ) {
        break
      }
    }

    if (timestamp !== undefined) {
      const minTimeStamp = hfs
        .slice(0, hfStartIndex)
        .reduce(
          (acc: number, hf: HardforkTransitionConfig) => Math.max(Number(hf.timestamp ?? '0'), acc),
          0,
        )
      if (minTimeStamp > timestamp) {
        throw Error(`Maximum HF determined by timestamp is lower than the block number HF`)
      }

      const maxTimeStamp = hfs
        .slice(hfIndex + 1)
        .reduce(
          (acc: number, hf: HardforkTransitionConfig) =>
            Math.min(Number(hf.timestamp ?? timestamp), acc),
          Number(timestamp),
        )

      if (maxTimeStamp < timestamp) {
        throw Error(`Maximum HF determined by block number is lower than timestamp HF`)
      }
    }
    const hardfork = hfs[hfIndex]
    return hardfork.name
  }

  /**
   * Selects the TRON profile for a block or timestamp context.
   * Ethereum upgrades cannot be selected through this method.
   *
   * @param opts Block number or timestamp
   * @returns The name of the HF set
   */
  setHardforkBy(opts: HardforkByOpts): string {
    const hardfork = this.getHardforkBy(opts)
    this.setHardfork(hardfork)
    return hardfork
  }

  /**
   * Internal helper function, returns the params for the given hardfork for the chain set
   * @param hardfork Hardfork name
   * @returns Dictionary with hardfork params or null if hardfork not on chain
   */
  protected _getHardfork(hardfork: string | Hardfork): HardforkTransitionConfig | null {
    const hfs = this.hardforks()
    for (const hf of hfs) {
      if (hf['name'] === hardfork) return hf
    }
    return null
  }

  /**
   * Sets the active EIPs
   * @param eips
   */
  setEIPs(eips: number[] = []) {
    for (const eip of eips) {
      assertSupportedEIP(eip)
    }
    // Validate before mutation and own the input array so rejected or later
    // modified configuration cannot change the active execution capabilities.
    this._eips = [...new Set(eips)].sort((a, b) => a - b)
    this._buildParamsCache()
    this._buildActivatedEIPsCache()
  }

  /**
   * Internal helper for _buildParamsCache()
   */
  protected _mergeWithParamsCache(params: ParamsConfig) {
    for (const [key, value] of Object.entries(params)) {
      this._paramsCache[key] = value
    }
  }

  /**
   * Build up a cache for all parameter values for the current HF and all activated EIPs
   */
  protected _buildParamsCache() {
    this._paramsCache = {}

    // Iterate through all hardforks up to hardfork set
    const hardfork = this.hardfork()
    for (const hfChanges of this.HARDFORK_CHANGES) {
      // Shared implementation groups in the TRON profile's declared order.
      if ('eips' in hfChanges[1]) {
        const hfEIPs = hfChanges[1].eips ?? []
        for (const eip of hfEIPs) {
          if (this._params[eip] !== undefined && this._params[eip] !== null) {
            this._mergeWithParamsCache(this._params[eip])
          }
        }
      }
      // Hardfork-scoped params
      // override the baseline EIP values when present
      const hfScopedParams = this._params[hfChanges[0]]
      if (hfScopedParams !== undefined && hfScopedParams !== null) {
        this._mergeWithParamsCache(hfScopedParams)
      }
      // Parameters declared directly in the hardfork configuration
      if (hfChanges[1].params !== undefined && hfChanges[1].params !== null) {
        this._mergeWithParamsCache(hfChanges[1].params)
      }
      if (hfChanges[0] === hardfork) break
    }

    // Iterate through all additionally activated EIPs
    for (const eip of this._eips) {
      // Selecting an already active implementation must not undo TRON pricing.
      if (tronExecutionProfile.eips.includes(eip)) continue
      if (this._params[eip] !== undefined && this._params[eip] !== null) {
        this._mergeWithParamsCache(this._params[eip])
      }
    }
  }

  /**
   * Builds the cache of EIPs activated either via hardforks or constructor `eips`.
   */
  protected _buildActivatedEIPsCache() {
    this._activatedEIPsCache = []

    for (const [name, hf] of this.HARDFORK_CHANGES) {
      if (this.gteHardfork(name) && 'eips' in hf) {
        this._activatedEIPsCache = this._activatedEIPsCache.concat(hf.eips ?? [])
      }
    }
    this._activatedEIPsCache = this._activatedEIPsCache.concat(this._eips)
  }

  /**
   * Returns a parameter for the current chain setup
   *
   * Shared implementation groups are applied in profile order, followed by
   * the `tron` parameter group and explicitly activated optional EIPs.
   * Explicitly selecting a baseline EIP does not override TRON parameters.
   *
   * @param name Parameter name (e.g. 'minGasLimit')
   * @returns The value requested (throws if not found)
   */
  param(name: string): bigint {
    if (!(name in this._paramsCache)) {
      throw EthereumJSErrorWithoutCode(`Missing parameter value for ${name}`)
    }
    const value = this._paramsCache[name]
    return BigInt(value ?? 0)
  }

  /**
   * Returns a TRON profile parameter without explicitly selected optional EIP overrides.
   * @param name Parameter name (e.g. 'minGasLimit')
   * @param hardfork Hardfork name
   * @returns The value requested (throws if not found)
   */
  paramByHardfork(name: string, hardfork: string | Hardfork): bigint {
    if (hardfork !== Hardfork.Tron) {
      throw EthereumJSErrorWithoutCode(`Hardfork with name ${hardfork} not supported`)
    }
    let value: number | string | null | undefined
    for (const eip of tronExecutionProfile.eips) {
      const candidate = this._params[eip]?.[name]
      if (candidate !== undefined) value = candidate
    }
    const profileValue = this._params[Hardfork.Tron]?.[name]
    if (profileValue !== undefined) value = profileValue
    if (value === undefined) {
      throw EthereumJSErrorWithoutCode(`Missing parameter value for ${name}`)
    }
    return BigInt(value ?? 0)
  }

  /**
   * Returns a parameter for a supported EIP, including optional EIPs that have
   * not been activated. Querying a parameter does not activate the EIP.
   * @param name Parameter name (e.g. 'minGasLimit' for 'gasConfig' topic)
   * @param eip Number of the EIP
   * @returns The value requested (throws if not found)
   */
  paramByEIP(name: string, eip: number): bigint | undefined {
    assertSupportedEIP(eip)

    const eipParams = this._params[eip]
    if (eipParams?.[name] === undefined) {
      throw EthereumJSErrorWithoutCode(`Missing parameter value for ${name}`)
    }
    const value = eipParams![name]
    return BigInt(value ?? 0)
  }

  /**
   * Returns a TRON profile parameter for a block or timestamp context.
   * Like paramByHardfork(), this excludes optional EIP overrides.
   * @param name Parameter name
   * @param blockNumber Block number
   * @param timestamp Optional block timestamp
   * @returns The value requested (throws if not found)
   */
  paramByBlock(name: string, blockNumber: BigIntLike, timestamp?: BigIntLike): bigint {
    const hardfork = this.getHardforkBy({ blockNumber, timestamp })
    return this.paramByHardfork(name, hardfork)
  }

  /**
   * Checks baseline profile groups and explicitly selected optional EIPs.
   * Governance proposals do not implicitly activate EIPs.
   * @param eip
   */
  isActivatedEIP(eip: number): boolean {
    if (this._activatedEIPsCache.includes(eip)) {
      return true
    }
    return false
  }

  /**
   * Returns whether this Common instance uses a TRON execution chain profile.
   *
   * TRON is the only supported execution family. Network identity is independent
   * of its chainId and explicitly selected governance proposals.
   */
  isTron(): boolean {
    return this._chainParams.execution === 'tron'
  }

  /**
   * Checks if a TRON governance proposal is activated by the chain preset or
   * the {@link CommonOpts.activatedProposals} constructor option.
   *
   * Common exposes proposal state without mutating EIPs or params. Execution
   * consumers may use this state to gate protocol behavior. Unknown proposal
   * IDs return `false`.
   * @param proposalId
   */
  isActivatedProposal(proposalId: number): boolean {
    return this._activatedProposals.includes(proposalId)
  }

  /**
   * Returns the activated TRON governance proposal IDs
   * (deduplicated, in ascending order).
   *
   * A new array is returned on each call, modifying it does not
   * affect the internal state.
   */
  activatedProposals(): number[] {
    return [...this._activatedProposals]
  }

  /**
   * Compare execution settings supplied to different layers of a VM. Libraries
   * add their own parameter dictionaries during initialization, so parameters
   * only conflict when both instances already define a different active value.
   */
  isCompatibleWith(other: Common): boolean {
    const sameIds = (a: number[], b: number[]) =>
      [...new Set(a)].sort((x, y) => x - y).join(',') ===
      [...new Set(b)].sort((x, y) => x - y).join(',')
    if (
      this.chainId() !== other.chainId() ||
      this.hardfork() !== other.hardfork() ||
      !sameIds(this._activatedEIPsCache, other._activatedEIPsCache) ||
      !sameIds(this._activatedProposals, other._activatedProposals) ||
      stableStringify(this._chainParams.consensus) !==
        stableStringify(other._chainParams.consensus) ||
      // Network genesis metadata must not be replaced by an execution-only instance.
      stableStringify(this._chainParams.genesis) !== stableStringify(other._chainParams.genesis)
    )
      return false

    for (const key of new Set([
      ...Object.keys(this.customCrypto),
      ...Object.keys(other.customCrypto),
    ])) {
      if (
        this.customCrypto[key as keyof CustomCrypto] !==
        other.customCrypto[key as keyof CustomCrypto]
      )
        return false
    }
    for (const [key, value] of Object.entries(this._paramsCache)) {
      if (key in other._paramsCache && BigInt(value ?? 0) !== BigInt(other._paramsCache[key] ?? 0))
        return false
    }
    return true
  }

  /**
   * Checks if set or provided hardfork is active on block number
   * @param hardfork Hardfork name or null (for HF set)
   * @param blockNumber
   * @returns True if HF is active on block number
   */
  hardforkIsActiveOnBlock(hardfork: string | Hardfork | null, blockNumber: BigIntLike): boolean {
    blockNumber = toType(blockNumber, TypeOutput.BigInt)
    hardfork = hardfork ?? this._hardfork
    const hfBlock = this.hardforkBlock(hardfork)
    if (typeof hfBlock === 'bigint' && blockNumber >= hfBlock) {
      return true
    }
    return false
  }

  /**
   * Alias to hardforkIsActiveOnBlock when hardfork is set
   * @param blockNumber
   * @returns True if HF is active on block number
   */
  activeOnBlock(blockNumber: BigIntLike): boolean {
    return this.hardforkIsActiveOnBlock(null, blockNumber)
  }

  /**
   * Sequence based check if given or set HF1 is greater than or equal HF2
   * @param hardfork1 Hardfork name or null (if set)
   * @param hardfork2 Hardfork name
   * @returns True if HF1 gte HF2
   */
  hardforkGteHardfork(hardfork1: string | Hardfork | null, hardfork2: string | Hardfork): boolean {
    hardfork1 = hardfork1 ?? this._hardfork
    const hardforks = this.hardforks()

    let posHf1 = -1,
      posHf2 = -1
    let index = 0
    for (const hf of hardforks) {
      if (hf['name'] === hardfork1) posHf1 = index
      if (hf['name'] === hardfork2) posHf2 = index
      index += 1
    }
    return posHf1 >= posHf2 && posHf2 !== -1
  }

  /**
   * Alias to hardforkGteHardfork when hardfork is set
   * @param hardfork Hardfork name
   * @returns True if hardfork set is greater than hardfork provided
   */
  gteHardfork(hardfork: string | Hardfork): boolean {
    return this.hardforkGteHardfork(null, hardfork)
  }

  /**
   * Returns the hardfork change block for hardfork provided or set
   * @param hardfork Hardfork name, optional if HF set
   * @returns Block number or null if unscheduled
   */
  hardforkBlock(hardfork?: string | Hardfork): bigint | null {
    hardfork = hardfork ?? this._hardfork
    const block = this._getHardfork(hardfork)?.['block']
    if (block === undefined || block === null) {
      return null
    }
    return BigInt(block)
  }

  /**
   * Returns the timestamp at which a given hardfork is scheduled (if any).
   * @param hardfork Hardfork name, optional if HF set
   * @returns Timestamp or null if the hardfork is not timestamp-based
   */
  hardforkTimestamp(hardfork?: string | Hardfork): bigint | null {
    hardfork = hardfork ?? this._hardfork
    const timestamp = this._getHardfork(hardfork)?.['timestamp']
    if (timestamp === undefined || timestamp === null) {
      return null
    }
    return BigInt(timestamp)
  }

  /**
   * Returns the hardfork change block for eip
   * @param eip EIP number
   * @returns Block number or null if unscheduled
   */
  eipBlock(eip: number): bigint | null {
    for (const hfChanges of this.HARDFORK_CHANGES) {
      const hf = hfChanges[1]
      if ('eips' in hf) {
        if ((hf['eips'] as any).includes(eip)) {
          return this.hardforkBlock(hfChanges[0])
        }
      }
    }
    return null
  }

  /**
   * Returns the scheduled timestamp of the EIP (if scheduled and scheduled by timestamp)
   * @param eip EIP number
   * @returns Scheduled timestamp. If this EIP is unscheduled, or the EIP is scheduled by block number, then it returns `null`.
   */
  eipTimestamp(eip: number): bigint | null {
    for (const hfChanges of this.HARDFORK_CHANGES) {
      const hf = hfChanges[1]
      if ('eips' in hf) {
        if ((hf['eips'] as any).includes(eip)) {
          return this.hardforkTimestamp(hfChanges[0])
        }
      }
    }
    return null
  }

  /**
   * Returns the next scheduled hardfork block or timestamp, if any.
   * The TRON execution profile has no subsequent scheduled transition,
   * so this query returns null.
   * @param hardfork Hardfork name, optional if HF set
   * @returns Block number or timestamp, or null if not available
   */
  nextHardforkBlockOrTimestamp(hardfork?: string | Hardfork): bigint | null {
    const targetHardfork = hardfork ?? this._hardfork
    const hfs = this.hardforks()

    // Find the index of the target hardfork
    let targetHfIndex = hfs.findIndex((hf) => hf.name === targetHardfork)

    // Special handling for The Merge (Paris) hardfork
    if (targetHardfork === Hardfork.Paris) {
      // The Merge is determined by total difficulty, not block number
      // So we look at the previous hardfork's parameters instead
      targetHfIndex -= 1
    }

    // If we couldn't find a valid hardfork index, return null
    if (targetHfIndex < 0) {
      return null
    }

    // Get the current hardfork's block/timestamp
    const currentHf = hfs[targetHfIndex]
    const currentBlockOrTimestamp = currentHf.timestamp ?? currentHf.block
    if (currentBlockOrTimestamp === null || currentBlockOrTimestamp === undefined) {
      return null
    }

    // Find the next hardfork that has a different block/timestamp
    const nextHf = hfs.slice(targetHfIndex + 1).find((hf) => {
      const nextBlockOrTimestamp = hf.timestamp ?? hf.block
      return (
        nextBlockOrTimestamp !== null &&
        nextBlockOrTimestamp !== undefined &&
        nextBlockOrTimestamp !== currentBlockOrTimestamp
      )
    })
    // If no next hf found with valid block or timestamp return null
    if (nextHf === undefined) {
      return null
    }

    // Get the block/timestamp for the next hardfork
    const nextBlockOrTimestamp = nextHf.timestamp ?? nextHf.block
    if (nextBlockOrTimestamp === null || nextBlockOrTimestamp === undefined) {
      return null
    }

    return BigInt(nextBlockOrTimestamp)
  }

  /** Ethereum fork identifiers are not part of a TRON execution profile. */
  forkHash(_hardfork?: string | Hardfork, _genesisHash?: Uint8Array): PrefixedHexString {
    throw EthereumJSErrorWithoutCode(
      'Ethereum fork hashes are not supported by TRON execution profiles',
    )
  }

  /**
   *
   * @param forkHash Fork hash as a hex string
   * @returns Array with hardfork data (name, block, forkHash)
   */
  hardforkForForkHash(forkHash: string): HardforkTransitionConfig | null {
    const resArray = this.hardforks().filter((hf: HardforkTransitionConfig) => {
      return hf.forkHash === forkHash
    })
    return resArray.length >= 1 ? resArray[resArray.length - 1] : null
  }

  /**
   * Sets any missing forkHashes on this {@link Common} instance.
   * @param genesisHash The genesis block hash
   */
  setForkHashes(_genesisHash: Uint8Array) {
    throw EthereumJSErrorWithoutCode(
      'Ethereum fork hashes are not supported by TRON execution profiles',
    )
  }

  /**
   * Returns the Genesis parameters of the current chain
   * @returns Genesis dictionary
   */
  genesis(): GenesisBlockConfig {
    if (!this.hasGenesis()) {
      throw EthereumJSErrorWithoutCode(
        'Genesis metadata is not available for this execution-only configuration; provide an explicit network configuration or genesis block.',
      )
    }
    return this._chainParams.genesis!
  }

  /** Whether genesis metadata was explicitly supplied. */
  hasGenesis(): boolean {
    return this._chainParams.genesis !== undefined
  }

  /** Whether consensus metadata was explicitly supplied. */
  hasConsensus(): boolean {
    return this._chainParams.consensus !== undefined
  }

  /**
   * Returns the hardfork definitions for the current chain.
   * @returns Array of hardfork transition configs
   */
  hardforks(): HardforkTransitionConfig[] {
    return this._chainParams.hardforks.map((hf) => ({ ...hf }))
  }

  /**
   * Returns bootstrap nodes for the current chain.
   * @returns Array of bootstrap node configs
   */
  bootstrapNodes(): BootstrapNodeConfig[] {
    return this._chainParams.bootstrapNodes
  }

  /**
   * Returns DNS networks for the current chain
   * @returns {String[]} Array of DNS ENR urls
   */
  dnsNetworks(): string[] {
    return this._chainParams.dnsNetworks!
  }

  /**
   * Returns the hardfork set
   * @returns Hardfork name
   */
  hardfork(): string | Hardfork {
    return this._hardfork
  }

  /**
   * Returns the Id of current chain
   * @returns chain Id
   */
  chainId(): bigint {
    return BigInt(this._chainParams.chainId)
  }

  /**
   * Returns the name of current chain
   * @returns chain name (lower case)
   */
  chainName(): string {
    return this._chainParams.name
  }

  /**
   * Returns the additionally activated EIPs
   * (by using the `eips` constructor option)
   * @returns List of EIPs
   */
  eips(): number[] {
    return [...this._eips]
  }

  /**
   * Returns the consensus type of the network
   * Possible values: "pow"|"poa"|"pos"
   *
   * The TRON profile does not apply consensus transitions to supplied metadata.
   */
  consensusType(): string | ConsensusType {
    if (this._chainParams.consensus === undefined) {
      throw EthereumJSErrorWithoutCode(
        'Consensus metadata is not available for this execution-only configuration',
      )
    }
    const hardfork = this.hardfork()

    let value
    for (const hfChanges of this.HARDFORK_CHANGES) {
      if ('consensus' in hfChanges[1]) {
        value = (hfChanges[1] as any)['consensus']['type']
      }
      if (hfChanges[0] === hardfork) break
    }
    return value ?? this._chainParams['consensus']['type']
  }

  /**
   * Returns the concrete consensus implementation
   * algorithm or protocol for the network
   * e.g. "ethash" for "pow" consensus type,
   * "clique" for "poa" consensus type or
   * "casper" for "pos" consensus type.
   *
   * The TRON profile does not apply consensus transitions to supplied metadata.
   */
  consensusAlgorithm(): string | ConsensusAlgorithm {
    if (this._chainParams.consensus === undefined) {
      throw EthereumJSErrorWithoutCode(
        'Consensus metadata is not available for this execution-only configuration',
      )
    }
    const hardfork = this.hardfork()

    let value
    for (const hfChanges of this.HARDFORK_CHANGES) {
      if ('consensus' in hfChanges[1]) {
        value = hfChanges[1]['consensus']!['algorithm']
      }
      if (hfChanges[0] === hardfork) break
    }
    return value ?? (this._chainParams['consensus']['algorithm'] as ConsensusAlgorithm)
  }

  /**
   * Returns a dictionary with consensus configuration
   * parameters based on the consensus algorithm
   *
   * Expected returns (parameters must be present in
   * the respective chain JSON files):
   *
   * ethash: empty object
   * clique: period, epoch
   * casper: empty object
   *
   * The TRON profile does not apply consensus transitions to supplied metadata.
   */
  consensusConfig(): { [key: string]: CliqueConfig | EthashConfig | CasperConfig } {
    if (this._chainParams.consensus === undefined) {
      throw EthereumJSErrorWithoutCode(
        'Consensus metadata is not available for this execution-only configuration',
      )
    }
    const hardfork = this.hardfork()

    let value
    for (const hfChanges of this.HARDFORK_CHANGES) {
      if ('consensus' in hfChanges[1]) {
        // The config parameter is named after the respective consensus algorithm
        const config = hfChanges[1]
        const algorithm = config['consensus']!['algorithm']
        value = (config['consensus'] as any)[algorithm]
      }
      if (hfChanges[0] === hardfork) break
    }
    return (
      value ?? this._chainParams['consensus'][this.consensusAlgorithm() as ConsensusAlgorithm] ?? {}
    )
  }

  /**
   * Returns a deep copy of this {@link Common} instance.
   */
  copy(): Common {
    return new Common({
      chain: this._chainParams,
      hardfork: this._hardfork,
      params: this._params,
      eips: this._eips,
      activatedProposals: this._activatedProposals,
      customCrypto: this.customCrypto,
    })
  }
}
