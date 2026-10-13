import { paramsBlock } from '@tvmjs/block'
import { TronMainnet } from '@tvmjs/common'
import { paramsTVM } from '@tvmjs/tvm'
import { paramsVM } from '@tvmjs/vm'
import { TronWeb } from 'tronweb'

import { parseBalance } from './balance.ts'
import { chainParameterFault } from './chainParameters.ts'
import { requireInteger } from './core/validation.ts'
import { DEV_MNEMONIC, derivePrivateKeys } from './hdWallet.ts'
import { parseInteger } from './input.ts'
import { INT64_MAX } from './intBounds.ts'

import type { BaseOpts, ParamsDict } from '@tvmjs/common'
import type { IntegerInput } from './input.ts'
import type { Logger } from './logging.ts'
import { requestKeyed } from './lookup.ts'

export type { ParamsDict }

/** Execution rules passed to Common when the chain is initialized. */
export type CommonOptions = Pick<BaseOpts, 'eips' | 'activatedProposals' | 'params'>

export interface AccountConfig {
  /** 32-byte private key as unprefixed hex */
  privateKey: string
  /** initial balance in sun (1 TRX = 1e6 sun) */
  balance: bigint
}

/** JSON-safe form accepted for a directly configured development account. */
export interface AccountConfigInput {
  privateKey: string
  balance?: bigint | number | string
}

/** JSON-safe options for the mnemonic-derived development accounts. */
export interface MnemonicConfigInput {
  phrase: string
  count?: number
  balance?: bigint | number | string
}

/** Fully resolved settings for the accounts derived from one mnemonic. */
export interface MnemonicConfig {
  phrase: string
  count: number
  balance: bigint
}

/**
 * The chain parameters this dev chain is born with — one source feeding
 * getchainparameters, the price endpoints and fee charging alike.
 * Every value must be a non-negative safe integer within its parameter's bounds.
 */
export interface ChainParameters {
  /** sun per energy unit (getEnergyFee) */
  energyFee: number
  /** sun per transaction byte (getTransactionFee) */
  transactionFee: number
  /** sun per memo (getMemoFee) */
  memoFee: number
  /** proposal gate: 1 blocks value transfers to contract accounts */
  forbidTransferToContract: number
  /** proposal gate: 1 allows permissions to be reshaped (getAllowMultiSign) */
  allowMultiSign: number
  /** proposal gate allowing an account to replace an already-claimed name */
  allowUpdateAccountName: number
  /** proposal gate selecting id-keyed TRC-10 assets and permitting duplicate names */
  allowSameTokenName: number
  /** proposal gate for resource delegation (getAllowDelegateResource) */
  allowDelegateResource: number
  /** proposal gate for the independent voting-power resource (getAllowNewResourceModel) */
  allowNewResourceModel: number
  /** proposal gate for cancelallunfreezev2 (getAllowCancelAllUnfreezeV2) */
  allowCancelAllUnfreezeV2: number
  /** proposal gate for a witness changing its reward brokerage percentage */
  allowChangeDelegation: number
  /** most keys one permission may hold, and most signatures one tx may carry */
  totalSignNum: number
  /** sun burned by an accountpermissionupdate */
  updateAccountPermissionFee: number
  /** sun burned when an account registers itself as a witness */
  accountUpgradeCost: number
  /** sun burned when a transaction carries more than one signature */
  multiSignFee: number
  /** TRC-10 issuance fee in sun (getAssetIssueFee) */
  assetIssueFee: number
  createAccountFee: number
  createNewAccountFeeInSystemContract: number
  freeNetLimit: number
  /** chain-wide daily bandwidth points (getTotalNetLimit) */
  totalNetLimit: number
  totalEnergyCurrentLimit: number
  maintenanceTimeIntervalMs: number
  /** days an unstake waits before it can be withdrawn (getUnfreezeDelayDays) */
  unfreezeDelayDays: number
  /** whether the legacy freeze-duration bounds are enforced (a node startup setting) */
  checkFrozenTime: number
  /** inclusive lower duration bound for a legacy freeze, in days */
  minFrozenTime: number
  /** inclusive upper duration bound for a legacy freeze, in days */
  maxFrozenTime: number
  /** longest delegation lock, in 3-second blocks (getMaxDelegateLockPeriod) */
  maxDelegateLockPeriod: number
  /** most sun a transaction may state as fee_limit (getMaxFeeLimit) */
  maxFeeLimit: number
  /** byte cap on account-activating transactions (getMaxCreateAccountTxSize) */
  maxCreateAccountTxSize: number
  /** sun each block pays its producer (getWitnessPayPerBlock) */
  witnessPayPerBlock: number
  /** sun each block shares across the standby witness list (getWitness127PayPerBlock) */
  witness127PayPerBlock: number
}

