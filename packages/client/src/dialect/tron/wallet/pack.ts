import { TronWeb } from 'tronweb'

import { bytesToHex } from '@tvmjs/util'
import { parseBytes, parseInteger } from '../../../input.ts'
import { INT32_MAX, INT32_MIN } from '../../../intBounds.ts'
import { parseTronAddress, toTronHex } from '../address.ts'
import {
  checkMergeField,
  parseMergeEnum,
  parseMergeInt32,
  parseMergeInt64,
  syntheticToken,
} from '../mergeValue.ts'
import {
  MERGE_ENUMS,
  MERGE_ENUM_NAMES,
  MESSAGE_FIELDS,
  MESSAGE_FIELD_TYPES,
  SELF_FORMAT_FIELDS,
} from '../mergedFields.ts'

import type { SignedTronTx, TronContractJSON } from './types.ts'
import { MAX_EXACT_INT, TransactionEncodingError } from './types.ts'

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)

function canonicalInteger(value: unknown, kind: string, field: string): number | bigint {
  const token = syntheticToken(field, value)
  const integer = kind === 'int32' ? parseMergeInt32(token) : parseMergeInt64(token)
  return integer >= -MAX_SAFE_INTEGER && integer <= MAX_SAFE_INTEGER ? Number(integer) : integer
}

function canonicalBytes(
  value: unknown,
  visible: boolean,
  format: 'address' | 'name' | undefined,
): string {
  const text = String(value)
  if (visible && format === 'address') return toTronHex(parseTronAddress(text))
  if (visible && format === 'name') return TronWeb.fromUtf8(text).replace(/^0x/, '')
  const hex = text.replace(/^0x/i, '')
  return (hex.length % 2 === 0 ? hex : `0${hex}`).toLowerCase()
}

function canonicalEnum(value: unknown, kind: string, field: string): string {
  const name = kind.slice('enum:'.length)
  const number = parseMergeEnum(
    syntheticToken(field, value),
    MERGE_ENUM_NAMES[name] ?? name,
    MERGE_ENUMS[name] ?? {},
  )
  return (
    Object.entries(MERGE_ENUMS[name] ?? {}).find(([, candidate]) => candidate === number)?.[0] ??
    String(number)
  )
}

export function canonicalMessage(value: unknown, message: string, visible: boolean): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const fields = MESSAGE_FIELDS[message]
  // Some nested messages (notably ABI) are encoded by their own protobuf helper.
  // Their enclosing message is still canonicalized, so unknown siblings cannot leak through.
  if (fields === undefined) return structuredClone(value)
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [field, kind] of Object.entries(fields)) {
    const stated = source[field]
    if (stated === undefined || stated === null) {
      if (kind === 'bytes') result[field] = ''
      continue
    }
    const repeated = kind.endsWith('[]')
    const base = repeated ? kind.slice(0, -2) : kind
    const canonical = (entry: unknown): unknown => {
      if (base === 'bytes') {
        return canonicalBytes(entry, visible, SELF_FORMAT_FIELDS[message]?.[field])
      }
      if (base === 'int32' || base === 'int64') return canonicalInteger(entry, base, field)
      if (base.startsWith('enum:')) return canonicalEnum(entry, base, field)
      if (base === 'message') {
        const nested = MESSAGE_FIELD_TYPES[message]?.[field]
        return nested === undefined
          ? structuredClone(entry)
          : canonicalMessage(entry, nested, visible)
      }
      return entry
    }
    result[field] = repeated
      ? (Array.isArray(stated) ? stated : [stated]).map(canonical)
      : canonical(stated)
  }
  return result
}

