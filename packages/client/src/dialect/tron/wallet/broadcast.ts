import { bytesToHex, hexToBytes } from '@tvmjs/util'
import { utils } from 'tronweb'

import { boolParam, parseTronAddress, toBase58, toTronHex } from '../address.ts'
import { CONTRACT_TYPE } from '../contractTypes.ts'
import { MAX_RESULT_SIZE_IN_TX } from '../params.ts'
import { checkSignatureWeight } from '../permission.ts'
import { hexToUtf8Loose } from './asset.ts'
import {
  accountPermissionUpdate,
  buildAssetTransferTx,
  cancelAllUnfreezeV2,
  clearAbi,
  createAccount,
  createAssetIssue,
  createCommonTransaction,
  createTransaction,
  delegateResource,
  deployContract,
  freezeBalance,
  freezeBalanceV2,
  setAccountId,
  unDelegateResource,
  unfreezeAsset,
  unfreezeBalance,
  unfreezeBalanceV2,
  updateAccount,
  updateAsset,
  updateEnergyLimit,
  updateSetting,
  withdrawExpireUnfreeze,
} from './builders.ts'
import { adaptContract, assetIdOf } from './contractAdapter.ts'

import type { AssetMeta } from '../../../core/assets.ts'
import type { AdaptedContract } from './contractAdapter.ts'
import {
  bindRawData,
  canEncodeLocally,
  hasBoundRawData,
  transactionId,
  transactionToPb,
} from './encode.ts'
import { packEnvelope, packTransaction } from './pack.ts'
import { printTransaction } from './print.ts'
import { buildInternalTransactions, buildTransactionInfo, contractRetOf } from './receipt.ts'
import {
  HexDecodeError,
  JavaExceptionError,
  MAX_EXACT_INT,
  ProtobufParseError,
  TransactionEncodingError,
  broadcastError,
  widestInt,
} from './types.ts'

import type { ExecResult } from '@tvmjs/tvm'
import type { Address } from '@tvmjs/util'
import type { TronTxRecord } from '../../../core/blockStore.ts'
import { DuplicateTransactionError, TransactionRejectedError } from '../../../core/mining.ts'
import type { PendingTransaction } from '../../../core/mining.ts'
import type { NodeCore, WriteParams, WriteResult } from '../../../core/node.ts'
import type { HandlerParams, Registry } from '../../registry.ts'
import type { SignedTronTx, TransactionAuthority } from './types.ts'

const { deserializeTransaction } = utils.deserializeTx

/** the contract type as its enum name, which is how a printer states it */
function contractTypeName(value: number): string {
  const found = Object.entries(CONTRACT_TYPE).find(([, number]) => number === value)
  return found === undefined ? String(value) : found[0]
}

/** the protobuf message classes the client library publishes on the global object */
interface AuthorityProto {
  getPermissionName_asU8(): Uint8Array
  getAccount(): { getName_asU8(): Uint8Array; getAddress_asU8(): Uint8Array } | undefined
}

interface TransactionProto {
  Result: {
    new (): { setContractret(value: number): void }
    contractResult: Record<string, number>
  }
  deserializeBinary(bytes: Uint8Array): {
    getRawData(): {
      serializeBinary(): Uint8Array
      getRefBlockBytes_asU8(): Uint8Array
      getRefBlockNum(): number
      getRefBlockHash_asU8(): Uint8Array
      getExpiration(): number
      getData_asU8(): Uint8Array
      getTimestamp(): number
      getFeeLimit(): number
      getScripts_asU8(): Uint8Array
      getAuthsList(): AuthorityProto[]
      clearAuthsList(): void
      getContractList(): {
        getType(): number
        getPermissionId(): number
        getProvider_asU8(): Uint8Array
        getContractname_asU8(): Uint8Array
        getParameter(): { getTypeUrl(): string; getValue_asU8(): Uint8Array }
      }[]
    }
    getSignatureList_asU8(): Uint8Array[]
  }
}

/** bytes fields the deserializer hands back upper-case; the wire carries lower */
const HEX_FIELDS = new Set([
  'owner_address',
  'to_address',
  'contract_address',
  'receiver_address',
  'account_address',
  'asset_name',
  'data',
  'bytecode',
])

function lowerHexFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerHexFields)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      HEX_FIELDS.has(key) && typeof entry === 'string' ? entry.toLowerCase() : lowerHexFields(entry)
  }
  return out
}

type ProtobufValue = bigint | Uint8Array

function protobufFields(bytes: Uint8Array): Map<number, ProtobufValue[]> {
  const fields = new Map<number, ProtobufValue[]>()
  let at = 0
  const varint = (): bigint => {
    let value = 0n
    let shift = 0n
    for (;;) {
      if (at >= bytes.length) throw new Error('truncated protobuf')
      const byte = bytes[at++]
      value |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value
      shift += 7n
      if (shift > 63n) throw new Error('invalid protobuf varint')
    }
  }
  while (at < bytes.length) {
    const key = varint()
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    let value: ProtobufValue
    if (wire === 0) value = varint()
    else if (wire === 2) {
      const length = Number(varint())
      if (!Number.isSafeInteger(length) || at + length > bytes.length)
        throw new Error('truncated protobuf')
      value = bytes.slice(at, (at += length))
    } else if (wire === 1) {
      if (at + 8 > bytes.length) throw new Error('truncated protobuf')
      value = bytes.slice(at, (at += 8))
    } else if (wire === 5) {
      if (at + 4 > bytes.length) throw new Error('truncated protobuf')
      value = bytes.slice(at, (at += 4))
    } else {
      throw new Error('unsupported protobuf wire type')
    }
    const stated = fields.get(field)
    if (stated === undefined) fields.set(field, [value])
    else stated.push(value)
  }
  return fields
}

