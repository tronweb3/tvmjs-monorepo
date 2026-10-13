import type { Types } from 'tronweb'

import type { SignedTronTx } from './dialect/tron/wallet/types.ts'
import type {
  AbiEntry,
  AccountType,
  ContractInputMap,
  ContractName,
  PermissionType,
  ResourceCode,
} from './rpcInput.ts'

/** A feature with no records on this development chain returns {}. */
export type EmptyResult = Record<string, never>

export interface RPCError {
  Error: string
  result?: false
}

/** Transaction defaults are omitted; keep integer unions intact before narrowing to JS values. */
type ContractFields<T> = {
  [K in keyof T]?: number extends NonNullable<T[K]>
    ? number | bigint
    : NonNullable<T[K]> extends readonly (infer U)[]
      ? ContractFields<U>[]
      : NonNullable<T[K]> extends object
        ? ContractFields<NonNullable<T[K]>>
        : Exclude<T[K], number | bigint | null>
}

export type TronContract<C extends ContractName = ContractName> = {
  [K in C]: {
    type: K
    parameter: { type_url: string; value: ContractFields<ContractInputMap[K]> }
    Permission_id?: number
    provider?: string
    ContractName?: string
  }
}[C]

/** Narrow a contract by its type before reading contract-specific payload fields. */
export interface TronTransaction<C extends ContractName = ContractName>
  extends Omit<SignedTronTx, 'raw_data'> {
  raw_data: Omit<SignedTronTx['raw_data'], 'fee_limit' | 'contract'> & {
    fee_limit?: number | bigint
    contract: TronContract<C>[]
  }
  ret?: { contractRet?: string; ret?: string }[]
  contract_address?: string
}

export type TransactionBuildResult<C extends ContractName = ContractName> =
  | (C extends 'TransferContract'
      ? Types.Transaction<Types.TransferContract>
      : TronTransaction<C> & { visible: boolean })
  | RPCError

export interface PermissionKey {
  address: string
  weight: bigint
}

/** Owner/default protobuf fields can be absent even on a populated permission. */
export interface AccountPermission {
  type?: PermissionType
  id?: number
  permission_name?: string
  threshold?: bigint
  parent_id?: number
  operations?: string
  keys?: PermissionKey[]
}

export interface FrozenBalance {
  frozen_balance: bigint
  /** Unix milliseconds. */
  expire_time: number
}

export interface AccountResource {
  energy_usage?: number
  frozen_balance_for_energy?: FrozenBalance
  latest_consume_time_for_energy?: number
  acquired_delegated_frozen_balance_for_energy?: bigint
  delegated_frozen_balance_for_energy?: bigint
  energy_window_size?: number
  delegated_frozenV2_balance_for_energy?: bigint
  acquired_delegated_frozenV2_balance_for_energy?: bigint
  energy_window_optimized?: boolean
}

export interface KeyValue<T> {
  key: string
  value: T
}

/** Missing accounts return {}; state-dependent and protobuf-default fields are optional. */
export interface TronAccount {
  address?: string
  /** Sun. Program account balances remain bigint, including safe/zero balances. */
  balance?: bigint
  type?: AccountType
  /** Hex bytes by default; text with visible:true. */
  account_name?: string
  account_id?: string
  frozen?: FrozenBalance[]
  net_usage?: number
  create_time?: number
  latest_opration_time?: number
  allowance?: bigint
  is_witness?: boolean
  /** Asset-supply expiry remains int64 bigint, unlike legacy-stake expiry timestamps. */
  frozen_supply?: { frozen_balance: bigint; expire_time: bigint }[]
  asset_issued_name?: string
  asset_issued_ID?: string
  free_net_usage?: number
  latest_consume_time?: number
  latest_consume_free_time?: number
  net_window_size?: number
  net_window_optimized?: boolean
  account_resource?: AccountResource
  owner_permission?: AccountPermission
  witness_permission?: AccountPermission
  active_permission?: AccountPermission[]
  /** An empty slot {} represents zero BANDWIDTH; omitted type means BANDWIDTH. */
  frozenV2?: { type?: ResourceCode; amount?: bigint }[]
  unfrozenV2?: { type?: ResourceCode; unfreeze_amount: bigint; unfreeze_expire_time: number }[]
  delegated_frozenV2_balance_for_bandwidth?: bigint
  acquired_delegated_frozenV2_balance_for_bandwidth?: bigint
  delegated_frozen_balance_for_bandwidth?: bigint
  acquired_delegated_frozen_balance_for_bandwidth?: bigint
  old_tron_power?: bigint
  tron_power?: FrozenBalance
  assetV2?: KeyValue<bigint>[]
  asset?: KeyValue<bigint>[]
  latest_asset_operation_timeV2?: KeyValue<number>[]
  latest_asset_operation_time?: KeyValue<number>[]
  free_asset_net_usageV2?: KeyValue<number>[]
  free_asset_net_usage?: KeyValue<number>[]
  asset_optimized?: boolean
}