function canonicalContract(entry: unknown, visible: boolean): TronContractJSON | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const source = entry as Record<string, unknown>
  const type = typeof source.type === 'string' ? source.type : ''
  if (!PACKABLE_CONTRACT_TYPES.has(type) || MESSAGE_FIELDS[type] === undefined) return undefined
  const parameter = source.parameter as Record<string, unknown> | undefined
  const value = parameter?.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  for (const [field, held] of Object.entries(value)) {
    const kind = MESSAGE_FIELDS[type][field]
    if (kind === undefined) continue
    const entries = kind.endsWith('[]') ? (Array.isArray(held) ? held : [held]) : [held]
    for (const item of entries) {
      try {
        checkMergeField(syntheticToken(field, item), kind, {
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
      } catch {
        return undefined
      }
    }
  }
  const packed: TronContractJSON & Record<string, unknown> = {
    type,
    parameter: {
      // Transaction.Contract.parameter is rebuilt from the declared contract type.
      // A stated Any URL is not an independent execution input.
      type_url: `type.googleapis.com/protocol.${type}`,
      value: canonicalMessage(value, type, visible) as Record<string, unknown>,
    },
  }
  if (source.Permission_id !== undefined) {
    packed.Permission_id = Number(
      parseInteger(source.Permission_id, 'Permission_id', { min: INT32_MIN, max: INT32_MAX }),
    )
  }
  for (const field of ['provider', 'ContractName'] as const) {
    if (source[field] !== undefined && source[field] !== null) {
      packed[field] = canonicalBytes(source[field], visible, undefined)
    }
  }
  return packed
}

/**
 * Util.packTransaction retains a contract only when TransactionFactory holds
 * its protobuf class. The factory receives that set from the concrete actuator
 * constructors at boot, plus the two smart-contract types registered
 * statically. MESSAGE_FIELDS is the wider table: a message such as the retired
 * VoteAssetContract stays in the schema with no actuator behind it, and so
 * never becomes a packable contract.
 */
export const PACKABLE_CONTRACT_TYPES: ReadonlySet<string> = new Set([
  'AccountCreateContract',
  'AccountPermissionUpdateContract',
  'AccountUpdateContract',
  'AssetIssueContract',
  'CancelAllUnfreezeV2Contract',
  'ClearABIContract',
  'CreateSmartContract',
  'DelegateResourceContract',
  'ExchangeCreateContract',
  'ExchangeInjectContract',
  'ExchangeTransactionContract',
  'ExchangeWithdrawContract',
  'FreezeBalanceContract',
  'FreezeBalanceV2Contract',
  'MarketCancelOrderContract',
  'MarketSellAssetContract',
  'ParticipateAssetIssueContract',
  'ProposalApproveContract',
  'ProposalCreateContract',
  'ProposalDeleteContract',
  'SetAccountIdContract',
  'ShieldedTransferContract',
  'TransferAssetContract',
  'TransferContract',
  'TriggerSmartContract',
  'UnDelegateResourceContract',
  'UnfreezeAssetContract',
  'UnfreezeBalanceContract',
  'UnfreezeBalanceV2Contract',
  'UpdateAssetContract',
  'UpdateBrokerageContract',
  'UpdateEnergyLimitContract',
  'UpdateSettingContract',
  'VoteWitnessContract',
  'WithdrawBalanceContract',
  'WithdrawExpireUnfreezeContract',
  'WitnessCreateContract',
  'WitnessUpdateContract',
])

/**
 * Pack JSON contracts before broadcast or inspection. Unknown value fields
 * are skipped; invalid known values drop that contract. Invalid outer contract
 * fields reject the transaction, matching Util.packTransaction's final merge.
 */
export function packContracts(tx: SignedTronTx, visible: boolean): void {
  const contracts = (tx.raw_data as { contract?: unknown } | undefined)?.contract
  if (!Array.isArray(contracts)) return
  tx.raw_data.contract = contracts
    .map((entry) => canonicalContract(entry, visible))
    .filter((entry): entry is TronContractJSON => entry !== undefined)
}

/** Every raw-data envelope uses the generated number-based protobuf setters. */
export function packEnvelope(tx: SignedTronTx, visible = false): void {
  const source = tx.raw_data
  const raw: Record<string, unknown> = { contract: source.contract }
  try {
    for (const field of ['ref_block_num', 'expiration', 'timestamp', 'fee_limit'] as const) {
      const value = source[field]
      if (value === undefined || value === null) continue
      raw[field] = Number(
        parseInteger(value, `raw_data.${field}`, {
          min: -MAX_EXACT_INT,
          max: MAX_EXACT_INT,
        }),
      )
    }
    for (const field of ['ref_block_bytes', 'ref_block_hash', 'data', 'scripts'] as const) {
      const value = source[field]
      if (value !== undefined && value !== null) {
        raw[field] = bytesToHex(parseBytes(value, `raw_data.${field}`)).slice(2)
      }
    }
    const bytesMessage = (
      value: unknown,
      fields: Record<string, 'name' | 'address'>,
    ): Record<string, unknown> => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('transaction authority must be an object')
      }
      const message: Record<string, unknown> = {}
      for (const [field, format] of Object.entries(fields)) {
        const entry = (value as Record<string, unknown>)[field]
        if (entry === undefined || entry === null) continue
        if (visible && typeof entry !== 'string') {
          throw new TypeError(`transaction authority ${field} must be a string`)
        }
        message[field] =
          entry === ''
            ? ''
            : visible
              ? canonicalBytes(entry, true, format)
              : bytesToHex(parseBytes(entry, field)).slice(2)
      }
      return message
    }
    if (source.auths !== undefined && source.auths !== null) {
      const auths = Array.isArray(source.auths) ? source.auths : [source.auths]
      raw.auths = auths.map((entry) => {
        const authority = bytesMessage(entry, { permission_name: 'name' })
        if (entry.account !== undefined && entry.account !== null) {
          authority.account = bytesMessage(entry.account, { name: 'name', address: 'address' })
        }
        return authority
      })
    }
  } catch (error) {
    throw new TransactionEncodingError((error as Error).message)
  }
  tx.raw_data = raw as SignedTronTx['raw_data']
}

/** One owned transaction supplies encoding, signature inspection and the stored echo. */
export function packTransaction(tx: SignedTronTx, visible: boolean): void {
  packContracts(tx, visible)
  packEnvelope(tx, visible)
}
