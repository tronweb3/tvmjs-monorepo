import { MIN_TOKEN_ID, createZeroAddress, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'

import { INT64_MAX } from '../../../intBounds.ts'
import { parseTronAddress, toBase58, toTronHex, tryParseTronAddress } from '../address.ts'
import { listOf } from '../mergeValue.ts'
import {
  DEFAULT_FEE_LIMIT_SUN,
  FROZEN_PERIOD_MS,
  MAX_FROZEN_SUPPLY_NUMBER,
  MAX_FROZEN_SUPPLY_TIME,
  MIN_FROZEN_SUPPLY_TIME,
  ONE_DAY_NET_LIMIT,
} from '../params.ts'
import {
  availableContractTypes,
  permissionError,
  permissionTypeOf,
  toStoredPermissions,
} from '../permission.ts'
import { accountIdHolder, hexToUtf8Loose } from './asset.ts'
import { parseHexField } from './chain.ts'
import {
  adaptCancelAllUnfreezeV2,
  adaptDelegateResource,
  adaptFreezeBalance,
  adaptFreezeBalanceV2,
  adaptUnDelegateResource,
  adaptUnfreezeBalance,
  adaptUnfreezeBalanceV2,
  adaptWithdrawExpireUnfreeze,
  transactionActivationError,
} from './stake.ts'
import { broadcastError } from './types.ts'

import type { Address } from '@tvmjs/util'
import type { ContractMeta, FrozenSupply, NodeCore, WriteParams } from '../../../core/node.ts'
import { requestKeyed } from '../../../lookup.ts'
import type { HandlerParams } from '../../registry.ts'
import type { Permission } from '../permission.ts'
import type { SignedTronTx, TronContractJSON } from './types.ts'

/** TRON deploy address: '41' + keccak256(txid ++ owner21)[12:] */
export function genDeployAddress(owner41: string, txID: string): Address {
  const hash = utils.ethersUtils.keccak256(hexToBytes(`0x${txID}${owner41}`))
  return parseTronAddress(`41${hash.slice(2).slice(24)}`)
}

/**
 * asset_name carries the token id as bytes, which on the wire is hex. Those
 * bytes are the store key, so the id is whatever they decode to and nothing
 * else: `01000001` decodes to four non-digit bytes and names no token, however
 * much it reads like one.
 */
export function parseAssetId(value: unknown, visible = false): number | undefined {
  const raw = visible ? String(value ?? '') : String(value ?? '').replace(/^0x/i, '')
  if (raw === '') return undefined
  // under `visible` the field arrives as the id's own text; otherwise it is the
  // hex of the store key, and whatever those bytes decode to is the whole answer
  const decoded = visible
    ? raw
    : /^[0-9a-fA-F]+$/.test(raw)
      ? hexToUtf8Loose(raw.length % 2 === 0 ? raw : `0${raw}`)
      : ''
  const id = Number(decoded)
  return Number.isSafeInteger(id) && id >= 0 && String(id) === decoded ? id : undefined
}

/** Resolve an asset's request key under the active TRC-10 store layout. */
export function assetIdOf(node: NodeCore, value: unknown, visible: boolean): number | undefined {
  if (node.config.chainParameters.allowSameTokenName === 0) {
    const name = hexToUtf8Loose(
      visible ? TronWeb.fromUtf8(String(value ?? '')) : parseHexField(value),
    )
    const matches = node.assets.byName(name)
    return matches.length === 1 ? matches[0].id : undefined
  }
  return parseAssetId(value, visible)
}

/**
 * A name-string field as bytes. Under `visible` the request carries the text
 * itself; otherwise it carries the hex of those bytes.
 */
function nameBytesOf(value: unknown, visible: boolean): string {
  const raw = String(value ?? '')
  return visible ? TronWeb.fromUtf8(raw).replace(/^0x/, '') : raw.replace(/^0x/i, '')
}

/** UTF-8 byte length, the unit protobuf string limits are expressed in */
function byteLengthUtf8(text: string): number {
  return new TextEncoder().encode(text).length
}

function byteLength(hex: unknown): number {
  return parseHexField(hex).length / 2
}

/** non-empty, within maxBytes, and every byte printable ASCII (0x21..0x7e) */
function readableBytes(hex: unknown, maxBytes: number): boolean {
  const raw = parseHexField(hex)
  const length = byteLength(raw)
  if (length === 0 || length > maxBytes) return false
  for (let i = 0; i < raw.length; i += 2) {
    const byte = Number.parseInt(raw.slice(i, i + 2), 16)
    if (Number.isNaN(byte) || byte < 0x21 || byte > 0x7e) return false
  }
  return true
}

/** account names allow empty and cap at 200 bytes */
function validAccountName(hex: string): boolean {
  return byteLength(hex) <= 200
}

/** account ids are 8..32 printable bytes */
function validAccountId(hex: string): boolean {
  const length = byteLength(hex)
  return length >= 8 && readableBytes(hex, 32)
}

/**
 * Field-level rules an issuance must satisfy, in actuator order. Returns
 * the wire message of the first failure.
 */
function assetIssueFieldError(
  value: Record<string, unknown>,
  headMs: number,
  allowSameTokenName: number,
  assetNameTaken: boolean,
  frozenSupplyOverflowActive: boolean,
): string | undefined {
  if (!readableBytes(value.name, 32)) return 'Invalid assetName'
  if (allowSameTokenName !== 0 && hexToUtf8Loose(value.name).toLowerCase() === 'trx') {
    return "assetName can't be trx"
  }

  const precision = Number(value.precision ?? 0)
  if (precision !== 0 && allowSameTokenName !== 0 && (precision < 0 || precision > 6)) {
    return 'precision cannot exceed 6'
  }

  // abbr is optional, but a present one is held to the same rule as the name
  if (byteLength(value.abbr) > 0 && !readableBytes(value.abbr, 32)) {
    return 'Invalid abbreviation for token'
  }
  if (byteLength(value.url) === 0 || byteLength(value.url) > 256) return 'Invalid url'
  if (byteLength(value.description) > 200) return 'Invalid description'

  const startTime = BigInt((value.start_time as string | number | bigint) ?? 0)
  const endTime = BigInt((value.end_time as string | number | bigint) ?? 0)
  if (startTime === 0n) return 'Start time should be not empty'
  if (endTime === 0n) return 'End time should be not empty'
  if (endTime <= startTime) return 'End time should be greater than start time'
  if (startTime <= BigInt(headMs)) return 'Start time should be greater than HeadBlockTime'
  if (allowSameTokenName === 0 && assetNameTaken) return 'Token exists'

  if (BigInt((value.total_supply as string | number) ?? 0) <= 0n) {
    return 'TotalSupply must greater than 0!'
  }
  if (Number(value.trx_num ?? 0) <= 0) return 'TrxNum must greater than 0!'
  if (Number(value.num ?? 0) <= 0) return 'Num must greater than 0!'
  if (Number(value.public_free_asset_net_usage ?? 0) !== 0) {
    return 'PublicFreeAssetNetUsage must be 0!'
  }
  const frozen = Array.isArray(value.frozen_supply) ? value.frozen_supply : []
  if (frozen.length > MAX_FROZEN_SUPPLY_NUMBER) return 'Frozen supply list length is too long'

  const freeNetLimit = Number(value.free_asset_net_limit ?? 0)
  if (freeNetLimit < 0 || freeNetLimit >= ONE_DAY_NET_LIMIT) return 'Invalid FreeAssetNetLimit'
  const publicFreeNetLimit = Number(value.public_free_asset_net_limit ?? 0)
  if (publicFreeNetLimit < 0 || publicFreeNetLimit >= ONE_DAY_NET_LIMIT) {
    return 'Invalid PublicFreeAssetNetLimit'
  }

  let remainSupply = BigInt((value.total_supply as string | number) ?? 0)
  for (const entry of frozen as Record<string, unknown>[]) {
    const amount = BigInt((entry.frozen_amount as string | number) ?? 0)
    if (amount <= 0n) return 'Frozen supply must be greater than 0!'
    if (amount > remainSupply) return 'Frozen supply cannot exceed total supply'
    const days = Number(entry.frozen_days ?? 0)
    if (days < MIN_FROZEN_SUPPLY_TIME || days > MAX_FROZEN_SUPPLY_TIME) {
      return `frozenDuration must be less than ${MAX_FROZEN_SUPPLY_TIME} days and more than ${MIN_FROZEN_SUPPLY_TIME} days`
    }
    // the tranche's expiry timestamp must fit a signed 64-bit integer
    if (
      frozenSupplyOverflowActive &&
      startTime + BigInt(days) * BigInt(FROZEN_PERIOD_MS) > INT64_MAX
    ) {
      return 'Start time and frozen days would cause expire time overflow'
    }
    remainSupply -= amount
  }
  return undefined
}

/**
 * Locked tranches as the actuator records them: the window is measured in whole
 * days from the sale start, not from issuance.
 */
function frozenTranches(value: Record<string, unknown>): FrozenSupply[] {
  const frozen = Array.isArray(value.frozen_supply) ? value.frozen_supply : []
  const startTime = BigInt((value.start_time as string | number | bigint) ?? 0)
  return (frozen as Record<string, unknown>[]).map((entry) => ({
    frozenBalance: BigInt((entry.frozen_amount as string | number) ?? 0),
    expireTime: BigInt.asIntN(
      64,
      startTime + BigInt(Number(entry.frozen_days ?? 0)) * BigInt(FROZEN_PERIOD_MS),
    ),
  }))
}

/** the part of the supply that reaches the issuer's balance at issuance */
function unfrozenSupply(value: Record<string, unknown>): bigint {
  const frozen = Array.isArray(value.frozen_supply) ? value.frozen_supply : []
  let remain = BigInt((value.total_supply as string | number) ?? 0)
  for (const entry of frozen as Record<string, unknown>[]) {
    remain -= BigInt((entry.frozen_amount as string | number) ?? 0)
  }
  return remain
}

/**
 * Value and token rules both VM contract types share, checked against the raw
 * wire fields before the transaction buys anything.
 */
function callValueRule(callValue: bigint): string | undefined {
  return callValue < 0n ? 'callValue must be >= 0' : undefined
}

function feeLimitRule(feeLimit: bigint, maxFeeLimitSun: number): string | undefined {
  if (feeLimit < 0n || feeLimit > BigInt(maxFeeLimitSun)) {
    return `feeLimit must be >= 0 and <= ${maxFeeLimitSun}`
  }
  return undefined
}

function tokenValueRule(value: Record<string, unknown>): string | undefined {
  return BigInt((value.call_token_value as string | number) ?? 0) < 0n
    ? 'tokenValue must be >= 0'
    : undefined
}

/**
 * A named token is either absent (id 0) or a real TRC-10 above the floor; the
 * id rule stands on its own, whatever the value being transferred.
 */
function tokenValueAndIdRule(value: Record<string, unknown>): string | undefined {
  const tokenValue = BigInt((value.call_token_value as string | number) ?? 0)
  const tokenId = BigInt((value.token_id as string | number) ?? 0)
  if (tokenId <= MIN_TOKEN_ID && tokenId !== 0n) return `tokenId must be > ${MIN_TOKEN_ID}`
  if (tokenValue > 0n && tokenId === 0n) {
    return `invalid arguments with tokenValue = ${tokenValue}, tokenId = ${tokenId}`
  }
  return undefined
}

/** run rules in the order given, returning the first failure */
function firstError(...rules: (string | undefined)[]): string | undefined {
  for (const rule of rules) {
    if (rule !== undefined) return rule
  }
  return undefined
}

/**
 * The endowment a VM contract carries moves as an internal transfer, and that
 * transfer is validated before execution starts.
 */
async function callValueError(
  node: NodeCore,
  caller: Address,
  callValue: bigint,
): Promise<string | undefined> {
  if (callValue === 0n) return undefined
  if ((await node.getBalance(caller)) < callValue) {
    return 'Validate InternalTransfer error, balance is not sufficient.'
  }
  return undefined
}

/** what the broadcast path knows that an actuator would read from the store */
export interface ValidateContext {
  /** the recipient does not exist yet, so the transfer creates it */
  createsAccount: boolean
  /** a build endpoint is asking; some actuators bill the build's own bytes */
  building?: boolean
}

export type StateOpOutcome =
  | { feeSun: bigint; extra?: Record<string, unknown> }
  | { error: Record<string, unknown> }

export interface AdaptedContract {
  /** VM execution (Transfer / Trigger / Create) */
  params?: WriteParams
  /** pure state operation (TRC-10 family) — runs inside the write lock */
  stateOp?: (node: NodeCore) => Promise<StateOpOutcome>
  /**
   * Actuator checks that need chain state. Returns the wire message of the
   * first failure; the caller decides which error dialect to speak, since the
   * same rule surfaces differently when building versus when broadcasting.
   */
  validate?: (node: NodeCore, ctx?: ValidateContext) => Promise<string | undefined>
  /** set on CreateSmartContract: registered after a successful deploy */
  deployMeta?: ContractMeta
}

/** What every contract adapter reads off the transaction it is adapting. */
export interface AdaptContext {
  node: NodeCore
  contract: TronContractJSON
  tx: SignedTronTx
  /** the contract's own fields, as the request stated them */
  value: Record<string, unknown>
  caller: Address
  feeLimit: bigint
  energyLimit: bigint
}

export type AdaptResult = AdaptedContract | { error: Record<string, unknown> }

function adaptTransfer(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const to = parseTronAddress(String(value.to_address ?? ''))
  const amount = BigInt((value.amount as string | number) ?? 0)
  return {
    // baseline order: identity, then the sender's existence, then the
    // amount, then the recipient's nature
    validate: async (n) => {
      if (to.equals(caller)) {
        return 'Cannot transfer TRX to yourself.'
      }
      if ((await n.getAccount(caller)) === undefined) {
        return 'Validate TransferContract error, no OwnerAccount.'
      }
      if (amount <= 0n) {
        return 'Amount must be greater than 0.'
      }
      const recipient = await n.getAccount(to)
      const isContract = n.accountTypeOf(to) === 'Contract'
      // The proposal controls plain TRX transfers to contract accounts.
      if (n.config.chainParameters.forbidTransferToContract === 1 && isContract) {
        return 'Cannot transfer TRX to a smartContract.'
      }
      // last, and against amount plus the fee: a transfer is free unless it
      // has to open the recipient's account first
      const fee =
        recipient === undefined
          ? BigInt(n.config.chainParameters.createNewAccountFeeInSystemContract)
          : 0n
      if (amount + fee > INT64_MAX) return 'long overflow'
      if ((await n.getBalance(caller)) < amount + fee) {
        return 'Validate TransferContract error, balance is not sufficient.'
      }
      if (recipient !== undefined && (await n.getBalance(to)) + amount > INT64_MAX) {
        return 'long overflow'
      }
      return undefined
    },
    params: {
      caller,
      to,
      data: new Uint8Array(),
      value: amount,
      energyLimit: 0n, // plain transfers use bandwidth, not energy
      plainTransfer: true,
    },
  }
}

function adaptTriggerSmart(ctx: AdaptContext): AdaptResult {
  const { value, caller, feeLimit, energyLimit } = ctx
  const target = parseTronAddress(String(value.contract_address ?? ''))
  const callValue = BigInt((value.call_value as string | number) ?? 0)
  return {
    // baseline order: the contract must exist before its arguments are
    // judged, and the fee limit is checked last
    validate: async (n) => {
      if ((await n.getCode(target)).length === 0) {
        return 'No contract or not a smart contract'
      }
      const invalid = firstError(
        callValueRule(callValue),
        tokenValueRule(value),
        tokenValueAndIdRule(value),
        feeLimitRule(feeLimit, n.config.chainParameters.maxFeeLimit),
      )
      if (invalid !== undefined) {
        return invalid
      }
      // the value moves before the first opcode runs, so a sender who
      // cannot cover it fails validation: no block, no receipt, no fee
      return callValueError(n, caller, callValue)
    },
    params: {
      caller,
      to: target,
      data: hexToBytes(`0x${String(value.data ?? '')}`),
      value: callValue,
      energyLimit,
      tokenId: value.token_id !== undefined ? BigInt(value.token_id as string) : undefined,
      tokenValue:
        value.call_token_value !== undefined ? BigInt(value.call_token_value as string) : undefined,
    },
  }
}

/**
 * Contract metadata updates: no VM frame, just a guarded write to the
 * contract record. All three are owner-only and reject an address that
 * holds no contract.
 */
function adaptClearABI(ctx: AdaptContext): AdaptResult {
  const { contract, value, caller } = ctx
  // these actuators never judge the contract address as an address; they
  // look it up, and a miss is simply a contract that does not exist
  const target = tryParseTronAddress(String(value.contract_address ?? ''))
  const percent = Number(value.consume_user_resource_percent ?? 0)
  const originEnergyLimit = Number(value.origin_energy_limit ?? 0)
  return {
    validate: async (n) => {
      const clearing = contract.type === 'ClearABIContract'
      if ((await n.getAccount(caller)) === undefined) {
        return clearing
          ? `Account[${toTronHex(caller)}] not exists`
          : `Account[${toTronHex(caller)}] does not exist`
      }
      if (contract.type === 'UpdateSettingContract' && (percent > 100 || percent < 0)) {
        return 'percent not in [0, 100]'
      }
      if (contract.type === 'UpdateEnergyLimitContract' && originEnergyLimit <= 0) {
        return 'origin energy limit must be > 0'
      }
      const meta = target === undefined ? undefined : n.getContractMeta(target)
      if (meta === undefined) {
        return clearing ? 'Contract not exists' : 'Contract does not exist'
      }
      if ((meta.originAddress ?? '').toLowerCase() !== toTronHex(caller).toLowerCase()) {
        return `Account[${toTronHex(caller)}] is not the owner of the contract`
      }
      return undefined
    },
    stateOp: async (n) => {
      const meta = target === undefined ? undefined : n.getContractMeta(target)
      if (meta === undefined || target === undefined) {
        return { error: broadcastError('CONTRACT_VALIDATE_ERROR', 'Contract does not exist') }
      }
      // the undo journal keeps the record by reference, so an update states
      // a new one
      const updated =
        contract.type === 'UpdateSettingContract'
          ? { ...meta, consumeUserResourcePercent: percent }
          : contract.type === 'UpdateEnergyLimitContract'
            ? { ...meta, originEnergyLimit }
            : { ...meta, abi: [] }
      n.registerContract(target, updated)
      return { feeSun: 0n }
    },
  }
}

function adaptCreateSmart(ctx: AdaptContext): AdaptResult {
  const { tx, value, caller, feeLimit, energyLimit } = ctx
  const newContract = (value.new_contract ?? {}) as Record<string, unknown>
  const bytecode = String(newContract.bytecode ?? '')
  const abi = (newContract.abi as { entrys?: unknown[] } | undefined)?.entrys ?? []
  const deployValue = BigInt((newContract.call_value as string | number) ?? 0)
  const percent = Number(newContract.consume_user_resource_percent ?? 0)
  const originEnergyLimit = Number(newContract.origin_energy_limit ?? 0)
  const contractName = String(newContract.name ?? '')
  const deployAddress = genDeployAddress(toTronHex(caller), tx.txID)
  return {
    /**
     * Baseline order: origin, name and percent are judged against the
     * request alone, then the target address, then the amounts, and the
     * token pair last.
     */
    validate: async (n) => {
      // the deployer signs as owner, so it is also the contract's origin
      if (
        newContract.origin_address !== undefined &&
        !parseTronAddress(String(newContract.origin_address)).equals(caller)
      ) {
        return 'OwnerAddress is not equals OriginAddress'
      }
      if (byteLengthUtf8(contractName) > 32) {
        return "contractName's length cannot be greater than 32"
      }
      if (percent < 0 || percent > 100) {
        return 'percent must be >= 0 and <= 100'
      }
      // any account at the target, contract or not, blocks the deploy
      if ((await n.getAccount(deployAddress)) !== undefined) {
        return `Trying to create a contract with existing contract address: ${toBase58(deployAddress)}`
      }
      const invalid = firstError(
        feeLimitRule(feeLimit, n.config.chainParameters.maxFeeLimit),
        callValueRule(deployValue),
        tokenValueRule(value),
      )
      if (invalid !== undefined) {
        return invalid
      }
      if (originEnergyLimit <= 0) {
        return 'The originEnergyLimit must be > 0'
      }
      const tokenPair = tokenValueAndIdRule(value)
      if (tokenPair !== undefined) {
        return tokenPair
      }
      return callValueError(n, caller, deployValue)
    },
    params: {
      caller,
      to: createZeroAddress(), // unused on the create path
      create: true,
      deployAddress,
      data: hexToBytes(`0x${bytecode}`),
      value: deployValue,
      energyLimit,
      tokenId: value.token_id !== undefined ? BigInt(value.token_id as string) : undefined,
      tokenValue:
        value.call_token_value !== undefined ? BigInt(value.call_token_value as string) : undefined,
    },
    deployMeta: {
      consumeUserResourcePercent: percent,
      originEnergyLimit,
      abi,
      name: String(newContract.name ?? ''),
      originAddress: toTronHex(caller),
      bytecode,
    },
  }
}

function adaptAssetIssue(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const input = {
    name: hexToUtf8Loose(value.name),
    // an absent abbreviation stays absent; it is not the name
    abbr: hexToUtf8Loose(value.abbr ?? ''),
    totalSupply: BigInt((value.total_supply as string | number) ?? 0),
    trxNum: Number(value.trx_num ?? 1),
    num: Number(value.num ?? 1),
    precision: Number(value.precision ?? 0),
    startTime: BigInt((value.start_time as string | number | bigint) ?? 0),
    endTime: BigInt((value.end_time as string | number | bigint) ?? 0),
    order: BigInt((value.order as string | number | bigint) ?? 0),
    voteScore: Number(value.vote_score ?? 0),
    description: hexToUtf8Loose(value.description ?? ''),
    url: hexToUtf8Loose(value.url ?? ''),
    freeAssetNetLimit: Number(value.free_asset_net_limit ?? 0),
    frozenSupply: (Array.isArray(value.frozen_supply) ? value.frozen_supply : []).map((entry) => ({
      frozen_amount: BigInt(
        ((entry as Record<string, unknown>).frozen_amount as string | number) ?? 0,
      ),
      frozen_days: Number((entry as Record<string, unknown>).frozen_days ?? 0),
    })),
    publicFreeAssetNetLimit: Number(value.public_free_asset_net_limit ?? 0),
    // usage arrives zero (validate refused anything else); the timestamp is
    // stored as given
    publicFreeAssetNetUsage: Number(value.public_free_asset_net_usage ?? 0),
    publicLatestFreeNetTime: Number(value.public_latest_free_net_time ?? 0),
  }
  return {
    validate: async (n) => {
      const fieldError = assetIssueFieldError(
        value,
        n.head().timestampMs,
        n.config.chainParameters.allowSameTokenName,
        n.assets.byName(input.name).length > 0,
        n.blocks.height() >= n.runtime.assetFrozenSupplyOverflowActivationBlock,
      )
      if (fieldError !== undefined) return fieldError
      if ((await n.getAccount(caller)) === undefined) return 'Account not exists'
      if (n.hasIssuedAsset(caller)) return 'An account can only issue one asset'
      if ((await n.getBalance(caller)) < BigInt(n.config.chainParameters.assetIssueFee)) {
        return 'No enough balance for fee!'
      }
      return undefined
    },
    stateOp: async (n) => {
      const issueFeeSun = BigInt(n.config.chainParameters.assetIssueFee)
      await n.deductBalance(caller, issueFeeSun)
      const meta = await n.issueAsset(caller, input, unfrozenSupply(value), frozenTranches(value))
      if (meta === 'owner-already-issued') {
        await n.creditBalance(caller, issueFeeSun)
        return {
          error: broadcastError('CONTRACT_VALIDATE_ERROR', 'An account can only issue one asset'),
        }
      }
      if (meta === 'asset-name-already-issued') {
        await n.creditBalance(caller, issueFeeSun)
        return { error: broadcastError('CONTRACT_VALIDATE_ERROR', 'Token exists') }
      }
      return { feeSun: issueFeeSun, extra: { assetIssueID: String(meta.id) } }
    },
  }
}

/**
 * Release matured tranches of the issuer's own locked supply. The window is
 * judged against the head block time, not the wall clock.
 */
function adaptUnfreezeAsset(ctx: AdaptContext): AdaptResult {
  const { caller } = ctx
  return {
    validate: async (n) => {
      if ((await n.getAccount(caller)) === undefined) {
        return `Account[${toTronHex(caller)}] does not exist`
      }
      const tranches = n.frozenSupplyOf(caller)
      if (tranches.length === 0) return 'no frozen supply balance'
      const issued = n.assetIssuedBy(caller)
      const hasIssuedAsset =
        n.config.chainParameters.allowSameTokenName === 0
          ? issued?.name !== undefined
          : issued?.id !== undefined
      if (!hasIssuedAsset) {
        return 'this account has not issued any asset'
      }
      const now = n.head().timestampMs
      if (!tranches.some((t) => t.expireTime <= now)) {
        return "It's not time to unfreeze asset supply"
      }
      return undefined
    },
    stateOp: async (n) => {
      const issued = n.assetIssuedBy(caller)
      if (issued === undefined) {
        return {
          error: broadcastError('CONTRACT_VALIDATE_ERROR', 'this account has not issued any asset'),
        }
      }
      const now = BigInt(n.head().timestampMs)
      const released = n
        .frozenSupplyOf(caller)
        .filter((tranche) => tranche.expireTime <= now)
        .reduce((sum, tranche) => sum + tranche.frozenBalance, 0n)
      if ((await n.getAssetBalance(caller, issued.id)) + released > INT64_MAX) {
        return { error: broadcastError('CONTRACT_EXE_ERROR', 'long overflow') }
      }
      await n.unfreezeAsset(caller, issued.id)
      return { feeSun: 0n }
    },
  }
}

/**
 * Reshape an account's permission set. Owner, witness and active permissions
 * are replaced wholesale; ids are assigned by position — 0, 1, then 2 upward —
 * not by the request.
 */
function adaptAccountPermissionUpdate(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  // the wire carries protobuf enums, so a permission's type may be a name,
  // a number, or absent — absent meaning Owner, the zero value
  // every field the request left out is already at its protobuf default
  // by the time an actuator reads it, so the checks below never meet an
  // absent one
  const normalise = (entry: unknown): Permission | undefined => {
    if (entry === undefined || entry === null || typeof entry !== 'object') return undefined
    const raw = entry as Record<string, unknown>
    const keys = raw.keys === undefined || raw.keys === null ? [] : listOf(raw.keys)
    return {
      ...(raw as unknown as Permission),
      type: permissionTypeOf(raw.type) ?? ('Unknown' as Permission['type']),
      permission_name: raw.permission_name === undefined ? '' : String(raw.permission_name),
      threshold: BigInt((raw.threshold as string | number | bigint) ?? 0),
      keys: keys.map((key) => {
        const held = (key ?? {}) as Record<string, unknown>
        return {
          address: String(held.address ?? ''),
          weight: BigInt((held.weight as string | number | bigint) ?? 0),
        }
      }),
    }
  }
  const owner = normalise(value.owner)
  const witness = normalise(value.witness)
  const actives = listOf(value.actives)
    .map(normalise)
    .filter((entry): entry is Permission => entry !== undefined)
  const hasWitness = value.witness !== undefined && value.witness !== null
  return {
    validate: async (n) => {
      const params = n.config.chainParameters
      if ((await n.getAccount(caller)) === undefined) {
        return 'ownerAddress account does not exist'
      }
      if (owner === undefined) return 'owner permission is missed'
      const isWitness = n.isWitness(caller)
      if (isWitness) {
        if (!hasWitness) return 'witness permission is missed'
      } else if (hasWitness) {
        return "account isn't witness can't set witness permission"
      }
      if (actives.length === 0) return 'active permission is missed'
      if (actives.length > 8) return 'active permission is too many'
      if (owner.type !== 'Owner') return 'owner permission type is error'
      const contractTypes = availableContractTypes(params)
      const invalid = permissionError(owner, params.totalSignNum, contractTypes)
      if (invalid !== undefined) return invalid
      if (isWitness) {
        if (witness?.type !== 'Witness') return 'witness permission type is error'
        const witnessInvalid = permissionError(witness, params.totalSignNum, contractTypes)
        if (witnessInvalid !== undefined) return witnessInvalid
      }
      // each active is judged whole before the next one is looked at
      for (const active of actives) {
        if (active.type !== 'Active') return 'active permission type is error'
        const activeInvalid = permissionError(active, params.totalSignNum, contractTypes)
        if (activeInvalid !== undefined) return activeInvalid
      }
      return undefined
    },
    stateOp: async (n) => {
      const feeSun = BigInt(n.config.chainParameters.updateAccountPermissionFee)
      const balance = await n.getBalance(caller)
      // the fee is charged while applying the change, not while checking it
      if (balance < feeSun) {
        return {
          error: broadcastError(
            'CONTRACT_EXE_ERROR',
            `${toTronHex(caller)} insufficient balance, balance: ${balance}, amount: ${feeSun}`,
          ),
        }
      }
      await n.deductBalance(caller, feeSun)
      await n.setPermissions(
        caller,
        toStoredPermissions([
          { ...(owner as Permission), id: 0 },
          ...(witness === undefined ? [] : [{ ...witness, id: 1 }]),
          ...actives.map((active, index) => ({ ...active, id: index + 2 })),
        ]),
      )
      return { feeSun }
    },
  }
}

/** Set an account name; the proposal controls renaming and duplicate names. */
function adaptAccountUpdate(ctx: AdaptContext): AdaptResult {
  const { tx, value, caller } = ctx
  const accountName = nameBytesOf(value.account_name, tx.visible === true)
  return {
    validate: async (n) => {
      if (!validAccountName(accountName)) return 'Invalid accountName'
      if ((await n.getAccount(caller)) === undefined) return 'Account does not exist'
      const currentName = n.accountNameOf(caller)
      if (
        currentName !== undefined &&
        currentName !== '' &&
        n.config.chainParameters.allowUpdateAccountName === 0
      ) {
        return 'This account name is already existed'
      }
      if (
        n.accountNames.has(accountName.toLowerCase()) &&
        n.config.chainParameters.allowUpdateAccountName === 0
      ) {
        return 'This name is existed'
      }
      return undefined
    },
    stateOp: async (n) => {
      n.setAccountName(caller, accountName)
      return { feeSun: 0n }
    },
  }
}

/** claim a chain-wide account id; it can be set once and never changed */
function adaptSetAccountId(ctx: AdaptContext): AdaptResult {
  const { tx, value, caller } = ctx
  const accountId = nameBytesOf(value.account_id, tx.visible === true)
  return {
    validate: async (n) => {
      if (!validAccountId(accountId)) return 'Invalid accountId'
      if ((await n.getAccount(caller)) === undefined) return 'Account has not existed'
      if (n.accountIdOf(caller) !== undefined) return 'This account id already set'
      if (accountIdHolder(n, accountId) !== undefined) return 'This id has existed'
      return undefined
    },
    stateOp: async (n) => {
      // stored under its original text; lookups lowercase both sides
      n.accountIds.set(accountId, toTronHex(caller).toLowerCase())
      n.recordUndo(() => n.accountIds.delete(accountId))
      return { feeSun: 0n }
    },
  }
}

/** create an account outright, paying the system-contract fee for it */
function adaptAccountCreate(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const target = tryParseTronAddress(String(value.account_address ?? ''))
  return {
    validate: async (n) => {
      const fee = BigInt(n.config.chainParameters.createNewAccountFeeInSystemContract)
      const account = await n.getAccount(caller)
      if (account === undefined) {
        return `Account[${toTronHex(caller)}] not exists`
      }
      if (account.balance < fee) {
        return 'Validate CreateAccountActuator error, insufficient fee.'
      }
      if (target === undefined) return 'Invalid account address'
      if ((await n.getAccount(target)) !== undefined) return 'Account has existed'
      return undefined
    },
    stateOp: async (n) => {
      if (target === undefined) return { feeSun: 0n }
      const feeSun = BigInt(n.config.chainParameters.createNewAccountFeeInSystemContract)
      await n.deductBalance(caller, feeSun)
      await n.setBalanceUnlocked(target, 0n)
      // the declared type persists on the record; Normal is the default and
      // stays unstated (wire carries the enum name or its number)
      const declared = value.type
      if (declared === 'AssetIssue' || declared === 1) n.noteAccountType(target, 'AssetIssue')
      if (declared === 'Contract' || declared === 2) n.noteAccountType(target, 'Contract')
      return { feeSun }
    },
  }
}

/** amend an issuance's mutable fields; the rest of it is fixed at issuance */
function adaptUpdateAsset(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const newUrl = String(value.url ?? '')
  const newDescription = String(value.description ?? '')
  const newLimit = Number(value.new_limit ?? 0)
  const newPublicLimit = Number(value.new_public_limit ?? 0)
  return {
    validate: async (n) => {
      if ((await n.getAccount(caller)) === undefined) return 'Account does not exist'
      const issued = n.assetIssuedBy(caller)
      const hasIssuedAsset =
        n.config.chainParameters.allowSameTokenName === 0
          ? issued?.name !== undefined
          : issued?.id !== undefined
      if (!hasIssuedAsset) return 'Account has not issued any asset'
      if (byteLength(newUrl) === 0 || byteLength(newUrl) > 256) return 'Invalid url'
      if (byteLength(newDescription) > 200) return 'Invalid description'
      if (newLimit < 0 || newLimit >= ONE_DAY_NET_LIMIT) return 'Invalid FreeAssetNetLimit'
      if (newPublicLimit < 0 || newPublicLimit >= ONE_DAY_NET_LIMIT) {
        return 'Invalid PublicFreeAssetNetLimit'
      }
      return undefined
    },
    stateOp: async (n) => {
      const meta = n.assetIssuedBy(caller)
      if (meta === undefined) {
        return {
          error: broadcastError('CONTRACT_VALIDATE_ERROR', 'Account has not issued any asset'),
        }
      }
      const before = { ...meta }
      n.recordUndo(() => Object.assign(meta, before))
      meta.url = hexToUtf8Loose(newUrl)
      meta.description = hexToUtf8Loose(newDescription)
      meta.freeAssetNetLimit = newLimit
      meta.publicFreeAssetNetLimit = newPublicLimit
      return { feeSun: 0n }
    },
  }
}

function adaptTransferAsset(ctx: AdaptContext): AdaptResult {
  const { tx, value, caller } = ctx
  const to = parseTronAddress(String(value.to_address ?? ''))
  const amount = BigInt((value.amount as string | number) ?? 0)
  return {
    // baseline order: the asset and the holding are judged before the
    // recipient's nature
    validate: async (n, ctx) => {
      if (amount <= 0n) return 'Amount must be greater than 0.'
      if (to.equals(caller)) return 'Cannot transfer asset to yourself.'
      if ((await n.getAccount(caller)) === undefined) return 'No owner account!'
      const tokenId = assetIdOf(n, value.asset_name, tx.visible === true)
      if (tokenId === undefined || n.assets.byId(tokenId) === undefined) return 'No asset!'
      const held = await n.getAssetBalance(caller, tokenId)
      if (held <= 0n) return 'assetBalance must be greater than 0.'
      if (amount > held) return 'assetBalance is not sufficient.'
      if (
        n.config.chainParameters.forbidTransferToContract === 1 &&
        n.accountTypeOf(to) === 'Contract'
      ) {
        return 'Cannot transfer asset to smartContract.'
      }
      // creating the recipient costs a system-contract fee, judged last
      if (ctx?.createsAccount === true) {
        const createFee = BigInt(n.config.chainParameters.createNewAccountFeeInSystemContract)
        if ((await n.getBalance(caller)) < createFee) {
          return 'Validate TransferAssetActuator error, insufficient fee.'
        }
      } else if ((await n.getAssetBalance(to, tokenId as number)) + amount > INT64_MAX) {
        return 'long overflow'
      }
      return undefined
    },
    stateOp: async (n) => {
      const tokenId = assetIdOf(n, value.asset_name, tx.visible === true)
      if (tokenId === undefined) {
        return { error: broadcastError('CONTRACT_VALIDATE_ERROR', 'No asset!') }
      }
      await n.transferAsset(caller, to, tokenId, amount)
      return { feeSun: 0n }
    },
  }
}

function adaptParticipateAssetIssue(ctx: AdaptContext): AdaptResult {
  const { tx, value, caller } = ctx
  const issuer = parseTronAddress(String(value.to_address ?? ''))
  const amountSun = BigInt((value.amount as string | number) ?? 0)
  // baseline order: the request alone, then the sender, then the asset,
  // then the sale window, then the exchange, then the counterparties
  return {
    validate: async (n) => {
      if (amountSun <= 0n) return 'Amount must greater than 0!'
      if (issuer.equals(caller)) return 'Cannot participate asset Issue yourself !'
      if ((await n.getAccount(caller)) === undefined) return 'Account does not exist!'
      if ((await n.getBalance(caller)) < amountSun) return 'No enough balance !'
      const tokenId = assetIdOf(n, value.asset_name, tx.visible === true)
      const meta = tokenId === undefined ? undefined : n.assets.byId(tokenId)
      if (meta === undefined) return `No asset named ${hexToUtf8Loose(value.asset_name)}`
      if (n.assetIssuedBy(issuer) !== meta) {
        return `The asset is not issued by ${toTronHex(issuer)}`
      }
      const now = n.head().timestampMs
      if (BigInt(now) >= meta.endTime || BigInt(now) < meta.startTime) {
        return 'No longer valid period!'
      }
      // the sun-to-token product must fit a signed 64-bit integer
      if (amountSun * BigInt(meta.num) > INT64_MAX) return 'long overflow'
      // the exchange rate multiplies before it divides; a purchase that rounds
      // to nothing is rejected
      if ((amountSun * BigInt(meta.num)) / BigInt(meta.trxNum) <= 0n) {
        return 'Can not process the exchange!'
      }
      if ((await n.getAccount(issuer)) === undefined) return 'To account does not exist!'
      if (
        (await n.getAssetBalance(issuer, meta.id)) <
        (amountSun * BigInt(meta.num)) / BigInt(meta.trxNum)
      ) {
        return 'Asset balance is not enough !'
      }
      return undefined
    },
    stateOp: async (n) => {
      const tokenId = assetIdOf(n, value.asset_name, tx.visible === true)
      const meta = n.assets.byId(tokenId as number)
      if (meta === undefined) {
        return { error: broadcastError('CONTRACT_VALIDATE_ERROR', 'No asset!') }
      }
      const tokens = (amountSun * BigInt(meta.num)) / BigInt(meta.trxNum)
      if ((await n.getBalance(issuer)) + amountSun > INT64_MAX) {
        return { error: broadcastError('CONTRACT_EXE_ERROR', 'long overflow') }
      }
      await n.moveBalance(caller, issuer, amountSun)
      await n.transferAsset(issuer, caller, meta.id, tokens)
      return { feeSun: 0n }
    },
  }
}

/** contract type → the adapter that turns it into a VM call */
const ADAPTERS: Readonly<Record<string, (ctx: AdaptContext) => AdaptResult>> = requestKeyed({
  TransferContract: adaptTransfer,
  TriggerSmartContract: adaptTriggerSmart,
  UpdateSettingContract: adaptClearABI,
  UpdateEnergyLimitContract: adaptClearABI,
  ClearABIContract: adaptClearABI,
  CreateSmartContract: adaptCreateSmart,
  AssetIssueContract: adaptAssetIssue,
  UnfreezeAssetContract: adaptUnfreezeAsset,
  AccountPermissionUpdateContract: adaptAccountPermissionUpdate,
  AccountUpdateContract: adaptAccountUpdate,
  SetAccountIdContract: adaptSetAccountId,
  AccountCreateContract: adaptAccountCreate,
  UpdateAssetContract: adaptUpdateAsset,
  TransferAssetContract: adaptTransferAsset,
  ParticipateAssetIssueContract: adaptParticipateAssetIssue,
  FreezeBalanceV2Contract: adaptFreezeBalanceV2,
  UnfreezeBalanceV2Contract: adaptUnfreezeBalanceV2,
  WithdrawExpireUnfreezeContract: adaptWithdrawExpireUnfreeze,
  CancelAllUnfreezeV2Contract: adaptCancelAllUnfreezeV2,
  DelegateResourceContract: adaptDelegateResource,
  UnDelegateResourceContract: adaptUnDelegateResource,
  FreezeBalanceContract: adaptFreezeBalance,
  UnfreezeBalanceContract: adaptUnfreezeBalance,
})

/** whether a contract type has an actuator here; the build entries share this judgement */
export function isAdaptedContractType(type: string): boolean {
  return ADAPTERS[type] !== undefined
}

function contractActivationError(node: NodeCore, type: string): string | undefined {
  const inactive = transactionActivationError(node.config.chainParameters, type)
  if (inactive !== undefined) return inactive
  if (
    type === 'AccountPermissionUpdateContract' &&
    node.config.chainParameters.allowMultiSign !== 1
  ) {
    return 'multi sign is not allowed, need to be opened by the committee'
  }
  if (
    type === 'UpdateEnergyLimitContract' &&
    node.blocks.height() < node.runtime.energyLimitActivationBlock
  ) {
    return 'contract type error, unexpected type [UpdateEnergyLimitContract]'
  }
  return undefined
}

/** Translate a TRON contract into a VM execution or a native state operation. */
export function adaptContract(
  node: NodeCore,
  contract: TronContractJSON,
  tx: SignedTronTx,
): AdaptResult {
  const adapt = ADAPTERS[contract.type]
  if (adapt === undefined) {
    return {
      error: broadcastError('CONTRACT_VALIDATE_ERROR', `${contract.type} is not implemented`),
    }
  }
  const activationError = contractActivationError(node, contract.type)
  if (activationError !== undefined) {
    return { error: broadcastError('CONTRACT_VALIDATE_ERROR', activationError) }
  }
  const value = contract.parameter?.value ?? {}
  const feeLimit = BigInt(tx.raw_data.fee_limit ?? DEFAULT_FEE_LIMIT_SUN)
  return adapt({
    node,
    contract,
    tx,
    value,
    caller: parseTronAddress(String(value.owner_address ?? '')),
    feeLimit,
    // a write buys exactly what its fee limit pays for; the constant-call cap
    // belongs to read-only calls, which never charge anyone
    energyLimit: feeLimit / BigInt(node.config.chainParameters.energyFee),
  })
}

/**
 * The address field each contract type checks first, and the wording it uses.
 * `UnfreezeAssetContract` says `Invalid address` where every other actuator
 * names the field.
 */
const ADDRESS_FIELDS: Record<string, [field: string, message: string][]> = requestKeyed({
  TransferContract: [
    ['owner_address', 'Invalid ownerAddress!'],
    ['to_address', 'Invalid toAddress!'],
  ],
  TransferAssetContract: [
    ['owner_address', 'Invalid ownerAddress'],
    ['to_address', 'Invalid toAddress'],
  ],
  ParticipateAssetIssueContract: [
    ['owner_address', 'Invalid ownerAddress'],
    ['to_address', 'Invalid toAddress'],
  ],
  AssetIssueContract: [['owner_address', 'Invalid ownerAddress']],
  UpdateAssetContract: [['owner_address', 'Invalid ownerAddress']],
  UnfreezeAssetContract: [['owner_address', 'Invalid address']],
  AccountUpdateContract: [['owner_address', 'Invalid ownerAddress']],
  SetAccountIdContract: [['owner_address', 'Invalid ownerAddress']],
  AccountCreateContract: [
    ['owner_address', 'Invalid ownerAddress'],
    ['account_address', 'Invalid account address'],
  ],
  AccountPermissionUpdateContract: [['owner_address', 'invalidate ownerAddress']],
  UpdateSettingContract: [['owner_address', 'Invalid address']],
  UpdateEnergyLimitContract: [['owner_address', 'Invalid address']],
  ClearABIContract: [['owner_address', 'Invalid address']],
  FreezeBalanceV2Contract: [['owner_address', 'Invalid address']],
  UnfreezeBalanceV2Contract: [['owner_address', 'Invalid address']],
  WithdrawExpireUnfreezeContract: [['owner_address', 'Invalid address']],
  CancelAllUnfreezeV2Contract: [['owner_address', 'Invalid address']],
  DelegateResourceContract: [['owner_address', 'Invalid address']],
  UnDelegateResourceContract: [['owner_address', 'Invalid address']],
  FreezeBalanceContract: [['owner_address', 'Invalid address']],
  UnfreezeBalanceContract: [['owner_address', 'Invalid address']],
})

export function addressFieldError(
  type: string,
  value: Record<string, unknown>,
): string | undefined {
  // the two account actuators judge the name they are handed before the
  // address; every other one starts with its addresses
  if (type === 'SetAccountIdContract' && !validAccountId(nameBytesOf(value.account_id, false))) {
    return 'Invalid accountId'
  }
  if (
    type === 'AccountUpdateContract' &&
    !validAccountName(nameBytesOf(value.account_name, false))
  ) {
    return 'Invalid accountName'
  }
  for (const [field, message] of ADDRESS_FIELDS[type] ?? []) {
    if (tryParseTronAddress(String(value[field] ?? '')) === undefined) return message
  }
  return undefined
}

/**
 * The build endpoints answer with a transaction only if that transaction could
 * be broadcast, so they run the same actuator checks the write path runs. The
 * VM families are excluded: their rules are evaluated against an execution
 * context that does not exist until the transaction is submitted.
 */
export async function validateForBuild(
  node: NodeCore,
  type: string,
  value: Record<string, unknown>,
): Promise<string | undefined> {
  if (type === 'CreateSmartContract' || type === 'TriggerSmartContract') return undefined
  const activationError = contractActivationError(node, type)
  if (activationError !== undefined) return activationError
  const stub = { txID: '', raw_data: { fee_limit: 0 } } as unknown as SignedTronTx
  let adapted: ReturnType<typeof adaptContract>
  try {
    adapted = adaptContract(node, { parameter: { value, type_url: '' }, type }, stub)
  } catch {
    // an address the adapter cannot parse is the actuator's first rejection,
    // and naming the field it belongs to is what tells the caller which one
    return addressFieldError(type, value)
  }
  if ('error' in adapted) return undefined
  const recipient =
    type === 'TransferAssetContract'
      ? tryParseTronAddress(String(value.to_address ?? ''))
      : undefined
  const createsAccount = recipient !== undefined && (await node.getAccount(recipient)) === undefined
  return adapted.validate?.(node, { createsAccount, building: true })
}

/**
 * The argument rules a call must satisfy before the VM is entered, in actuator
 * order. Shared with the constant-call path, which runs the same validation and
 * only differs in that its execution is discarded.
 */
export async function callArgumentError(
  node: NodeCore,
  caller: Address,
  params: HandlerParams,
): Promise<string | undefined> {
  const callValue = BigInt((params.call_value as string | number) ?? 0)
  const invalid = firstError(
    callValueRule(callValue),
    tokenValueRule({ call_token_value: params.call_token_value }),
    tokenValueAndIdRule({
      call_token_value: params.call_token_value,
      token_id: params.token_id,
    }),
  )
  if (invalid !== undefined) return invalid
  return callValueError(node, caller, callValue)
}