const DEFAULT_CHAIN_PARAMETERS: ChainParameters = requestKeyed({
  energyFee: 100,
  transactionFee: 1000,
  memoFee: 1_000_000,
  forbidTransferToContract: 0,
  allowMultiSign: 1,
  allowUpdateAccountName: 0,
  allowSameTokenName: 1,
  allowDelegateResource: 1,
  allowNewResourceModel: 0,
  allowCancelAllUnfreezeV2: 1,
  allowChangeDelegation: 1,
  totalSignNum: 5,
  updateAccountPermissionFee: 100_000_000,
  accountUpgradeCost: 9_999_000_000,
  multiSignFee: 1_000_000,
  assetIssueFee: 1_024_000_000,
  createAccountFee: 100_000,
  createNewAccountFeeInSystemContract: 1_000_000,
  freeNetLimit: 600,
  totalNetLimit: 43_200_000_000,
  totalEnergyCurrentLimit: 180_000_000_000,
  maintenanceTimeIntervalMs: 21_600_000, // 6h, mainnet value
  unfreezeDelayDays: 14,
  checkFrozenTime: 1,
  minFrozenTime: 3,
  maxFrozenTime: 3,
  maxDelegateLockPeriod: 864_000, // 30 days of blocks, mainnet value
  maxFeeLimit: 15_000_000_000, // 15000 TRX, mainnet value
  maxCreateAccountTxSize: 1000,
  witnessPayPerBlock: 8_000_000, // 8 TRX, mainnet value
  witness127PayPerBlock: 128_000_000, // 128 TRX, mainnet value
})

/** Process-local controls for one node, outside its chain birth state. */
export interface NodeRuntimeOptions {
  /** Output for this node's formatted runtime logs. */
  logger?: Logger
  common: Required<CommonOptions>
  /** Constant-call energy budget. Default: 100,000,000 energy. */
  maxEnergyLimitForConstant: bigint
  /**
   * First block at which contract origin-energy-limit updates are available.
   * This is a startup hard-fork height, rather than a governance parameter.
   * A dev chain starts with the feature active; callers can move the height
   * forward to exercise the pre-fork REST behaviour.
   */
  energyLimitActivationBlock: bigint
  /** first block that rejects a frozen-supply expiry beyond signed int64 */
  assetFrozenSupplyOverflowActivationBlock: bigint
}

/**
 * Fully resolved chain birth state. Each field preserves the meaning of the
 * input field with the same name: `mnemonic` controls its derived accounts,
 * while `accounts` holds only directly configured private-key entries.
 */
export interface GenesisConfig {
  mnemonic: MnemonicConfig
  accounts: AccountConfig[]
  chainParameters: ChainParameters
}

/** Resolved settings owned by the execution core. */
export interface ResolvedConfig extends GenesisConfig {
  runtime: NodeRuntimeOptions
}

/** Optional startup settings. Omitted fields use the node's defaults. */
export interface ClientConfig extends InitialConfigInput {
  runtime?: NodeRuntimeOverrides
}

/**
 * What this node is, as it reports itself on `admin/`.
 * Kept in step with package.json by a unit test.
 */
export const CLIENT_NAME = '@tvmjs/client'
export const CLIENT_VERSION = '1.0.0'

export const DEFAULT_ACCOUNT_COUNT = 10
/** Maximum mnemonic-derived accounts in one configured or generated wallet. */
export const MAX_ACCOUNT_COUNT = 100
export const DEFAULT_BALANCE_SUN = 10_000_000_000n // 10_000 TRX

/** Derive the funded accounts described by a mnemonic setting. */
export function accountsFromMnemonic(mnemonic: MnemonicConfig): AccountConfig[] {
  return derivePrivateKeys(mnemonic.phrase, mnemonic.count).map((privateKey) => ({
    privateKey,
    balance: mnemonic.balance,
  }))
}

/**
 * The validated, but not yet defaulted, input accepted by every startup path.
 * This is deliberately limited to the three chain-birth fields; runtime
 * controls never belong in an initial JSON file.
 */
interface InitialConfig {
  mnemonic?: MnemonicConfig
  accounts?: AccountConfig[]
  chainParameters?: Partial<ChainParameters>
}

