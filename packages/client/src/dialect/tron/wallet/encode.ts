import { hexToBytes } from '@tvmjs/util'
import { utils } from 'tronweb'

import { boolParam } from '../address.ts'
import { packEnvelope, packTransaction } from './pack.ts'

import type { SignedTronTx } from './types.ts'

const { txJsonToPb } = utils.transaction

/** the generated protobuf classes the client library publishes on the global object */
interface ProtoRegistry {
  Transaction: {
    new (): TransactionPb
    deserializeBinary(bytes: Uint8Array): TransactionPb
    raw: {
      new (): RawPb
      deserializeBinary(bytes: Uint8Array): RawPb
    }
    Contract: {
      new (): ContractPb
      ContractType: Record<string, number>
    }
  }
  UnfreezeAssetContract: new () => { setOwnerAddress(bytes: Uint8Array): void }
  AccountCreateContract: {
    deserializeBinary(bytes: Uint8Array): {
      setType(value: number): void
      serializeBinary(): Uint8Array
    }
  }
  CreateSmartContract: {
    deserializeBinary(bytes: Uint8Array): {
      getNewContract(): {
        setVersion(value: number): void
      }
      setNewContract(value: unknown): void
      serializeBinary(): Uint8Array
    }
  }
  authority: new () => AuthorityPb
  AccountId: new () => AccountIdPb
}

interface TransactionPb {
  setRawData(raw: RawPb): void
  getRawData(): RawPb
  serializeBinary(): Uint8Array
  addSignature?(bytes: Uint8Array): void
}

interface RawPb {
  addContract(contract: ContractPb): void
  getContractList(): ContractPb[]
  setRefBlockBytes(bytes: Uint8Array): void
  getRefBlockBytes_asU8(): Uint8Array
  setRefBlockHash(bytes: Uint8Array): void
  getRefBlockHash_asU8(): Uint8Array
  setExpiration(value: number): void
  getExpiration(): number
  setTimestamp(value: number): void
  getTimestamp(): number
  setFeeLimit(value: number): void
  getFeeLimit(): number
  setData(bytes: Uint8Array): void
  getData_asU8(): Uint8Array
  setRefBlockNum(value: number): void
  setAuthsList(value: AuthorityPb[]): void
  setScripts(bytes: Uint8Array): void
  serializeBinary(): Uint8Array
}

interface ContractPb {
  setType(value: number): void
  setParameter(value: unknown): void
  setPermissionId(value: number): void
  getParameter(): AnyPb
  setProvider(value: Uint8Array): void
  setContractname(value: Uint8Array): void
}

interface AccountIdPb {
  setName(value: Uint8Array): void
  setAddress(value: Uint8Array): void
}

interface AuthorityPb {
  setPermissionName(value: Uint8Array): void
  setAccount(value: AccountIdPb): void
}

function protoRegistry(): ProtoRegistry {
  const proto = (globalThis as unknown as { TronWebProto?: ProtoRegistry }).TronWebProto
  if (proto === undefined) {
    throw new Error('transaction protobuf definitions are unavailable')
  }
  return proto
}

/**
 * The `Any` wrapper class. It is not exported alongside the other generated
 * messages, so it is read off an instance the bundled encoder produces, which
 * keeps the wrapper identical to the one every other contract type uses.
 */
let cachedAny: (new () => AnyPb) | undefined

interface AnyPb {
  pack(bytes: Uint8Array, typeName: string): void
  getValue_asU8(): Uint8Array
  setValue(bytes: Uint8Array): void
}

/** Raw data decoded from broadcasthex is already the signed representation. */
const decodedRawData = new WeakMap<SignedTronTx, Uint8Array>()

export function bindRawData(tx: SignedTronTx, rawData: Uint8Array): void {
  decodedRawData.set(tx, rawData.slice())
}

export function hasBoundRawData(tx: SignedTronTx): boolean {
  return decodedRawData.has(tx)
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (
    typeof value === 'bigint' &&
    value >= -BigInt(Number.MAX_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value)
  }
  return undefined
}

function int32Number(value: unknown): number | undefined {
  const number = safeNumber(value)
  return number !== undefined && number >= -2147483648 && number <= 2147483647 ? number : undefined
}

