import { TronWeb, utils } from 'tronweb'

import { parseInteger } from '../../../input.ts'
import { INT32_MAX, INT32_MIN } from '../../../intBounds.ts'
import {
  HexDecoderError,
  isHexText,
  isVisible,
  mergeAddressField,
  parseRequestAddress,
  toTronHex,
  tryParseTronAddress,
} from '../address.ts'
import { CONTRACT_TYPE } from '../contractTypes.ts'
import {
  MergeError,
  checkFieldName,
  checkMergeField,
  fieldPosition,
  fieldTokens,
  mergeInt64Field,
  skipUnknownField,
} from '../mergeValue.ts'
import {
  MERGE_ENUMS,
  MERGE_ENUM_NAMES,
  MESSAGE_FIELDS,
  MESSAGE_FIELD_TYPES,
  SELF_FORMAT_FIELDS,
} from '../mergedFields.ts'
import { DEFAULT_FEE_LIMIT_SUN } from '../params.ts'
import { parseHexField } from './chain.ts'
import { genDeployAddress, isAdaptedContractType, validateForBuild } from './contractAdapter.ts'
import { canEncodeLocally, transactionToPb } from './encode.ts'
import { canonicalMessage } from './pack.ts'
import { formatTransaction, printTransaction } from './print.ts'
import {
  JavaExceptionError,
  MAX_EXACT_INT,
  MergeParseError,
  longValue,
  servletError,
  triggerError,
  widestInt,
} from './types.ts'

import type { Address } from '@tvmjs/util'
import type { NodeCore } from '../../../core/node.ts'
import type { HandlerParams } from '../../registry.ts'
import type { TronContractJSON } from './types.ts'

const { txPbToTxID, txPbToRawDataHex } = utils.transaction

function permissionIdOf(params: HandlerParams): number | undefined {
  return params.Permission_id === undefined
    ? undefined
    : Number(
        parseInteger(params.Permission_id, 'Permission_id', { min: INT32_MIN, max: INT32_MAX }),
      )
}

/**
 * Server-side unsigned-tx builder shared by the create*-family endpoints:
 * raw_data with ref-block from the head, txID/raw_data_hex via the pb codec.
 */
function buildUnsignedTx(
  node: NodeCore,
  type: string,
  value: Record<string, unknown>,
  opts: { feeLimit?: bigint; permissionId?: number; visible?: boolean; data?: string } = {},
): { visible: boolean; txID: string; raw_data_hex: string; raw_data: Record<string, unknown> } {
  const head = node.head()
  const timestamp = node.clock.nowMs()
  const contractEntry: TronContractJSON = {
    parameter: { value, type_url: `type.googleapis.com/protocol.${type}` },
    type,
  }
  // the id is only carried when it names a permission other than the default
  if (opts.permissionId !== undefined && opts.permissionId > 0) {
    contractEntry.Permission_id = opts.permissionId
  }
  // proto field order: ref_block_bytes, ref_block_hash, expiration, data,
  // contract, timestamp, fee_limit
  const rawData: Record<string, unknown> = {
    ref_block_bytes: Number(head.number).toString(16).slice(-4).padStart(4, '0'),
    ref_block_hash: head.blockID.slice(16, 32),
    expiration: head.timestampMs + 60_000,
    ...(opts.data !== undefined && opts.data !== '' ? { data: opts.data } : {}),
    contract: [contractEntry],
    timestamp,
  }
  // a zero fee limit is the protobuf default and never printed
  if (opts.feeLimit !== undefined && opts.feeLimit !== 0n) {
    rawData.fee_limit = opts.feeLimit
  }
  // a type with an encoder of its own states an int64 whole; the rest are held
  // to what the bundled encoder states, since the id it hashes is what a
  // caller signs
  if (!canEncodeLocally(type)) {
    const tooWide = widestInt(rawData)
    if (tooWide !== undefined) {
      throw new JavaExceptionError(
        `${tooWide} is past ${MAX_EXACT_INT}, the widest this node signs for`,
      )
    }
  }
  const draft = { visible: false, txID: '', raw_data_hex: '', raw_data: rawData }
  // pb bytes are computed over the hex form; visible only affects the echo
  const pb = transactionToPb(draft as never)
  // raw_data prints first and `visible` is always stated, even when false
  const tx = printTransaction({
    raw_data: rawData,
    raw_data_hex: txPbToRawDataHex(pb).replace(/^0x/, '').toLowerCase(),
    txID: txPbToTxID(pb).replace(/^0x/, ''),
    visible: opts.visible === true,
  })
  return formatTransaction(tx, opts.visible === true)
}

