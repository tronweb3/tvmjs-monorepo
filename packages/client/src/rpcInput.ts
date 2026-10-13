import type { IntegerInput } from './input.ts'

export type ResourceCode = 'BANDWIDTH' | 'ENERGY' | 'TRON_POWER'
export type AccountType = 'Normal' | 'AssetIssue' | 'Contract'
export type PermissionType = 'Owner' | 'Witness' | 'Active'

/** Wallet formatting options. Raw transaction/common-builder inputs follow their own notes. */
export interface WalletParams {
  /** Default: false. Return addresses as base58 when true, hex otherwise. */
  visible?: boolean
}

export interface AddressParams extends WalletParams {
  /** Omitted or empty addresses produce an empty/default query result. */
  address?: string
}

export interface ValueParams extends WalletParams {
  /** Transaction/block hash, asset ID/name, or address, as documented by the method. */
  value?: string
}

/** With visible:true the name is text and must be present; otherwise omission queries empty bytes. */
export type AssetNameParams =
  | (WalletParams & { value: string })
  | { visible?: false; value?: string }

export interface BlockParams extends WalletParams {
  /** Decimal height or block hash. Omit to read the head block. */
  id_or_num?: string
  /** Include transactions. Default: false. */
  detail?: boolean
}

export interface NumberParams extends WalletParams {
  num: IntegerInput
}

export interface BlockRangeParams extends WalletParams {
  /** Inclusive height. The range must contain at most 100 blocks. */
  startNum: IntegerInput
  /** Exclusive height. */
  endNum: IntegerInput
}

/** Both bounds are required by the program API; a nonpositive limit returns no rows. */
export interface PaginationParams extends WalletParams {
  offset: IntegerInput
  /** Asset and witness pages are capped at 1,000 rows. */
  limit: IntegerInput
}

export interface DelegationParams extends WalletParams {
  fromAddress?: string
  toAddress?: string
}

export interface OwnerQueryParams extends WalletParams {
  owner_address?: string
}

export interface MarketPairParams extends WalletParams {
  /** Token ID or "_" for TRX; hex-encoded unless visible is true. */
  sell_token_id: string
  /** Token ID or "_" for TRX; hex-encoded unless visible is true. */
  buy_token_id: string
}

export interface BuilderOptions extends WalletParams {
  /** Active permission ID. Omitted/zero selects the owner permission. */
  Permission_id?: IntegerInput
}

/** Protobuf permission input. Omitted scalar fields take their protobuf defaults. */
export interface PermissionInput {
  type?: PermissionType | 0 | 1 | 2
  id?: IntegerInput
  permission_name?: string
  threshold?: IntegerInput
  parent_id?: IntegerInput
  /** 32-byte hexadecimal operation bitmap for an Active permission. */
  operations?: string
  keys?: readonly { address?: string; weight?: IntegerInput }[]
}

/** Solidity ABI JSON is accepted in both compiler and TRON spelling. */
export interface AbiParameter {
  name?: string
  type?: string
  indexed?: boolean
  internalType?: string
  components?: readonly AbiParameter[]
}

export interface AbiEntry {
  anonymous?: boolean
  constant?: boolean
  name?: string
  inputs?: readonly AbiParameter[]
  outputs?: readonly AbiParameter[]
  type?: string
  payable?: boolean
  stateMutability?: string
}

export interface SmartContractInput {
  origin_address?: string
  contract_address?: string
  abi?: { entrys?: readonly AbiEntry[] }
  bytecode?: string
  call_value?: IntegerInput
  consume_user_resource_percent?: IntegerInput
  name?: string
  origin_energy_limit?: IntegerInput
  code_hash?: string
  trx_hash?: string
  version?: IntegerInput
}