function canonicalContractFields(tx: SignedTronTx, pb: TransactionPb): void {
  const contract = tx.raw_data.contract[0]
  if (contract === undefined) return
  const value = contract.parameter?.value ?? {}
  const parameter = pb.getRawData().getContractList()[0]?.getParameter()
  if (parameter === undefined) return
  const proto = protoRegistry()
  if (contract.type === 'AccountCreateContract') {
    const type = value.type
    const accountType =
      type === 'AssetIssue'
        ? 1
        : type === 'Contract'
          ? 2
          : type === 'Normal'
            ? 0
            : int32Number(type)
    if (accountType === undefined) return
    const account = proto.AccountCreateContract.deserializeBinary(parameter.getValue_asU8())
    account.setType(accountType)
    parameter.setValue(account.serializeBinary())
    return
  }
  if (contract.type === 'CreateSmartContract') {
    const smart = value.new_contract as Record<string, unknown> | undefined
    const version = smart === undefined ? undefined : int32Number(smart.version)
    if (version === undefined) return
    const create = proto.CreateSmartContract.deserializeBinary(parameter.getValue_asU8())
    const newContract = create.getNewContract()
    newContract.setVersion(version)
    create.setNewContract(newContract)
    parameter.setValue(create.serializeBinary())
  }
}

function canonicalEnvelopeFields(tx: SignedTronTx, pb: TransactionPb): void {
  const source = tx.raw_data as Record<string, unknown>
  const raw = pb.getRawData()
  if (source.ref_block_num !== undefined) {
    raw.setRefBlockNum(Number(source.ref_block_num))
  }
  if (Array.isArray(source.auths) && source.auths.length > 0) {
    const proto = protoRegistry()
    const auths: AuthorityPb[] = []
    for (const entry of source.auths) {
      if (entry === null || typeof entry !== 'object') continue
      const authority = entry as Record<string, unknown>
      const account = authority.account
      const authorityPb = new proto.authority()
      if (typeof authority.permission_name === 'string' && authority.permission_name !== '') {
        authorityPb.setPermissionName(
          hexToBytes(`0x${authority.permission_name.replace(/^0x/i, '')}`),
        )
      }
      if (account !== null && typeof account === 'object') {
        const accountSource = account as Record<string, unknown>
        const accountPb = new proto.AccountId()
        if (typeof accountSource.name === 'string' && accountSource.name !== '') {
          accountPb.setName(hexToBytes(`0x${accountSource.name}`))
        }
        if (typeof accountSource.address === 'string' && accountSource.address !== '') {
          accountPb.setAddress(hexToBytes(`0x${accountSource.address}`))
        }
        authorityPb.setAccount(accountPb)
      }
      auths.push(authorityPb)
    }
    if (auths.length > 0) raw.setAuthsList(auths)
  }
  if (typeof source.scripts === 'string' && source.scripts !== '') {
    raw.setScripts(hexToBytes(`0x${source.scripts.replace(/^0x/i, '')}`))
  }
  const contract = raw.getContractList()[0]
  const stated = tx.raw_data.contract[0] as (typeof tx.raw_data.contract)[number] &
    Record<string, unknown>
  if (contract === undefined || stated === undefined) return
  if (typeof stated.provider === 'string' && stated.provider !== '') {
    contract.setProvider(hexToBytes(`0x${stated.provider}`))
  }
  if (typeof stated.ContractName === 'string' && stated.ContractName !== '') {
    contract.setContractname(hexToBytes(`0x${stated.ContractName}`))
  }
}

function anyConstructor(): new () => AnyPb {
  if (cachedAny !== undefined) return cachedAny
  const template = txJsonToPb({
    raw_data: {
      contract: [
        {
          type: 'TransferContract',
          parameter: {
            value: {
              owner_address: `41${'11'.repeat(20)}`,
              to_address: `41${'22'.repeat(20)}`,
              amount: 1,
            },
          },
        },
      ],
      ref_block_bytes: '0001',
      ref_block_hash: '0011223344556677',
      expiration: 1,
      timestamp: 1,
    },
  } as never) as unknown as {
    getRawData(): { getContractList(): { getParameter(): AnyPb }[] }
  }
  const instance = template.getRawData().getContractList()[0].getParameter()
  cachedAny = Object.getPrototypeOf(instance).constructor as new () => AnyPb
  return cachedAny
}

function rawBytes(value: unknown): Uint8Array {
  return typeof value === 'string' && value !== '' ? hexToBytes(`0x${value}`) : new Uint8Array()
}

/**
 * Contract types the bundled JSON→protobuf helper has no branch for. A node has
 * to encode every type it accepts — the generated message classes are all
 * present, only the helper's dispatch table is short — so those types are
 * assembled here from the same classes.
 */