/** Programmatic form of the same JSON-shaped chain-birth configuration. */
export interface InitialConfigInput {
  mnemonic?: string | MnemonicConfigInput
  accounts?: AccountConfigInput[]
  chainParameters?: Partial<ChainParameters>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function accountConfigs(value: unknown, label: string): AccountConfig[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }
  return uniqueAccounts(
    value.map((entry, index) => {
      const accountLabel = `${label}[${index}]`
      if (!isObject(entry)) {
        throw new TypeError(`${accountLabel} must be an object`)
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'privateKey' && key !== 'balance') {
          throw new TypeError(`Unknown key "${key}" in ${accountLabel}`)
        }
      }
      if (typeof entry.privateKey !== 'string') {
        throw new TypeError(`${accountLabel}.privateKey must be a string`)
      }
      const privateKey = entry.privateKey.replace(/^0x/i, '')
      if (privateKey === '') {
        throw new TypeError(`${accountLabel}.privateKey is empty`)
      }
      if (/[^0-9a-f]/i.test(privateKey)) {
        throw new TypeError(`${accountLabel}.privateKey holds characters that are not hex digits`)
      }
      const balance =
        entry.balance === undefined
          ? DEFAULT_BALANCE_SUN
          : parseBalance(entry.balance, `${accountLabel}.balance`)
      if (TronWeb.address.fromPrivateKey(privateKey) === false) {
        // Configuration errors can be logged; never include the key itself.
        throw new TypeError(`${accountLabel}.privateKey is not a key this wallet accepts`)
      }
      return { privateKey, balance }
    }),
  )
}

/** Repeated configured keys are one genesis allocation; the final entry wins. */
function uniqueAccounts(accounts: AccountConfig[]): AccountConfig[] {
  const byPrivateKey = new Map<string, AccountConfig>()
  for (const account of accounts) {
    byPrivateKey.set(account.privateKey.toLowerCase(), account)
  }
  return [...byPrivateKey.values()]
}

function mnemonicConfig(value: unknown): MnemonicConfig {
  let phrase: string
  let phraseLabel = 'mnemonic'
  let count = DEFAULT_ACCOUNT_COUNT
  let balance = DEFAULT_BALANCE_SUN
  if (typeof value === 'string') {
    phrase = value
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      if (key !== 'phrase' && key !== 'count' && key !== 'balance') {
        throw new TypeError(`Unknown key "${key}" in mnemonic`)
      }
    }
    if (typeof value.phrase !== 'string') {
      throw new TypeError('mnemonic.phrase must be a string')
    }
    phrase = value.phrase
    phraseLabel = 'mnemonic.phrase'
    if (value.count !== undefined) {
      if (typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 1) {
        throw new RangeError(
          `mnemonic.count must be an integer of at least 1, got ${String(value.count)}`,
        )
      }
      if (value.count > MAX_ACCOUNT_COUNT) {
        throw new RangeError(
          `mnemonic.count must be at most ${MAX_ACCOUNT_COUNT}, got ${String(value.count)}`,
        )
      }
      count = value.count
    }
    if (value.balance !== undefined) {
      balance = parseBalance(value.balance, 'mnemonic.balance')
    }
  } else {
    throw new TypeError('mnemonic must be a string or an object')
  }
  try {
    // Validate the phrase here. Account derivation itself happens once, when
    // the complete genesis state is resolved below.
    derivePrivateKeys(phrase, 1)
    return { phrase, count, balance }
  } catch {
    throw new TypeError(`${phraseLabel} is not a valid BIP-39 phrase`)
  }
}

function chainParameterConfig(value: unknown): Partial<ChainParameters> {
  if (!isObject(value)) {
    throw new TypeError('chainParameters must be an object')
  }
  for (const [name, entry] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CHAIN_PARAMETERS, name)) {
      throw new TypeError(`Unknown chain parameter "${name}"`)
    }
    if (entry === undefined) continue
    if (typeof entry !== 'number') {
      throw new TypeError(`chainParameters.${name} must be a number`)
    }
    const fault = chainParameterFault(name, entry)
    if (fault !== undefined) {
      throw new RangeError(`chainParameters.${name} ${fault}`)
    }
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<ChainParameters>
}

// Derive accepted names from the same library tables used during initialization.
// Known inactive groups remain valid: a parameter override does not activate a rule.
const parameterTables = [paramsBlock, paramsVM, paramsTVM]
const parameterGroups = new Set([
  ...parameterTables.flatMap((table) => Object.keys(table)),
  ...TronMainnet.hardforks.map(({ name }) => name),
])
const parameterNames = new Set(
  parameterTables.flatMap((table) => Object.values(table).flatMap((fields) => Object.keys(fields))),
)

function commonParams(value: unknown = {}): ParamsDict {
  if (!isObject(value)) throw new TypeError('runtime.common.params must be an object')
  return Object.fromEntries(
    Object.entries(value).map(([group, params]) => {
      const label = `runtime.common.params.${group}`
      if (!parameterGroups.has(group)) {
        throw new TypeError(`Unknown parameter group "${group}" in runtime.common.params`)
      }
      if (!isObject(params)) throw new TypeError(`${label} must be a parameter object`)
      return [
        group,
        Object.fromEntries(
          Object.entries(params).map(([name, entry]) => {
            if (!parameterNames.has(name)) {
              throw new TypeError(`Unknown parameter "${name}" in ${label}`)
            }
            if (entry === null) return [name, null]
            const integer = parseInteger(entry, `${label}.${name}`)
            return [name, typeof entry === 'number' ? entry : integer.toString()]
          }),
        ),
      ]
    }),
  )
}