/**
 * The memo `extra_data` carries: plain text under `visible`, hex otherwise.
 * It joins raw_data before the id is computed, so it is part of what is signed.
 */
function extraDataHex(params: HandlerParams, visible: boolean): string | undefined {
  const data = params.extra_data === undefined ? '' : String(params.extra_data)
  if (data === '') return undefined
  // without `visible` the memo arrives as hex and is decoded, so text that is
  // not hex never becomes a memo at all
  return visible ? TronWeb.fromUtf8(data).replace(/^0x/, '') : parseHexField(data)
}

/** Server-side transfer construction, including its optional memo. */
export const createTransaction = simpleBuilder('TransferContract', true)

// proto enum spellings for SmartContract.ABI.Entry — responses must be
// re-mergeable into protobuf, which rejects unknown fields and unknown enum
// values (solc emits lowercase names and extra keys like internalType)
const ABI_ENTRY_TYPES: Record<string, string> = {
  constructor: 'Constructor',
  function: 'Function',
  event: 'Event',
  fallback: 'Fallback',
  receive: 'Receive',
  error: 'Error',
}
const ABI_MUTABILITY: Record<string, string> = {
  pure: 'Pure',
  view: 'View',
  nonpayable: 'Nonpayable',
  payable: 'Payable',
}

function normalizeAbiParam(param: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: String(param.name ?? ''),
    type: String(param.type ?? ''),
  }
  if (param.indexed === true) out.indexed = true
  return out
}

function normalizeAbiEntry(raw: unknown): Record<string, unknown> {
  const entry = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (entry.anonymous === true) out.anonymous = true
  if (entry.constant === true) out.constant = true
  if (typeof entry.name === 'string') out.name = entry.name
  if (Array.isArray(entry.inputs)) {
    out.inputs = entry.inputs.map((p) => normalizeAbiParam(p as Record<string, unknown>))
  }
  if (Array.isArray(entry.outputs)) {
    out.outputs = entry.outputs.map((p) => normalizeAbiParam(p as Record<string, unknown>))
  }
  const type = ABI_ENTRY_TYPES[String(entry.type ?? '').toLowerCase()]
  if (type !== undefined) out.type = type
  if (entry.payable === true) out.payable = true
  const mutability = ABI_MUTABILITY[String(entry.stateMutability ?? '').toLowerCase()]
  if (mutability !== undefined) out.stateMutability = mutability
  return out
}

/** an address field that is hex but not a valid address, kept as its own bytes */
function bytesHexOf(value: unknown): string {
  const raw = String(value ?? '')
    .replace(/^0x/i, '')
    .toLowerCase()
  // an odd digit count is padded rather than refused
  return raw.length % 2 === 1 ? `0${raw}` : raw
}