function protobufInteger(value: bigint): number | bigint {
  const integer = BigInt.asIntN(64, value)
  return integer >= -BigInt(Number.MAX_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(integer)
    : integer
}

function stateInteger(
  value: Record<string, unknown>,
  key: string,
  field: ProtobufValue | undefined,
): void {
  if (typeof field !== 'bigint') return
  const integer = protobufInteger(field)
  if (integer !== 0 && integer !== 0n) value[key] = integer
}

function stateBytes(
  value: Record<string, unknown>,
  key: string,
  field: ProtobufValue | undefined,
): void {
  if (field instanceof Uint8Array && field.length > 0) value[key] = bytesToHex(field).slice(2)
}

/** Decode every AssetIssue field without narrowing signed int64 values through number. */
function assetIssueValue(bytes: Uint8Array): Record<string, unknown> {
  const fields = protobufFields(bytes)
  const last = (field: number): ProtobufValue | undefined => fields.get(field)?.at(-1)
  const frozen = (fields.get(5) ?? []).map((entry) => {
    const values = entry instanceof Uint8Array ? protobufFields(entry) : new Map()
    const tranche: Record<string, unknown> = {}
    stateInteger(tranche, 'frozen_amount', values.get(1)?.at(-1))
    stateInteger(tranche, 'frozen_days', values.get(2)?.at(-1))
    return tranche
  })
  const value: Record<string, unknown> = {}
  stateBytes(value, 'owner_address', last(1))
  stateBytes(value, 'name', last(2))
  stateBytes(value, 'abbr', last(3))
  stateInteger(value, 'total_supply', last(4))
  if (frozen.length > 0) value.frozen_supply = frozen
  stateInteger(value, 'trx_num', last(6))
  stateInteger(value, 'precision', last(7))
  stateInteger(value, 'num', last(8))
  stateInteger(value, 'start_time', last(9))
  stateInteger(value, 'end_time', last(10))
  stateInteger(value, 'order', last(11))
  stateInteger(value, 'vote_score', last(16))
  stateBytes(value, 'description', last(20))
  stateBytes(value, 'url', last(21))
  stateInteger(value, 'free_asset_net_limit', last(22))
  stateInteger(value, 'public_free_asset_net_limit', last(23))
  stateInteger(value, 'public_free_asset_net_usage', last(24))
  stateInteger(value, 'public_latest_free_net_time', last(25))
  const id = last(41)
  if (id instanceof Uint8Array && id.length > 0) value.id = new TextDecoder().decode(id)
  return value
}

function unfreezeAssetValue(bytes: Uint8Array): Record<string, unknown> {
  const value: Record<string, unknown> = {}
  stateBytes(value, 'owner_address', protobufFields(bytes).get(1)?.at(-1))
  return value
}

type ContractDecoder = {
  deserializeBinary(bytes: Uint8Array): { getResource?: () => number; getType?: () => number }
}

function decodedContractField(
  type: string,
  bytes: Uint8Array,
  getter: 'getResource' | 'getType',
): number | undefined {
  const decoder = (globalThis as unknown as { TronWebProto?: Record<string, ContractDecoder> })
    .TronWebProto?.[type]
  const value = decoder?.deserializeBinary(bytes)[getter]?.()
  return typeof value === 'number' ? value : undefined
}

function resourceName(value: number): 'BANDWIDTH' | 'ENERGY' | 'TRON_POWER' {
  return value === 1 ? 'ENERGY' : value === 2 ? 'TRON_POWER' : 'BANDWIDTH'
}

function smartContractVersion(bytes: Uint8Array): number | undefined {
  const decoder = (
    globalThis as unknown as {
      TronWebProto?: {
        CreateSmartContract?: {
          deserializeBinary(bytes: Uint8Array): { getNewContract(): { getVersion(): number } }
        }
      }
    }
  ).TronWebProto?.CreateSmartContract
  const value = decoder?.deserializeBinary(bytes).getNewContract().getVersion()
  return typeof value === 'number' ? value : undefined
}

function authorityJSON(entry: AuthorityProto): TransactionAuthority {
  const result: TransactionAuthority = {}
  const permissionName = entry.getPermissionName_asU8()
  if (permissionName.length > 0) result.permission_name = bytesToHex(permissionName).slice(2)
  const account = entry.getAccount()
  if (account !== undefined) {
    result.account = {}
    const name = account.getName_asU8()
    const address = account.getAddress_asU8()
    if (name.length > 0) result.account.name = bytesToHex(name).slice(2)
    if (address.length > 0) result.account.address = bytesToHex(address).slice(2)
  }
  return result
}

/**
 * A protobuf-encoded Transaction as a protobuf printer states it: field order
 * by number, an `Any` left packed as its own bytes, defaults omitted. The
 * contract type comes from the `Any` type_url, so no enum table is needed.
 */
function protobufTransactionJSON(hex: string): Record<string, unknown> {
  const proto = (globalThis as unknown as { TronWebProto?: { Transaction?: TransactionProto } })
    .TronWebProto?.Transaction
  if (proto === undefined) return {}
  const decoded = proto.deserializeBinary(hexToBytes(`0x${hex}`))
  const rawPb = decoded.getRawData()
  const raw: Record<string, unknown> = {}
  const bytesField = (value: Uint8Array): string => bytesToHex(value).slice(2)
  const refBlockBytes = rawPb.getRefBlockBytes_asU8()
  if (refBlockBytes.length > 0) raw.ref_block_bytes = bytesField(refBlockBytes)
  const refBlockHash = rawPb.getRefBlockHash_asU8()
  if (refBlockHash.length > 0) raw.ref_block_hash = bytesField(refBlockHash)
  if (rawPb.getRefBlockNum() !== 0) raw.ref_block_num = rawPb.getRefBlockNum()
  if (rawPb.getExpiration() !== 0) raw.expiration = rawPb.getExpiration()
  const auths = rawPb.getAuthsList()
  if (auths.length > 0) {
    raw.auths = auths.map(authorityJSON)
  }
  const data = rawPb.getData_asU8()
  if (data.length > 0) raw.data = bytesField(data)
  raw.contract = rawPb.getContractList().map((entry) => {
    const parameter = entry.getParameter()
    const out: Record<string, unknown> = {
      type: contractTypeName(entry.getType()),
      parameter: {
        type_url: parameter.getTypeUrl(),
        value: bytesField(parameter.getValue_asU8()),
      },
    }
    const provider = entry.getProvider_asU8()
    if (provider.length > 0) out.provider = bytesField(provider)
    const contractName = entry.getContractname_asU8()
    if (contractName.length > 0) out.ContractName = bytesField(contractName)
    if (entry.getPermissionId() > 0) out.Permission_id = entry.getPermissionId()
    return out
  })
  const scripts = rawPb.getScripts_asU8()
  if (scripts.length > 0) raw.scripts = bytesField(scripts)
  if (rawPb.getTimestamp() !== 0) raw.timestamp = rawPb.getTimestamp()
  if (rawPb.getFeeLimit() !== 0) raw.fee_limit = rawPb.getFeeLimit()
  const signatures = decoded.getSignatureList_asU8().map((entry) => bytesField(entry))
  return {
    raw_data: raw,
    ...(signatures.length > 0 ? { signature: signatures } : {}),
  }
}

function decodeHexTransaction(hex: string): SignedTronTx {
  const proto = (globalThis as unknown as { TronWebProto?: { Transaction?: TransactionProto } })
    .TronWebProto?.Transaction
  if (proto === undefined) {
    throw new Error('transaction protobuf definitions are unavailable')
  }
  const decoded = proto.deserializeBinary(hexToBytes(`0x${hex}`))
  const rawPb = decoded.getRawData()
  const rawBytes = rawPb.serializeBinary()
  const rawDataHex = bytesToHex(rawBytes).slice(2)
  const contracts = rawPb.getContractList()
  if (contracts.length === 0) {
    throw new Error('transaction carries no contract')
  }
  const typeUrl = contracts[0].getParameter().getTypeUrl()
  const type = typeUrl.slice(typeUrl.lastIndexOf('.') + 1)
  // Decode authorities locally: the bundled projection assumes every authority has an account.
  // Only its projection copy is changed; rawBytes remain the signed representation.
  const auths = rawPb.getAuthsList()
  rawPb.clearAuthsList()
  let rawData: SignedTronTx['raw_data']
  try {
    rawData = deserializeTransaction(type, bytesToHex(rawPb.serializeBinary()).slice(2))
  } catch (error) {
    if (type !== 'UnfreezeAssetContract') throw error
    const projected = protobufTransactionJSON(hex).raw_data
    if (typeof projected !== 'object' || projected === null) throw error
    rawData = projected as SignedTronTx['raw_data']
    rawData.contract = rawData.contract.slice(0, 1)
    rawData.contract[0].parameter.value = unfreezeAssetValue(
      contracts[0].getParameter().getValue_asU8(),
    ) as SignedTronTx['raw_data']['contract'][number]['parameter']['value']
  }
  const first = rawData.contract[0] as unknown as Record<string, unknown>
  const valueBytes = contracts[0].getParameter().getValue_asU8()
  if (first.type === 'AssetIssueContract') {
    const parameter = first.parameter as { value?: Record<string, unknown> }
    parameter.value = assetIssueValue(valueBytes)
  }
  if (
    first.type === 'FreezeBalanceContract' ||
    first.type === 'UnfreezeBalanceContract' ||
    first.type === 'FreezeBalanceV2Contract' ||
    first.type === 'UnfreezeBalanceV2Contract' ||
    first.type === 'DelegateResourceContract' ||
    first.type === 'UnDelegateResourceContract'
  ) {
    const resource = decodedContractField(first.type, valueBytes, 'getResource')
    if (resource !== undefined) {
      ;(first.parameter as { value: Record<string, unknown> }).value.resource =
        resourceName(resource)
    }
  }
  if (first.type === 'AccountCreateContract') {
    const accountType = decodedContractField(first.type, valueBytes, 'getType')
    if (accountType !== undefined) {
      ;(first.parameter as { value: Record<string, unknown> }).value.type =
        accountType === 1 ? 'AssetIssue' : accountType === 2 ? 'Contract' : 'Normal'
    }
  }
  if (first.type === 'CreateSmartContract') {
    const version = smartContractVersion(valueBytes)
    if (version !== undefined && version !== 0) {
      const value = (first.parameter as { value: Record<string, unknown> }).value
      const contract = value.new_contract as Record<string, unknown>
      contract.version = version
    }
  }
  if (rawPb.getRefBlockNum() !== 0) rawData.ref_block_num = rawPb.getRefBlockNum()
  const scripts = rawPb.getScripts_asU8()
  if (scripts.length > 0) rawData.scripts = bytesToHex(scripts).slice(2)
  if (auths.length > 0) {
    rawData.auths = auths.map(authorityJSON)
  }
  const provider = contracts[0].getProvider_asU8()
  if (provider.length > 0) first.provider = bytesToHex(provider).slice(2)
  const contractName = contracts[0].getContractname_asU8()
  if (contractName.length > 0) first.ContractName = bytesToHex(contractName).slice(2)
  // `deserializeTransaction` projects only the first contract.  The remaining
  // entries must still reach the structural check rather than disappearing.
  for (const extra of contracts.slice(1)) {
    rawData.contract.push({
      type: contractTypeName(extra.getType()),
      parameter: { type_url: extra.getParameter().getTypeUrl(), value: {} },
    })
  }
  const tx = {
    txID: utils.ethersUtils.sha256(rawBytes).slice(2),
    raw_data: lowerHexFields(rawData) as SignedTronTx['raw_data'],
    raw_data_hex: rawDataHex,
    signature: decoded.getSignatureList_asU8().map((entry) => bytesToHex(entry).slice(2)),
  } as SignedTronTx
  bindRawData(tx, rawBytes)
  return tx
}

/** sha256 of no bytes, which is what an empty transaction hashes to */
const EMPTY_TX_ID = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/**
 * Same acceptance path as broadcasttransaction, different envelope: the input
 * is protobuf hex and the reply echoes the decoded transaction in visible form.
 */
async function broadcastHex(node: NodeCore, params: HandlerParams): Promise<unknown> {
  // the wire admits one lower-case `0x` prefix on the hex body
  const stated = String(params.transaction ?? '')
  const hex = stated.startsWith('0x') ? stated.slice(2) : stated
  if (hex !== '' && !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new HexDecodeError()
  }
  let tx: SignedTronTx
  try {
    // no bytes at all is an empty message, which parses into a contract-less
    // transaction rather than failing
    tx = hex === '' ? ({} as unknown as SignedTronTx) : decodeHexTransaction(hex)
  } catch {
    throw new ProtobufParseError()
  }
  // Keep the decoded object itself: its weakly associated raw protobuf is the
  // signed representation used by the shared broadcast path.
  if (tx.raw_data === undefined)
    tx.raw_data = { contract: [] } as unknown as SignedTronTx['raw_data']
  const outcome = (await broadcastTransaction(node, tx as unknown as HandlerParams)) as {
    result?: boolean
    code?: string
    message?: string
  }
  const accepted = outcome.result === true
  return {
    result: accepted,
    code: accepted ? 'SUCCESS' : (outcome.code ?? 'OTHER_ERROR'),
    // plain text here, unlike broadcasttransaction's hex-encoded Return.message
    message: accepted ? '' : utils.ethersUtils.toUtf8String(`0x${outcome.message ?? ''}`),
    // the echo carries the transaction as protobuf states it: field order by
    // number, an `Any` left packed as its own bytes, defaults omitted
    transaction: JSON.stringify(hex === '' ? {} : protobufTransactionJSON(hex)),
    txid: tx.txID ?? EMPTY_TX_ID,
  }
}

/** the signed transaction as protobuf bytes, the form both billing and the
 *  merkle leaf are computed over */
function signedTxBytes(tx: SignedTronTx, contractRet?: string): Uint8Array {
  const pb = transactionToPb(tx) as unknown as {
    addSignature?: (bytes: Uint8Array) => void
    addRet: (result: unknown) => void
    serializeBinary: () => Uint8Array
  }
  for (const signature of tx.signature ?? []) {
    pb.addSignature?.(hexToBytes(`0x${signature}`))
  }
  if (contractRet !== undefined) {
    const proto = (globalThis as unknown as { TronWebProto: { Transaction: TransactionProto } })
      .TronWebProto.Transaction
    const result = new proto.Result()
    result.setContractret(proto.Result.contractResult[contractRet])
    pb.addRet(result)
  }
  return pb.serializeBinary()
}

/**
 * TRON txTrieRoot leaf: sha256 over the full signed transaction bytes.
 * These leaves are combined when the miner seals the block.
 */
function txMerkleLeaf(tx: SignedTronTx, contractRet: string): string {
  return utils.ethersUtils.sha256(signedTxBytes(tx, contractRet)).slice(2)
}

/**
 * Bandwidth is charged over the whole signed transaction minus its `ret`
 * field, plus a fixed per-contract allowance for the result that field will
 * later hold. A freshly built protobuf carries no `ret`, so its serialized
 * length is already the cleared form.
 */
function bandwidthBytes(tx: SignedTronTx): number {
  return signedTxBytes(tx).length + MAX_RESULT_SIZE_IN_TX * tx.raw_data.contract.length
}

/** `Constant.TRANSACTION_MAX_BYTE_SIZE` — the ceiling a broadcast is held to */
const TRANSACTION_MAX_BYTE_SIZE = 500 * 1024

/** expiration may sit at most one day past the head block time */
const MAX_EXPIRATION_MS = 86_400_000

/** block cadence, which sets when the next slot opens */
const BLOCK_INTERVAL_MS = 3_000

/** signatures are 65 bytes, with up to three trailing bytes tolerated */
const PER_SIGN_LENGTH = 65
const MAX_PER_SIGN_LENGTH = 68

/**
 * The length screen every signature passes before the transaction is looked at
 * at all — ahead of the contract count, the addresses and the recovery itself.
 */
function validateSignatureLengths(tx: SignedTronTx): Record<string, unknown> | undefined {
  for (const signature of tx.signature ?? []) {
    const size = Math.floor(String(signature).replace(/^0x/i, '').length / 2)
    if (size < PER_SIGN_LENGTH || size > MAX_PER_SIGN_LENGTH) {
      return broadcastError('SIGERROR', `Signature size is ${size}`)
    }
  }
  return undefined
}

/** the transaction must still be alive when the next slot opens */
function validateExpiration(node: NodeCore, tx: SignedTronTx): Record<string, unknown> | undefined {
  const expiration = Number((tx.raw_data as { expiration?: unknown })?.expiration ?? 0)
  if (expiration < node.head().timestampMs + BLOCK_INTERVAL_MS) {
    return broadcastError('TRANSACTION_EXPIRATION_ERROR', 'Transaction expired')
  }
  return undefined
}

/**
 * Acceptance-time chain checks: the ref block (Tapos scheme) must be recent
 * chain history — ref_block_bytes are the low 16 bits of its height,
 * ref_block_hash is bytes 8..16 of its block id — and the expiration window
 * must be open relative to the head block time.
 */
function validateTapos(node: NodeCore, tx: SignedTronTx): Record<string, unknown> | undefined {
  const raw = tx.raw_data as {
    ref_block_bytes?: unknown
    ref_block_hash?: unknown
    expiration?: unknown
  }
  const refBytes = String(raw.ref_block_bytes ?? '')
  const refHash = String(raw.ref_block_hash ?? '')
  const head = node.blocks.height()
  let refHeight = /^[0-9a-fA-F]{4}$/.test(refBytes)
    ? (head & ~0xffffn) | BigInt(Number.parseInt(refBytes, 16))
    : -1n
  if (refHeight > head) {
    refHeight -= 0x10000n
  }
  const record = refHeight >= 0n ? node.blocks.getByNumber(refHeight) : undefined
  if (record === undefined || record.blockID.slice(16, 32) !== refHash.toLowerCase()) {
    return broadcastError('TAPOS_ERROR', 'Tapos check error.')
  }

  return undefined
}

/**
 * The size and expiration screens the block builder applies once the ref block
 * is known to be real. The size counted is the signed transaction with its
 * `ret` cleared, plus room for the result that field will later hold on both
 * the transaction and its contract.
 */
function validateCommon(node: NodeCore, tx: SignedTronTx): Record<string, unknown> | undefined {
  const generalBytes = signedTxBytes(tx).length + MAX_RESULT_SIZE_IN_TX * 2
  if (generalBytes > TRANSACTION_MAX_BYTE_SIZE) {
    return broadcastError(
      'TOO_BIG_TRANSACTION_ERROR',
      `Too big transaction with result, TxId ${tx.txID}, the size is ${generalBytes} bytes, maxTxSize ${TRANSACTION_MAX_BYTE_SIZE}`,
    )
  }
  const expiration = Number((tx.raw_data as { expiration?: unknown })?.expiration ?? 0)
  const headTime = node.head().timestampMs
  if (expiration <= headTime || expiration > headTime + MAX_EXPIRATION_MS) {
    return broadcastError('TRANSACTION_EXPIRATION_ERROR', 'Transaction expired')
  }
  return undefined
}

/**
 * How the bandwidth layer names an asset it cannot find. The bracketed text
 * renders the byte string that was looked up: an object identity hash, the
 * byte length, then the decoded contents. The hash says nothing about the
 * asset and differs between two otherwise identical calls, so this one is
 * drawn fresh per call.
 */
function missingAsset(assetName: unknown): string {
  const decoded = hexToUtf8Loose(assetName)
  const identity = Math.floor(Math.random() * 0x1_0000_0000).toString(16)
  const size = new TextEncoder().encode(decoded).length
  return `asset [<ByteString@${identity} size=${size} contents="${decoded}">] does not exist`
}

/**
 * The contract list is read straight off the parsed body, so a request missing
 * either the raw data or the list itself dereferences nothing — each at its
 * own step, which is what names the value in the message.
 */
export function requireRawData(tx: SignedTronTx): void {
  if (tx.raw_data === undefined || tx.raw_data === null) {
    throw new JavaExceptionError(
      'Cannot invoke "org.tron.json.JSONObject.getJSONArray(String)" because "rawData" is null',
    )
  }
  const contracts = (tx.raw_data as { contract?: unknown }).contract
  if (contracts === undefined || contracts === null) {
    throw new JavaExceptionError(
      'Cannot invoke "org.tron.json.JSONArray.size()" because "rawContractArray" is null',
    )
  }
}

/** recipient of an account-creating transfer family, undefined otherwise */
function transferRecipient(
  contract: NonNullable<SignedTronTx['raw_data']>['contract'][0],
): Address | undefined {
  const value = contract.parameter?.value ?? {}
  const field =
    contract.type === 'AccountCreateContract'
      ? value.account_address
      : contract.type === 'TransferContract' || contract.type === 'TransferAssetContract'
        ? value.to_address
        : undefined
  if (field === undefined) return undefined
  try {
    return parseTronAddress(String(field))
  } catch {
    return undefined
  }
}

/**
 * A rejection decided inside the write boundary, carried as a throw so the
 * write machinery unwinds everything it charged; the broadcast entry catches
 * it and answers with the reply it holds.
 */
class BroadcastRejection extends TransactionRejectedError {
  readonly reply: Record<string, unknown>

  constructor(reply: Record<string, unknown>) {
    super('broadcast rejected')
    this.reply = reply
  }
}

function reject(code: string, message: string): never {
  throw new BroadcastRejection(broadcastError(code, message))
}

/** Normalize the wire transaction before identifying or executing it. */
function prepareTransaction(tx: SignedTronTx): void {
  requireRawData(tx)
  // contracts that do not merge under the request's wire form are dropped
  // before anything reads them; the id below is derived from what survived
  if (hasBoundRawData(tx)) packEnvelope(tx)
  else packTransaction(tx, boolParam(tx.visible))
  // `visible` only describes the submitted JSON.  Once the protobuf fields have
  // been packed, every later stage reads its canonical hex representation.
  tx.visible = false
  // a type with an encoder of its own states an int64 whole, so only the ones
  // that go through the bundled encoder are held to what it can state
  const bundled = (tx.raw_data.contract ?? []).some((entry) => !canEncodeLocally(entry?.type ?? ''))
  const tooWide = bundled ? widestInt(tx.raw_data) : undefined
  if (tooWide !== undefined) {
    reject(
      'CONTRACT_VALIDATE_ERROR',
      `${tooWide} is past ${MAX_EXACT_INT}, the widest this node signs for`,
    )
  }
  // The id is not a field of the transaction message — it is the hash of
  // raw_data, so nothing a request states at the top level is part of what was
  // signed. Everything downstream keys on the derived id: what the duplicate
  // check consults, what a deployment's address is generated from, and what the
  // block, the receipt and the reply carry.
  const protobuf = transactionToPb(tx)
  tx.raw_data_hex = bytesToHex(protobuf.getRawData().serializeBinary()).slice(2)
  tx.txID = transactionId(tx)
  const badSignature = validateSignatureLengths(tx)
  if (badSignature !== undefined) {
    throw new BroadcastRejection(badSignature)
  }
}

/** Signature and chain checks shared by admission and block-time revalidation. */
async function validateTransaction(
  node: NodeCore,
  tx: SignedTronTx,
): Promise<{ owner: Address; adapted: AdaptedContract }> {
  const contracts = tx.raw_data?.contract
  const size = Array.isArray(contracts) ? contracts.length : 0
  // an empty list is turned away at the broadcast entry; carrying more than one
  // gets as far as the block builder, which is where the wordier rule lives
  if (size === 0) {
    reject('CONTRACT_VALIDATE_ERROR', 'No contract!')
  }
  // the window is judged before the contract is looked at: a transaction that
  // can no longer be included is turned away whatever it says
  const expired = validateExpiration(node, tx)
  if (expired !== undefined) {
    throw new BroadcastRejection(expired)
  }

  const contract = contracts[0]
  const value = contract.parameter?.value ?? {}
  let owner: Address
  try {
    owner = parseTronAddress(String(value.owner_address ?? ''))
  } catch {
    // the wording is actuator-specific: TransferContract exclaims, the stake
    // family says `Invalid address`, the rest state the field name
    const message =
      contract.type === 'TransferContract'
        ? 'Invalid ownerAddress!'
        : /^(FreezeBalance|UnfreezeBalance|WithdrawExpireUnfreeze|CancelAllUnfreezeV2|DelegateResource|UnDelegateResource)/.test(
              String(contract.type ?? ''),
            )
          ? 'Invalid address'
          : 'Invalid ownerAddress'
    reject('CONTRACT_VALIDATE_ERROR', message)
  }
  // the remaining addresses are parsed before signature recovery, which walks
  // the same fields and would otherwise surface a decoder error instead
  const newContract = (value.new_contract ?? {}) as Record<string, unknown>
  for (const [field, message, holder] of [
    ['to_address', 'Invalid toAddress', value],
    ['contract_address', 'Invalid contract address', value],
    ['origin_address', 'Invalid OriginAddress', newContract],
  ] as const) {
    if (holder[field] === undefined) continue
    try {
      parseTronAddress(String(holder[field]))
    } catch {
      reject('CONTRACT_VALIDATE_ERROR', message)
    }
  }

  // the declared permission decides which keys may sign this contract type and
  // how much weight each carries; unlocked accounts skip the signatures
  const ownerBase58 = toBase58(owner)
  if (!node.unlockedAccounts.has(ownerBase58)) {
    if ((tx.signature ?? []).length === 0) {
      reject('SIGERROR', 'miss sig or contract')
    }
    // the chain-wide cap is applied before any key is recovered, so it is not
    // the permission's key count that turns an over-signed transaction away
    if ((tx.signature ?? []).length > node.config.chainParameters.totalSignNum) {
      reject('SIGERROR', 'too many signatures')
    }
    const weight = await checkSignatureWeight(node, owner, contract, tx, transactionId(tx))
    if (weight.error !== undefined) {
      reject('SIGERROR', weight.error)
    }
    if (weight.currentWeight < (weight.permission?.threshold ?? 1)) {
      reject('SIGERROR', 'sig error')
    }
  }

  // carrying more than one contract gets as far as the block builder, which
  // is where the wordier rule lives
  if (size !== 1 || typeof tx.txID !== 'string') {
    reject(
      'CONTRACT_VALIDATE_ERROR',
      `tx ${typeof tx.txID === 'string' ? tx.txID : ''} contract size should be exactly 1, this is extend feature ,actual :${size}`,
    )
  }

  const chainCheck = validateTapos(node, tx)
  if (chainCheck !== undefined) {
    throw new BroadcastRejection(chainCheck)
  }
  const oversized = validateCommon(node, tx)
  if (oversized !== undefined) {
    throw new BroadcastRejection(oversized)
  }

  const outcome = adaptContract(node, contract, tx)
  if ('error' in outcome) {
    throw new BroadcastRejection(outcome.error)
  }
  if (outcome.params !== undefined) {
    outcome.params.rootTransactionId = hexToBytes(`0x${tx.txID}`)
  }
  return { owner, adapted: outcome }
}

/** Apply one transaction; the miner seals and indexes the whole block afterwards. */
async function executeTransaction(
  node: NodeCore,
  tx: SignedTronTx,
): ReturnType<PendingTransaction['execute']> {
  // Revalidate against the committed head, before the candidate block updates it.
  const { owner, adapted } = await validateTransaction(node, tx)
  const contract = tx.raw_data.contract[0]
  const value = contract.parameter?.value ?? {}
  const ownerBase58 = toBase58(owner)
  // account-creating transfers replace per-byte billing with fixed fees:
  // the create-account fee on the bandwidth side plus the system-contract
  // fee, both burned from the sender
  const chainParameters = node.config.chainParameters
  const transferTo = transferRecipient(contract)
  const createsAccount =
    transferTo !== undefined && (await node.getAccount(transferTo)) === undefined

  // billing precedes the actuator: a sender who
  // cannot pay for the bytes is turned away before the contract is examined,
  // so an unfundable transaction reports a resource error rather than
  // whatever the contract would also have failed on
  // the bandwidth layer runs before any actuator, and it refuses to bill an
  // account that does not exist
  if ((await node.getAccount(owner)) === undefined) {
    reject('CONTRACT_VALIDATE_ERROR', `account [${ownerBase58}] does not exist`)
  }

  // an asset transfer draws on the issuance's free bandwidth, so the bandwidth
  // layer looks the asset up — and refuses first when there is none. Creating
  // the recipient takes a different branch that never reaches the lookup.
  let transferAssetMeta: AssetMeta | undefined
  if (contract.type === 'TransferAssetContract' && !createsAccount) {
    const tokenId = assetIdOf(node, value.asset_name, tx.visible === true)
    const meta = tokenId === undefined ? undefined : node.assets.byId(tokenId)
    if (meta === undefined) {
      reject('CONTRACT_VALIDATE_ERROR', missingAsset(value.asset_name))
    }
    transferAssetMeta = meta
  }

  const txBytes = bandwidthBytes(tx)
  let bandwidth: Awaited<ReturnType<NodeCore['consumeBandwidth']>>
  if (createsAccount) {
    // an account-activating transaction is held to its own byte cap,
    // measured over the serialized form minus its signatures
    const bare = signedTxBytes(tx).length - (tx.signature ?? []).length * PER_SIGN_LENGTH
    if (bare > chainParameters.maxCreateAccountTxSize) {
      reject(
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big new account transaction, TxId ${tx.txID}, the size is ${bare} bytes, maxTxSize ${chainParameters.maxCreateAccountTxSize}`,
      )
    }
    // the fee path bills the sender too, so it stamps the same clock
    node.noteOperation(owner)
    // an account-creating transfer skips the free allowance: staked
    // bandwidth may cover the bytes, otherwise the flat fee burns
    if (node.consumeStakedNet(owner, txBytes)) {
      bandwidth = { source: 'staked' }
    } else {
      const feeSun = BigInt(chainParameters.createAccountFee)
      bandwidth = (await node.deductBalance(owner, feeSun))
        ? { source: 'burn', feeSun }
        : { source: 'insufficient', feeSun }
    }
  } else if (
    transferAssetMeta !== undefined &&
    `41${transferAssetMeta.ownerKey}` !== toTronHex(owner) &&
    node.consumeAssetNet(owner, transferAssetMeta, txBytes)
  ) {
    // a holder's transfer rides the issuance's free bandwidth when its
    // three quotas hold; the issuer's own transfers take the ordinary
    // sources directly
    node.noteOperation(owner)
    bandwidth = { source: 'asset' }
  } else {
    bandwidth = await node.consumeBandwidth(owner, txBytes)
  }
  if (bandwidth.source === 'insufficient') {
    reject('BANDWITH_ERROR', 'Account resource insufficient error.')
  }

  // more than one signature costs a flat fee, burned right after bandwidth
  const multiSignFeeSun =
    (tx.signature ?? []).length > 1 ? BigInt(chainParameters.multiSignFee) : 0n
  if (multiSignFeeSun > 0n && !(await node.deductBalance(owner, multiSignFeeSun))) {
    reject('BANDWITH_ERROR', 'Account resource insufficient error.')
  }

  // a memo costs a flat fee, burned between bandwidth and the actuator
  const memoFeeSun = String(tx.raw_data.data ?? '') === '' ? 0n : BigInt(chainParameters.memoFee)
  if (memoFeeSun > 0n && !(await node.deductBalance(owner, memoFeeSun))) {
    reject('BANDWITH_ERROR', 'Account resource insufficient error.')
  }

  // actuator rules run after billing: the checks see the
  // balance that survives it. A rule that trips is a rejected broadcast,
  // not a FAILED receipt.
  if (adapted.validate !== undefined) {
    const invalid = await adapted.validate(node, { createsAccount })
    if (invalid !== undefined) {
      reject('CONTRACT_VALIDATE_ERROR', invalid)
    }
  }

  if (createsAccount && transferTo !== undefined) {
    await node.noteCreation(transferTo)
  }

  let result: WriteResult
  let extraInfo: Record<string, unknown> | undefined
  if (adapted.stateOp !== undefined) {
    const outcome = await adapted.stateOp(node)
    if ('error' in outcome) {
      throw new BroadcastRejection(outcome.error)
    }
    extraInfo = outcome.extra
    result = {
      execResult: { executionGasUsed: 0n, returnValue: new Uint8Array() } as ExecResult,
      energyUsed: 0n,
      energyFeeSun: outcome.feeSun,
      returnValue: new Uint8Array(),
      reverted: false,
      internalTxs: [],
    }
  } else {
    result = await node.execute(adapted.params as WriteParams)
  }
  if (bandwidth.source === 'burn') {
    result.netFeeSun = bandwidth.feeSun
  } else {
    result.netUsage = txBytes
  }
  result.memoFeeSun = memoFeeSun
  result.multiSignFeeSun = multiSignFeeSun
  // the system-contract fee for creating the recipient account, burned once
  // the transfer has gone through
  // a transfer pays this on top of what it moves; a contract that creates
  // an account outright charges it in its own actuator
  if (createsAccount && !result.reverted && contract.type !== 'AccountCreateContract') {
    const feeSun = BigInt(chainParameters.createNewAccountFeeInSystemContract)
    if (await node.deductBalance(owner, feeSun)) {
      result.extraFeeSun = feeSun
    }
  }

  // a contract created inside the execution gets its own on-chain record:
  // origin is the creating contract, the caller pays everything, and a
  // salted create carries the root transaction id
  if (!result.reverted) {
    for (const call of result.internalTxs) {
      if (call.create !== true || call.rejected || call.to === undefined) continue
      if ((await node.getAccount(call.to)) === undefined) continue
      if (node.getContractMeta(call.to) !== undefined) continue
      node.registerContract(call.to, {
        abi: [],
        name: '',
        originAddress: toTronHex(call.caller),
        bytecode: '',
        consumeUserResourcePercent: 100,
        originEnergyLimit: 0,
        ...(call.create2 === true ? { trxHash: tx.txID } : {}),
      })
    }
  }

  const transaction = printTransaction({
    ret: [{ contractRet: contractRetOf(result) }],
    signature: tx.signature,
    txID: tx.txID,
    raw_data: tx.raw_data,
    raw_data_hex: tx.raw_data_hex,
  })
  const record: TronTxRecord = {
    txid: tx.txID,
    transaction,
    info: {},
    execution: result.execution,
  }
  if (
    adapted.deployMeta !== undefined &&
    result.createdAddress !== undefined &&
    !result.reverted &&
    (await node.getAccount(result.createdAddress)) !== undefined
  ) {
    node.registerContract(result.createdAddress, adapted.deployMeta)
  }
  return {
    record,
    merkleLeaf: txMerkleLeaf(tx, contractRetOf(result)),
    finalize(blockRecord) {
      record.info = {
        ...buildTransactionInfo(
          tx,
          result,
          blockRecord,
          contract.type === 'TransferContract' || adapted.stateOp !== undefined,
        ),
        ...extraInfo,
      }
    },
  }
}

/** Broadcast returns the admission result; instant mode also commits a block. */
async function broadcastTransaction(node: NodeCore, params: HandlerParams): Promise<unknown> {
  const tx = params as unknown as SignedTronTx
  try {
    prepareTransaction(tx)
    const internals = await node.submitTransaction(
      {
        txid: tx.txID,
        execute: (state) => executeTransaction(state, tx),
      },
      async (state) => {
        const { adapted } = await validateTransaction(state, tx)
        const params = adapted.params
        if (params === undefined || params.plainTransfer === true) return undefined
        // The reply carries a constant preview at the current head, independently of
        // pending admission and the eventual execution in a produced block.
        const cap = state.runtime.maxEnergyLimitForConstant
        const feeLimit = BigInt(tx.raw_data.fee_limit ?? 0)
        const limit =
          feeLimit > 0n ? feeLimit / BigInt(state.config.chainParameters.energyFee) : cap
        const result = await state.call({ ...params, energyLimit: limit < cap ? limit : cap })
        return buildInternalTransactions(tx.txID, result)
      },
    )
    return {
      result: true,
      ...(internals === undefined ? {} : { internal_transactions: internals }),
      txid: tx.txID,
    }
  } catch (error) {
    if (error instanceof TransactionEncodingError) {
      return broadcastError('CONTRACT_VALIDATE_ERROR', error.message)
    }
    if (error instanceof BroadcastRejection) return error.reply
    if (error instanceof DuplicateTransactionError) {
      return broadcastError('DUP_TRANSACTION_ERROR', 'Dup transaction.')
    }
    throw error
  }
}

/**
 * The reply always names the transaction, success or not, and the id is
 * re-derived from raw_data rather than echoed: a client that sent a stale txID
 * still learns which transaction the node saw.
 */
async function broadcastWithTxid(node: NodeCore, params: HandlerParams): Promise<unknown> {
  const visible = boolParam(params.visible)
  const outcome = (await broadcastTransaction(node, params)) as Record<string, unknown>
  if (typeof outcome.Error === 'string') return outcome
  return {
    ...plainMessageUnderVisible(outcome, visible),
    txid: transactionId(params as unknown as SignedTronTx),
  }
}

/**
 * `Return.message` is one of the name-string fields, so under `visible` it is
 * printed as the text it holds rather than as its bytes.
 */
export function plainMessageUnderVisible(
  reply: Record<string, unknown>,
  visible: boolean,
): Record<string, unknown> {
  if (!visible || typeof reply.message !== 'string') return reply
  return { ...reply, message: hexToUtf8Loose(reply.message) }
}

export function registerBroadcastHandlers(registry: Registry): void {
  registry.register('wallet/broadcasttransaction', broadcastWithTxid)
  // handwritten reply, so result:false and an
  // empty message stay on the wire
  registry.register('wallet/broadcasthex', broadcastHex, { verbatim: true })
  registry.register('wallet/createtransaction', createTransaction, {})
  registry.register('wallet/deploycontract', deployContract, {})
  registry.register('wallet/createassetissue', createAssetIssue, {})
  registry.register(
    'wallet/transferasset',
    (node, params) => buildAssetTransferTx(node, 'TransferAssetContract', params),
    {},
  )
  registry.register(
    'wallet/participateassetissue',
    (node, params) => buildAssetTransferTx(node, 'ParticipateAssetIssueContract', params),
    {},
  )
  registry.register('wallet/unfreezeasset', unfreezeAsset, {})
  registry.register('wallet/accountpermissionupdate', accountPermissionUpdate, { verbatim: true })
  registry.register('wallet/updatesetting', updateSetting, {})
  registry.register('wallet/updateenergylimit', updateEnergyLimit, {})
  registry.register('wallet/clearabi', clearAbi, {})
  registry.register('wallet/updateasset', updateAsset, {})
  registry.register('wallet/updateaccount', updateAccount, {})
  registry.register('wallet/setaccountid', setAccountId, {})
  registry.register('wallet/createaccount', createAccount, {})
  registry.register('wallet/createCommonTransaction', createCommonTransaction, {})
  registry.register('wallet/freezebalancev2', freezeBalanceV2, {})
  registry.register('wallet/unfreezebalancev2', unfreezeBalanceV2, {})
  registry.register('wallet/withdrawexpireunfreeze', withdrawExpireUnfreeze, {})
  registry.register('wallet/cancelallunfreezev2', cancelAllUnfreezeV2, {})
  registry.register('wallet/delegateresource', delegateResource, {})
  registry.register('wallet/undelegateresource', unDelegateResource, {})
  registry.register('wallet/freezebalance', freezeBalance, {})
  registry.register('wallet/unfreezebalance', unfreezeBalance, {})
}