const OWN_ENCODERS: Record<
  string,
  (
    proto: ProtoRegistry,
    value: Record<string, unknown>,
  ) => {
    message: { serializeBinary(): Uint8Array }
    typeName: string
    contractType: number
  }
> = {
  UnfreezeAssetContract: (proto, value) => {
    const message = new proto.UnfreezeAssetContract()
    message.setOwnerAddress(hexToBytes(`0x${String(value.owner_address ?? '')}`))
    return {
      message: message as unknown as { serializeBinary(): Uint8Array },
      typeName: 'UnfreezeAssetContract',
      contractType: proto.Transaction.Contract.ContractType.UNFREEZEASSETCONTRACT,
    }
  },
  // the bundled helper's branch for this type is incomplete — it encodes only
  // the first frozen_supply entry — and its generated int64 setters narrow
  // through a double. The wire bytes are assembled directly instead: every
  // repeated element goes in, every int64 keeps its digits, and a field left
  // at its protobuf default stays out of the bytes
  AssetIssueContract: (proto, value) => {
    const bytes: number[] = []
    const varint = (raw: bigint): number[] => {
      // negatives ride as their 64-bit two's complement, ten bytes long
      let held = raw < 0n ? raw + (1n << 64n) : raw
      const out: number[] = []
      while (held > 0x7fn) {
        out.push(Number(held & 0x7fn) | 0x80)
        held >>= 7n
      }
      out.push(Number(held))
      return out
    }
    const key = (field: number, wire: number): number[] => varint(BigInt(field * 8 + wire))
    const bytesField = (field: number, raw: unknown): void => {
      const hex = String(raw ?? '')
      if (hex === '') return
      const data = hexToBytes(`0x${hex}`)
      bytes.push(...key(field, 2), ...varint(BigInt(data.length)), ...data)
    }
    const intField = (field: number, raw: unknown): void => {
      const held = BigInt(String(raw ?? 0))
      if (held === 0n) return
      bytes.push(...key(field, 0), ...varint(held))
    }
    bytesField(1, value.owner_address)
    bytesField(2, value.name)
    bytesField(3, value.abbr)
    intField(4, value.total_supply)
    for (const entry of Array.isArray(value.frozen_supply) ? value.frozen_supply : []) {
      const row = entry as Record<string, unknown>
      const tranche: number[] = []
      const amount = BigInt(String(row.frozen_amount ?? 0))
      if (amount !== 0n) tranche.push(...key(1, 0), ...varint(amount))
      const days = BigInt(String(row.frozen_days ?? 0))
      if (days !== 0n) tranche.push(...key(2, 0), ...varint(days))
      bytes.push(...key(5, 2), ...varint(BigInt(tranche.length)), ...tranche)
    }
    intField(6, value.trx_num)
    intField(7, value.precision)
    intField(8, value.num)
    intField(9, value.start_time)
    intField(10, value.end_time)
    intField(11, value.order)
    intField(16, value.vote_score)
    bytesField(20, value.description)
    bytesField(21, value.url)
    intField(22, value.free_asset_net_limit)
    intField(23, value.public_free_asset_net_limit)
    intField(24, value.public_free_asset_net_usage)
    intField(25, value.public_latest_free_net_time)
    const id = String(value.id ?? '')
    if (id !== '') {
      const data = new TextEncoder().encode(id)
      bytes.push(...key(41, 2), ...varint(BigInt(data.length)), ...data)
    }
    return {
      message: { serializeBinary: () => new Uint8Array(bytes) },
      typeName: 'AssetIssueContract',
      contractType: proto.Transaction.Contract.ContractType.ASSETISSUECONTRACT,
    }
  },
}

export function canEncodeLocally(type: string): boolean {
  return OWN_ENCODERS[type] !== undefined
}

/**
 * The `Transaction` protobuf for one of the locally-encoded types, assembled
 * the same way the bundled helper assembles the types it knows: the contract
 * message goes into an `Any` tagged `protocol.<TypeName>`, and the envelope
 * carries the ref block, timing and optional memo.
 */