/** server-side CreateSmartContract builder (deploycontract endpoint) */
export function deployContract(node: NodeCore, params: HandlerParams): unknown {
  const visible = isVisible(params)
  // this servlet decodes the address itself and hands the bytes straight to the
  // builder: an address of the wrong length still produces a transaction, and
  // only text the decoder cannot read stops it. A value stated as JSON null
  // reads back as no text, which decodes to empty bytes like an absent one
  const ownerText =
    params.owner_address === undefined || params.owner_address === null
      ? ''
      : String(params.owner_address)
  if (!visible && !isHexText(ownerText)) throw new HexDecoderError(ownerText)
  const owner = tryParseTronAddress(ownerText)
  // under `visible` the decoder yields nothing for text it cannot read, and
  // the contract is built around an owner of no bytes at all
  const ownerHex = owner !== undefined ? toTronHex(owner) : visible ? '' : bytesHexOf(ownerText)
  // bytecode and its trailing constructor arguments are hex bytes, decoded
  // before anything else looks at them
  // the abi is spliced into `{"entrys":<abi>}` and merged, and it is read
  // before the byte code is — a value that is not itself JSON fails at the
  // position that splice puts it in
  let abiEntrys: unknown[] = []
  if (params.abi !== undefined) {
    const text = typeof params.abi === 'string' ? params.abi : JSON.stringify(params.abi)
    let parsed: unknown
    try {
      parsed = JSON.parse(text ?? '')
    } catch {
      throw new MergeParseError('1:11: Expected "{".')
    }
    if (Array.isArray(parsed)) abiEntrys = parsed
    else throw new MergeParseError('1:22: Expected string.')
  }
  const bytecode = parseHexField(params.bytecode)
  const parameter = parseHexField(params.parameter)
  // proto field order: origin_address, abi, bytecode, call_value,
  // consume_user_resource_percent, name, origin_energy_limit
  const percent = Number(longValue(params, 'consume_user_resource_percent'))
  const originEnergyLimit = longValue(params, 'origin_energy_limit')
  const callValue = longValue(params, 'call_value')
  if (percent < 0 || percent > 100) {
    return servletError('percent must be >= 0 and <= 100')
  }
  const newContract: Record<string, unknown> = {
    origin_address: ownerHex,
    // the abi is a message field, so an empty one is still set and still prints
    abi: { entrys: abiEntrys.map((entry) => normalizeAbiEntry(entry)) },
    bytecode: `${bytecode}${parameter}`,
    ...(callValue !== 0n ? { call_value: callValue } : {}),
    ...(percent !== 0 ? { consume_user_resource_percent: percent } : {}),
    ...(params.name !== undefined && String(params.name) !== ''
      ? { name: String(params.name) }
      : {}),
    ...(originEnergyLimit !== 0n ? { origin_energy_limit: originEnergyLimit } : {}),
  }
  const value: Record<string, unknown> = {
    owner_address: ownerHex,
    new_contract: newContract,
  }
  if (params.token_id !== undefined) value.token_id = longValue(params, 'token_id')
  if (params.call_token_value !== undefined) {
    value.call_token_value = longValue(params, 'call_token_value')
  }
  const tx = buildUnsignedTx(node, 'CreateSmartContract', value, {
    ...(params.fee_limit === undefined ? {} : { feeLimit: longValue(params, 'fee_limit') }),
    permissionId: permissionIdOf(params),
    visible,
  }) as Record<string, unknown>
  // the address the deploy will claim, alongside the transaction
  const deployed = genDeployAddress(ownerHex, String(tx.txID ?? ''))
  // the servlet appends this after printing the message, so it stays hex
  // however the request asked for addresses
  return printTransaction({ ...tx, contract_address: toTronHex(deployed) })
}