/** Missing accounts return {}; limits and weights use the units in their field comments. */
export interface AccountNet {
  freeNetUsed?: number
  freeNetLimit?: number
  NetUsed?: number
  NetLimit?: bigint
  assetNetUsed?: KeyValue<number>[]
  assetNetLimit?: KeyValue<number>[]
  TotalNetLimit?: number
  /** Staked TRX, rather than sun. */
  TotalNetWeight?: bigint
}

export interface AccountResources extends AccountNet {
  EnergyUsed?: number
  EnergyLimit?: bigint
  TotalEnergyLimit?: number
  TotalEnergyWeight?: bigint
  tronPowerLimit?: bigint
  TotalTronPowerWeight?: bigint
}

export interface TronBlockHeader {
  raw_data: {
    number: number
    timestamp: number
    parentHash: string
    txTrieRoot: string
    witness_address: string
    /** Absent on genesis. */
    version?: number
    /** Present on genesis. */
    accountStateRoot?: string
  }
  witness_signature?: string
}

/** Full block query; transactions is present even when empty on the program path. */
export interface TronBlock {
  blockID: string
  block_header: TronBlockHeader
  transactions: TronTransaction[]
}

/** A missing block is {}; getblock also omits transactions unless detail:true. */
export interface BlockResult {
  blockID?: string
  block_header?: TronBlockHeader
  transactions?: TronTransaction[]
}

/** Range endpoints proto-print each block, omitting empty transactions and zero header fields. */
export interface BlockList {
  block?: {
    blockID?: string
    block_header?: { raw_data?: Partial<TronBlockHeader['raw_data']>; witness_signature?: string }
    transactions?: TronTransaction[]
  }[]
}

export interface ResourceReceipt {
  energy_usage?: bigint
  energy_fee?: bigint
  origin_energy_usage?: bigint
  energy_usage_total?: bigint
  net_fee?: bigint
  net_usage?: number
  result?: string
}

export interface TransactionLog {
  /** 20-byte hex by default; base58 with visible:true. */
  address: string
  topics: string[]
  data: string
}

export interface InternalTransaction {
  hash: string
  caller_address: string
  transferTo_address?: string
  /** Zero TRX is represented by an empty first entry. */
  callValueInfo: { callValue?: bigint; tokenId?: string }[]
  /** Hex-encoded call/create/suicide. */
  note: string
  rejected?: boolean
  data?: string
}

/** Unknown transaction IDs return {}; receipt amounts remain bigint on the program path. */
export interface TransactionInfo {
  id?: string
  blockNumber?: number
  blockTimeStamp?: number
  fee?: bigint
  result?: string
  contractResult?: string[]
  contract_address?: string
  receipt?: ResourceReceipt
  log?: TransactionLog[]
  resMessage?: string
  internal_transactions?: InternalTransaction[]
  assetIssueID?: string
  unfreeze_amount?: bigint
  withdraw_expire_amount?: bigint
  cancel_unfreezeV2_amount?: KeyValue<bigint>[]
}

export type BroadcastResult =
  | { result: true; txid: string; internal_transactions?: InternalTransaction[] }
  | { result: false; txid?: string; code: string; message: string }
  | RPCError

export interface BroadcastHexResult {
  result: boolean
  code: string
  /** Plain text, unlike broadcasttransaction's hexadecimal error message. */
  message: string
  /** JSON text of the protobuf transaction. */
  transaction: string
  txid: string
}

export interface SmartContract {
  origin_address?: string
  contract_address?: string
  abi?: { entrys?: AbiEntry[] }
  bytecode?: string
  consume_user_resource_percent?: number
  name?: string
  origin_energy_limit?: number
  code_hash?: string
  trx_hash?: string
  version?: number
}

export interface ContractInfo {
  runtimecode?: string
  smart_contract?: SmartContract
  contract_state?: { update_cycle?: number }
}