function encodeLocally(tx: SignedTronTx): TransactionPb {
  const proto = protoRegistry()
  const contract = tx.raw_data.contract[0]
  const encoder = OWN_ENCODERS[contract.type]
  if (encoder === undefined) {
    throw new Error(`Unsupported transaction type: ${contract.type}`)
  }
  const built = encoder(proto, contract.parameter?.value ?? {})

  const anyValue = new (anyConstructor())()
  anyValue.pack(built.message.serializeBinary(), `protocol.${built.typeName}`)

  const contractPb = new proto.Transaction.Contract()
  contractPb.setType(built.contractType)
  contractPb.setParameter(anyValue)
  if (contract.Permission_id !== undefined && contract.Permission_id !== 0) {
    contractPb.setPermissionId(contract.Permission_id)
  }

  const raw = new proto.Transaction.raw()
  raw.addContract(contractPb)
  raw.setRefBlockBytes(rawBytes(tx.raw_data.ref_block_bytes))
  raw.setRefBlockHash(rawBytes(tx.raw_data.ref_block_hash))
  if (tx.raw_data.expiration) raw.setExpiration(tx.raw_data.expiration)
  if (tx.raw_data.timestamp) raw.setTimestamp(tx.raw_data.timestamp)
  if (tx.raw_data.fee_limit) raw.setFeeLimit(tx.raw_data.fee_limit)
  if (tx.raw_data.data) raw.setData(hexToBytes(`0x${tx.raw_data.data}`))

  const transaction = new proto.Transaction()
  transaction.setRawData(raw)
  return transaction
}

/**
 * The envelope alone, for a transaction carrying no contract. Its id is still
 * derived from the raw data, so a caller that sent one learns which
 * transaction was rejected.
 */
function encodeEnvelope(tx: SignedTronTx): TransactionPb {
  const proto = protoRegistry()
  const raw = new proto.Transaction.raw()
  raw.setRefBlockBytes(rawBytes(tx.raw_data.ref_block_bytes))
  raw.setRefBlockHash(rawBytes(tx.raw_data.ref_block_hash))
  if (tx.raw_data.expiration) raw.setExpiration(tx.raw_data.expiration)
  if (tx.raw_data.timestamp) raw.setTimestamp(tx.raw_data.timestamp)
  if (tx.raw_data.fee_limit) raw.setFeeLimit(tx.raw_data.fee_limit)
  if (tx.raw_data.data) raw.setData(hexToBytes(`0x${tx.raw_data.data}`))
  const transaction = new proto.Transaction()
  transaction.setRawData(raw)
  return transaction
}

/**
 * The bundled encoder takes an int64 as a JS number, which cannot state the top
 * of the range; the generated setters read the digits as text instead. Only the
 * encoder sees this form — the reply carries the value as a number.
 */
function int64AsText(value: unknown): unknown {
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map(int64AsText)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, int64AsText(entry)]),
    )
  }
  return value
}

/** the protobuf form of a transaction, whichever encoder covers its type */
export function transactionToPb(tx: SignedTronTx): TransactionPb {
  const rawData = decodedRawData.get(tx)
  if (rawData !== undefined) {
    packEnvelope(structuredClone(tx))
    const transaction = new (protoRegistry().Transaction)()
    transaction.setRawData(protoRegistry().Transaction.raw.deserializeBinary(rawData))
    return transaction
  }
  // This helper is also used by signers and inspectors before broadcast.  Give
  // them the same protobuf meaning the broadcast boundary will use, without
  // changing their caller-owned JSON object.
  const canonical = structuredClone(tx)
  packTransaction(canonical, boolParam(canonical.visible))
  canonical.visible = false
  const transaction =
    (canonical.raw_data.contract?.length ?? 0) === 0
      ? encodeEnvelope(canonical)
      : canEncodeLocally(canonical.raw_data.contract[0]?.type ?? '')
        ? encodeLocally(canonical)
        : (txJsonToPb(int64AsText(canonical) as never) as unknown as TransactionPb)
  canonicalEnvelopeFields(canonical, transaction)
  canonicalContractFields(canonical, transaction)
  return transaction
}

/**
 * The transaction id the node derives from `raw_data`. Client-supplied `txID`
 * and `raw_data_hex` are not protobuf fields — they are discarded and
 * recomputed — so this is the only id that ever reaches a caller.
 */
export function transactionId(tx: SignedTronTx): string {
  try {
    return utils.ethersUtils.sha256(transactionToPb(tx).getRawData().serializeBinary()).slice(2)
  } catch {
    // raw_data that will not encode still hashes — as no bytes at all, which
    // is the id an empty message carries
    return EMPTY_RAW_DATA_ID
  }
}

/** sha256 of nothing, the id a transaction with no encodable raw_data reports */
const EMPTY_RAW_DATA_ID = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