/** Optional numeric issuance fields default to zero; omitted byte fields default to empty. */
export interface AssetIssueParams extends BuilderOptions {
  owner_address: string
  /** Hex bytes by default; text with visible:true. */
  name: string
  /** Hex bytes by default; text with visible:true. */
  abbr?: string
  total_supply: IntegerInput
  frozen_supply?: readonly { frozen_amount: IntegerInput; frozen_days: IntegerInput }[]
  trx_num: IntegerInput
  num: IntegerInput
  /** Decimal places, 0–6. Default: 0. */
  precision?: IntegerInput
  /** Unix milliseconds. */
  start_time: IntegerInput
  /** Unix milliseconds, after start_time. */
  end_time: IntegerInput
  order?: IntegerInput
  vote_score?: IntegerInput
  /** Hex bytes by default; text with visible:true. */
  description?: string
  /** Hex bytes by default; text with visible:true. */
  url: string
  free_asset_net_limit?: IntegerInput
  public_free_asset_net_limit?: IntegerInput
  public_free_asset_net_usage?: IntegerInput
  public_latest_free_net_time?: IntegerInput
  id?: string
}

export interface TransferParams extends BuilderOptions {
  owner_address: string
  to_address: string
  /** Positive amount in sun (1 TRX = 1,000,000 sun). */
  amount: IntegerInput
  /** Optional memo: hex by default, text with visible:true. */
  extra_data?: string
}

export interface AssetTransferParams extends Omit<TransferParams, 'extra_data'> {
  /** Hex-encoded asset ID/name, or plain text with visible:true. */
  asset_name: string
  /** Positive token amount in the asset's smallest units. */
  amount: IntegerInput
}

export interface ParticipateAssetIssueParams extends AssetTransferParams {
  /** TRX paid to the issuer in sun; tokens received follow the issuance's trx_num/num ratio. */
  amount: IntegerInput
}

export interface OwnerParams extends BuilderOptions {
  owner_address: string
}

export interface ContractOwnerParams extends OwnerParams {
  contract_address: string
}

export interface FreezeParams extends OwnerParams {
  /** At least 1,000,000 sun. */
  frozen_balance: IntegerInput
  /** Default: BANDWIDTH. TRON_POWER also requires the new-resource-model gate. */
  resource?: ResourceCode | 0 | 1 | 2
}

export interface UnfreezeParams extends OwnerParams {
  /** Default: BANDWIDTH. */
  resource?: ResourceCode | 0 | 1 | 2
}

export interface DelegateParams extends OwnerParams {
  receiver_address: string
  /** Amount in sun. */
  balance: IntegerInput
  /** Default: BANDWIDTH. */
  resource?: 'BANDWIDTH' | 'ENERGY' | 0 | 1
}

export interface ContractCallParams extends ContractOwnerParams {
  /** Function signature, e.g. transfer(address,uint256); takes precedence over data. */
  function_selector?: string
  /** ABI-encoded arguments, hex without the function selector. Default: empty. */
  parameter?: string
  /** Complete calldata in hex; used when function_selector is absent. */
  data?: string
  /** TRX sent to the contract, in sun. Default: 0. */
  call_value?: IntegerInput
  /** TRC-10 amount. Default: 0. */
  call_token_value?: IntegerInput
  /** TRC-10 token ID. Default: 0. */
  token_id?: IntegerInput
  /** Fee budget in sun for triggersmartcontract. Default: 0. Constant/estimate ignore it. */
  fee_limit?: IntegerInput
  /** Used by constant-call transaction echoes; ignored by ordinary trigger construction. */
  extra_data?: string
}

/** An absent contract address plus init code simulates a deployment. */
export type ConstantCallParams =
  | ContractCallParams
  | (Omit<ContractCallParams, 'contract_address' | 'data' | 'function_selector'> & {
      contract_address?: ''
      data: string
      function_selector?: never
    })

export interface DeployContractParams extends BuilderOptions {
  /** Omit to construct an unsigned skeleton; broadcasting requires a valid owner. */
  owner_address?: string
  /** Creation bytecode in hex. Default: empty code; constructor parameters are appended. */
  bytecode?: string
  parameter?: string
  /** ABI array or its JSON text. Default: empty ABI. */
  abi?: readonly AbiEntry[] | string
  name?: string
  call_value?: IntegerInput
  call_token_value?: IntegerInput
  token_id?: IntegerInput
  /** Caller share, 0–100. Default: 0. */
  consume_user_resource_percent?: IntegerInput
  /** Creator energy limit. Default: 0; deployment broadcast requires a positive value. */
  origin_energy_limit?: IntegerInput
  /** Fee budget in sun. Default: 0. */
  fee_limit?: IntegerInput
}