function commonConfig(value: unknown = {}): Required<CommonOptions> {
  if (!isObject(value)) throw new TypeError('runtime.common must be an object')
  const common: Required<CommonOptions> = {
    eips: [7939],
    activatedProposals: [65, 96],
    params: {},
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'params') {
      common.params = commonParams(entry)
      continue
    }
    if (key !== 'eips' && key !== 'activatedProposals') {
      throw new TypeError(`Unknown key "${key}" in runtime.common`)
    }
    if (entry === undefined) continue
    if (!Array.isArray(entry)) throw new TypeError(`runtime.common.${key} must be an array`)
    common[key] = Array.from(entry, (id: number, index) => {
      requireInteger(id, `runtime.common.${key}[${index}]`, 1)
      return id
    })
  }
  return common
}

/**
 * Parse the JSON-shaped chain-birth configuration shared by the CLI, imported
 * JSON, and programmatic startup.
 */
export function parseInitialConfig(value: unknown): InitialConfig {
  if (!isObject(value)) {
    throw new TypeError('The initial configuration must be an object')
  }
  const config: InitialConfig = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'mnemonic') {
      if (entry !== undefined) config.mnemonic = mnemonicConfig(entry)
    } else if (key === 'accounts') {
      if (entry !== undefined) config.accounts = accountConfigs(entry, 'accounts')
    } else if (key === 'chainParameters') {
      if (entry !== undefined) config.chainParameters = chainParameterConfig(entry)
    } else {
      throw new TypeError(`Unknown key "${key}"`)
    }
  }
  return config
}

/** Process-local options, separate from the JSON birth-state format. */
export interface NodeRuntimeOverrides {
  /** Output for formatted logs, including the first produced block. Omitted: quiet. */
  logger?: Logger
  /**
   * Defaults: EIP [7939], proposals [65, 96]. Supplied lists replace defaults;
   * params overrides individual fields within each library's parameter groups.
   * Unknown groups or names are rejected. Overrides in known inactive groups
   * are retained but take effect only when their rule is active.
   */
  common?: CommonOptions
  /** Constant-call energy budget. Default: 100,000,000 energy. */
  maxEnergyLimitForConstant?: IntegerInput
  /** First block allowing origin-energy-limit updates. Default: 0 (active from startup). */
  energyLimitActivationBlock?: IntegerInput
  /** First block rejecting frozen-supply expiry overflow. Default: 0 (active from startup). */
  assetFrozenSupplyOverflowActivationBlock?: IntegerInput
}

/** Normalize and copy all startup settings before node creation begins. */
export function resolveConfig(input: ClientConfig = {}): ResolvedConfig {
  if (!isObject(input)) throw new TypeError('The node configuration must be an object')
  const { runtime = {}, ...birthState } = input
  const initial = parseInitialConfig(birthState)
  const mnemonic = initial.mnemonic ?? {
    phrase: DEV_MNEMONIC,
    count: DEFAULT_ACCOUNT_COUNT,
    balance: DEFAULT_BALANCE_SUN,
  }
  return {
    mnemonic,
    accounts: initial.accounts ?? [],
    chainParameters: { ...DEFAULT_CHAIN_PARAMETERS, ...initial.chainParameters },
    runtime: resolveRuntime(runtime),
  }
}

function resolveRuntime(overrides: unknown): NodeRuntimeOptions {
  if (!isObject(overrides)) throw new TypeError('runtime must be an object')
  const defaults = {
    maxEnergyLimitForConstant: 100_000_000n,
    energyLimitActivationBlock: 0n,
    assetFrozenSupplyOverflowActivationBlock: 0n,
  }
  for (const key of Object.keys(overrides)) {
    if (
      key !== 'logger' &&
      key !== 'common' &&
      !Object.prototype.hasOwnProperty.call(defaults, key)
    ) {
      throw new TypeError(`Unknown key "${key}" in runtime`)
    }
  }
  const common = commonConfig(overrides.common)
  let logger: Logger | undefined
  if (overrides.logger !== undefined) {
    if (!isObject(overrides.logger) || typeof overrides.logger.log !== 'function') {
      throw new TypeError('runtime.logger must be an object with a log function')
    }
    logger = { log: overrides.logger.log.bind(overrides.logger) }
  }
  return {
    ...(Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => [
        key,
        overrides[key] === undefined
          ? fallback
          : parseInteger(overrides[key], `runtime.${key}`, { max: INT64_MAX }),
      ]),
    ) as typeof defaults),
    common,
    ...(logger === undefined ? {} : { logger }),
  }
}