/** build the unsigned TriggerSmartContract tx, bit-compatible with client-side local building */
export async function triggerSmartContract(
  node: NodeCore,
  params: HandlerParams,
  opts: { includeExtraData?: boolean } = {},
): Promise<unknown> {
  const visible = isVisible(params)
  // presence is read as text, so a field of any JSON type counts as set
  const stated = (value: unknown): boolean =>
    value !== undefined && value !== null && String(value) !== ''
  const missing = !stated(params.owner_address)
    ? 'owner_address'
    : !stated(params.contract_address)
      ? 'contract_address'
      : undefined
  if (missing !== undefined) {
    return triggerError(`${missing} isn't set.`, 'OTHER_ERROR', visible)
  }
  // the body is merged only once those two are known to be there, so a field
  // of the wrong type is reported after them rather than before
  const merge = mergeFieldError('TriggerSmartContract', params)
  if (merge !== undefined) {
    // this family reports through a message field that carries no quotes
    return triggerError(String(merge.Error ?? '').replace(/"/g, "'"), 'OTHER_ERROR', visible)
  }
  let owner: Address
  let to: Address | undefined
  try {
    // the contract address is merged as bytes and looked up before the owner is
    // read: a call on something that is not a contract is turned away first
    mergeAddressField(params, 'contract_address', 'protocol.TriggerSmartContract.contract_address')
    to = tryParseTronAddress(String(params.contract_address ?? ''))
  } catch (err) {
    return triggerError((err as Error).message, 'OTHER_ERROR', visible)
  }
  if (to === undefined || node.getContractMeta(to) === undefined) {
    return triggerError('No contract or not a valid smart contract', undefined, visible)
  }
  try {
    owner = parseRequestAddress(String(params.owner_address ?? ''), visible)
  } catch (err) {
    return triggerError((err as Error).message, 'OTHER_ERROR', visible)
  }

  try {
    const selector =
      typeof params.function_selector === 'string' && params.function_selector !== ''
        ? TronWeb.sha3(params.function_selector, false).slice(0, 8)
        : ''
    const parameter =
      typeof params.parameter === 'string' ? params.parameter.replace(/^0x/i, '') : ''
    // when both are given the selector wins: it is the higher-level statement of
    // what to call, and data is only the fallback encoding
    const data =
      selector !== ''
        ? `${selector}${parameter}`
        : typeof params.data === 'string'
          ? params.data.replace(/^0x/i, '')
          : ''

    const value: Record<string, unknown> = {
      data,
      owner_address: toTronHex(owner),
      contract_address: toTronHex(to),
    }
    // proto3 scalars at their default are not part of the printed message
    for (const key of ['call_value', 'token_id', 'call_token_value'] as const) {
      const given = longValue(params, key)
      if (given !== 0n) value[key] = given
    }

    const tx = buildUnsignedTx(node, 'TriggerSmartContract', value, {
      feeLimit:
        params.fee_limit === undefined
          ? BigInt(DEFAULT_FEE_LIMIT_SUN)
          : longValue(params, 'fee_limit'),
      permissionId: permissionIdOf(params),
      visible,
      // The normal trigger servlet leaves this field alone. The constant-call
      // response adds it after creating the simulated TriggerSmartContract.
      data: opts.includeExtraData === true ? extraDataHex(params, visible) : undefined,
    })

    // TransactionExtention leads with the transaction, and the servlet puts it
    // back in that place after printing
    return { transaction: tx, result: { result: true } }
  } catch (err) {
    if (
      !(
        err instanceof TypeError ||
        err instanceof RangeError ||
        err instanceof MergeError ||
        err instanceof HexDecoderError ||
        err instanceof JavaExceptionError
      )
    )
      throw err
    return triggerError(err.message.replace(/"/g, "'"), 'OTHER_ERROR', visible)
  }
}

export const createAssetIssue = simpleBuilder('AssetIssueContract')
export const unfreezeAsset = simpleBuilder('UnfreezeAssetContract')
export const accountPermissionUpdate = simpleBuilder('AccountPermissionUpdateContract')

/** The asset transfer servlet accepts a memo; participation does not. */
export async function buildAssetTransferTx(
  node: NodeCore,
  type: 'TransferAssetContract' | 'ParticipateAssetIssueContract',
  params: HandlerParams,
): Promise<unknown> {
  return buildTransaction(node, type, params, type === 'TransferAssetContract')
}

/**
 * An address field is read by the protobuf merge before any actuator sees it,
 * and the merge only knows how to decode one form: hex bytes, or base58 under
 * `visible`. A value in neither form fails there, naming the column it starts
 * at; a well-formed value of the wrong length gets through and is judged by the
 * actuator instead.
 */
export function mergeFieldError(
  type: string,
  params: HandlerParams,
): Record<string, unknown> | undefined {
  const visible = isVisible(params)
  const declared = MESSAGE_FIELDS[type] ?? {}
  // the merge walks the body, so the first offending value in the text is the
  // one reported — not the first in proto order
  const walked = Object.keys(params)
    .filter((field) => field !== 'visible')
    .map((field) => ({ field, at: fieldPosition(params, field) }))
    .sort((a, b) => a.at.line - b.at.line || a.at.column - b.at.column)
  try {
    for (const { field } of walked) {
      // the name is read before the value it names
      checkFieldName(params, field)
      if (field === 'Permission_id') {
        permissionIdOf(params)
        continue
      }
      const kind = declared[field]
      if (kind === undefined) {
        // a name the message does not declare is stepped over, and the step
        // has a grammar of its own
        skipUnknownField(params, field)
        continue
      }
      for (const token of fieldTokens(params, field)) {
        checkMergeField(token, kind, {
          enums: MERGE_ENUMS,
          enumNames: MERGE_ENUM_NAMES,
          visible,
          selfFormat: SELF_FORMAT_FIELDS[type]?.[field],
          fieldName: `protocol.${type}.${field}`,
          messageFields: MESSAGE_FIELDS,
          messageFieldTypes: MESSAGE_FIELD_TYPES,
          messageSelfFormats: SELF_FORMAT_FIELDS,
          nestedMessage: MESSAGE_FIELD_TYPES[type]?.[field],
        })
      }
    }
  } catch (err) {
    if (err instanceof MergeError || err instanceof TypeError || err instanceof RangeError) {
      return servletError(err.message)
    }
    throw err
  }
  return undefined
}

/** Decode the checked request into the protobuf representation used by validation and signing. */
function contractValue(type: string, params: HandlerParams): Record<string, unknown> {
  const value = { ...params }
  for (const [field, kind] of Object.entries(MESSAGE_FIELDS[type] ?? {})) {
    if (kind === 'int64' && params[field] !== undefined) {
      value[field] = mergeInt64Field(params, field)
    }
  }
  return canonicalMessage(value, type, isVisible(params)) as Record<string, unknown>
}

async function buildTransaction(
  node: NodeCore,
  type: string,
  params: HandlerParams,
  includesMemo = false,
): Promise<unknown> {
  const malformed = mergeFieldError(type, params)
  if (malformed !== undefined) return malformed
  const value = contractValue(type, params)
  const invalid = await validateForBuild(node, type, value)
  if (invalid !== undefined) return servletError(invalid)
  const visible = isVisible(params)
  return buildUnsignedTx(node, type, value, {
    permissionId: permissionIdOf(params),
    visible,
    data: includesMemo ? extraDataHex(params, visible) : undefined,
  })
}

/** Route-specific builders share decoding, actuator validation and transaction options. */
function simpleBuilder(
  type: string,
  includesMemo = false,
): (node: NodeCore, params: HandlerParams) => Promise<unknown> {
  return (node, params) => buildTransaction(node, type, params, includesMemo)
}

export const updateSetting = simpleBuilder('UpdateSettingContract')
export const updateEnergyLimit = simpleBuilder('UpdateEnergyLimitContract')
export const clearAbi = simpleBuilder('ClearABIContract')
export const updateAsset = simpleBuilder('UpdateAssetContract')
export const updateAccount = simpleBuilder('AccountUpdateContract')
export const setAccountId = simpleBuilder('SetAccountIdContract')
export const createAccount = simpleBuilder('AccountCreateContract')
export const freezeBalanceV2 = simpleBuilder('FreezeBalanceV2Contract')
export const unfreezeBalanceV2 = simpleBuilder('UnfreezeBalanceV2Contract')
export const withdrawExpireUnfreeze = simpleBuilder('WithdrawExpireUnfreezeContract')
export const cancelAllUnfreezeV2 = simpleBuilder('CancelAllUnfreezeV2Contract')
export const delegateResource = simpleBuilder('DelegateResourceContract')
export const unDelegateResource = simpleBuilder('UnDelegateResourceContract')
export const freezeBalance = simpleBuilder('FreezeBalanceContract')
export const unfreezeBalance = simpleBuilder('UnfreezeBalanceContract')

/**
 * Build a transaction of whatever type the body names. The contract type comes
 * from the request rather than the path, so one endpoint covers every builder
 * — the same actuator checks still run.
 */
export async function createCommonTransaction(
  node: NodeCore,
  params: HandlerParams,
): Promise<unknown> {
  const type = String(params.contractType ?? '')
  if (type === '') {
    return servletError('Name is null')
  }
  if (!KNOWN_CONTRACT_TYPES.has(type)) {
    return servletError(
      `No enum constant org.tron.protos.Protocol.Transaction.Contract.ContractType.${type}`,
    )
  }
  // the generic entry is not a way around a route that answers 501
  if (!isAdaptedContractType(type)) {
    return servletError(`${type} is not implemented`)
  }
  return buildTransaction(node, type, params)
}

/** every contract type name the protocol defines */
const KNOWN_CONTRACT_TYPES: ReadonlySet<string> = new Set(Object.keys(CONTRACT_TYPE))