/** Contract payloads accepted by createCommonTransaction and transaction envelopes. */
export interface ContractInputMap {
  TransferContract: Omit<TransferParams, keyof BuilderOptions | 'extra_data'>
  TransferAssetContract: Omit<AssetTransferParams, keyof BuilderOptions>
  ParticipateAssetIssueContract: Omit<ParticipateAssetIssueParams, keyof BuilderOptions>
  AccountCreateContract: {
    owner_address: string
    account_address: string
    type?: AccountType | 0 | 1 | 2
  }
  AccountUpdateContract: { owner_address: string; account_name?: string | null }
  SetAccountIdContract: { owner_address: string; account_id: string }
  AccountPermissionUpdateContract: {
    owner_address: string
    owner?: PermissionInput
    witness?: PermissionInput
    actives?: readonly PermissionInput[]
  }
  AssetIssueContract: Omit<AssetIssueParams, keyof BuilderOptions>
  UnfreezeAssetContract: { owner_address: string }
  UpdateAssetContract: {
    owner_address: string
    description?: string
    url: string
    new_limit?: IntegerInput
    new_public_limit?: IntegerInput
  }
  CreateSmartContract: {
    owner_address: string
    new_contract: SmartContractInput
    call_token_value?: IntegerInput
    token_id?: IntegerInput
  }
  TriggerSmartContract: {
    owner_address: string
    contract_address: string
    data?: string
    call_value?: IntegerInput
    call_token_value?: IntegerInput
    token_id?: IntegerInput
  }
  ClearABIContract: { owner_address: string; contract_address: string }
  UpdateSettingContract: {
    owner_address: string
    contract_address: string
    consume_user_resource_percent?: IntegerInput
  }
  UpdateEnergyLimitContract: {
    owner_address: string
    contract_address: string
    origin_energy_limit: IntegerInput
  }
  FreezeBalanceContract: Omit<FreezeParams, keyof BuilderOptions> & {
    /** Days; checked against the configured minimum and maximum. */
    frozen_duration: IntegerInput
    /** Omit to freeze for the owner; otherwise delegate legacy stake. */
    receiver_address?: string
  }
  UnfreezeBalanceContract: Omit<UnfreezeParams, keyof BuilderOptions> & {
    receiver_address?: string
  }
  FreezeBalanceV2Contract: Omit<FreezeParams, keyof BuilderOptions>
  UnfreezeBalanceV2Contract: Omit<UnfreezeParams, keyof BuilderOptions> & {
    unfreeze_balance: IntegerInput
  }
  WithdrawExpireUnfreezeContract: { owner_address: string }
  CancelAllUnfreezeV2Contract: { owner_address: string }
  DelegateResourceContract: Omit<DelegateParams, keyof BuilderOptions> & {
    /** Lock the delegated resources. Omitted means unlocked. */
    lock?: boolean
    /** Blocks of 3 seconds. Omitted/zero uses 86,400 blocks when locked. */
    lock_period?: IntegerInput
  }
  UnDelegateResourceContract: Omit<DelegateParams, keyof BuilderOptions>
}

export type ContractName = keyof ContractInputMap
export type BuilderParams<C extends ContractName> = ContractInputMap[C] & BuilderOptions
/** Raw contract fields: addresses must match visible, and integer strings use decimal notation. */
export type CommonTransactionParams = {
  [C in ContractName]: BuilderParams<C> & { contractType: C }
}[ContractName]

/**
 * Raw transactions may be incomplete for signature inspection or validation.
 * Nested values follow protobuf encodings, including decimal integer text and addresses
 * matching visible. They do not use the ordinary builder's input normalization.
 */
export interface TransactionInput extends WalletParams {
  txID?: string
  raw_data_hex?: string
  signature?: readonly string[]
  raw_data?: {
    contract?: readonly {
      type?: string
      /** Use ContractInputMap to author known payloads; externally supplied payloads stay open. */
      parameter?: { type_url?: string; value?: object }
      Permission_id?: IntegerInput
      provider?: string
      ContractName?: string
    }[]
    ref_block_bytes?: string
    ref_block_num?: IntegerInput
    ref_block_hash?: string
    expiration?: IntegerInput
    timestamp?: IntegerInput
    fee_limit?: IntegerInput
    data?: string
    scripts?: string
    auths?: readonly { permission_name?: string; account?: { name?: string; address?: string } }[]
  }
}