/** result.result signals a served request, including REVERT; inspect transaction.ret as well. */
export interface ContractCallResult {
  result?: { result?: boolean; code?: string; message?: string }
  transaction?: TronTransaction<'TriggerSmartContract' | 'CreateSmartContract'>
  constant_result?: string[]
  energy_used?: number
  energy_required?: number
  logs?: TransactionLog[]
  internal_transactions?: InternalTransaction[]
  Error?: string
}

/** Signature inspection echoes incomplete transactions, including contracts without an actuator. */
export interface TransactionEcho {
  txID: string
  raw_data_hex: string
  signature?: string[]
  raw_data: {
    /** Valid protocol contracts survive inspection even when this node cannot execute them. */
    contract: {
      type: string
      parameter: {
        type_url: string
        /** Empty payloads are omitted; fields depend on the supplied protocol contract. */
        value?: Record<string, unknown>
      }
      Permission_id?: number
      provider?: string
      ContractName?: string
    }[]
    ref_block_bytes?: string
    ref_block_num?: number
    ref_block_hash?: string
    /** Unix milliseconds; missing and zero-valued envelope fields are omitted. */
    expiration?: number
    timestamp?: number
    fee_limit?: number
    data?: string
    scripts?: string
    auths?: SignedTronTx['raw_data']['auths']
  }
}

export interface TransactionExtension {
  transaction: TransactionEcho
  txid: string
  result: { result: true }
}

export interface ApprovedList {
  approved_list?: string[]
  /** Empty object denotes success; failure carries code/message. */
  result: { code?: string; message?: string }
  /** Omitted when the signature count exceeds the configured maximum. */
  transaction?: TransactionExtension
}

export interface SignWeight extends ApprovedList {
  permission?: AccountPermission
  current_weight?: bigint
}

export interface DelegatedResource {
  from: string
  to: string
  frozen_balance_for_bandwidth?: bigint
  frozen_balance_for_energy?: bigint
  expire_time_for_bandwidth?: number
  expire_time_for_energy?: number
}

export interface DelegatedResourceIndex {
  account?: string
  fromAccounts?: string[]
  toAccounts?: string[]
}

/** Asset query fields; unlike transaction payload integers, stored int64 amounts remain bigint. */
export interface AssetIssue {
  owner_address?: string
  name?: string
  abbr?: string
  total_supply?: bigint
  frozen_supply?: { frozen_amount: bigint; frozen_days: number }[]
  trx_num?: number
  precision?: number
  num?: number
  start_time?: bigint
  end_time?: bigint
  order?: bigint
  vote_score?: number
  description?: string
  url?: string
  free_asset_net_limit?: number
  public_free_asset_net_limit?: number
  public_free_asset_net_usage?: number
  public_latest_free_net_time?: number
  id?: string
}

export interface AssetIssueList {
  /** Omitted when there are no matching assets. */
  assetIssue?: AssetIssue[]
}

export interface Witness {
  address: string
  voteCount?: number
  url: string
  totalProduced?: number
  latestBlockNum?: number
  latestSlotNum?: number
  isJobs?: boolean
}

export interface WitnessList {
  /** Omitted for an empty/out-of-range page. */
  witnesses?: Witness[]
}

export interface NodeInfo {
  beginSyncNum: number
  block: string
  solidityBlock: string
  currentConnectCount: number
  activeConnectCount: number
  passiveConnectCount: number
  totalFlow: number
  peerList: never[]
  configNodeInfo: {
    codeVersion: string
    versionNum: string
    p2pVersion: string
    listenPort: number
    discoverEnable: boolean
    activeNodeSize: number
    passiveNodeSize: number
    sendNodeSize: number
    maxConnectCount: number
    sameIpMaxConnectCount: number
    backupListenPort: number
    backupMemberSize: number
    backupPriority: number
    dbVersion: number
    minParticipationRate: number
    supportConstant: boolean
    minTimeRatio: number
    maxTimeRatio: number
    allowCreationOfContracts: number
    allowAdaptiveEnergy: number
  }
  machineInfo: {
    threadCount: number
    deadLockThreadCount: number
    cpuCount: number
    totalMemory: number
    freeMemory: number
    cpuRate: number
    javaVersion: string
    osName: string
    jvmTotalMemory: number
    jvmFreeMemory: number
    processCpuRate: number
    memoryDescInfoList: {
      name: string
      initSize: number
      useSize: number
      maxSize: number
      useRate: number
    }[]
    deadLockThreadInfoList: never[]
  }
  cheatWitnessInfoMap: EmptyResult
}
