import type { NodeAccounts } from './accounts.ts'
import type { TemporaryAccountsOptions } from './development/admin.ts'
import type { StorageRange, TransactionTrace } from './development/debug.ts'
import type { BytesInput, IntegerInput } from './input.ts'
import type {
  AddressParams,
  AssetIssueParams,
  AssetNameParams,
  AssetTransferParams,
  BlockParams,
  BlockRangeParams,
  BuilderParams,
  CommonTransactionParams,
  ConstantCallParams,
  ContractCallParams,
  ContractName,
  DelegationParams,
  DeployContractParams,
  MarketPairParams,
  NumberParams,
  OwnerQueryParams,
  PaginationParams,
  ParticipateAssetIssueParams,
  TransactionInput,
  TransferParams,
  ValueParams,
  WalletParams,
} from './rpcInput.ts'
import type {
  AccountNet,
  AccountResources,
  ApprovedList,
  AssetIssue,
  AssetIssueList,
  BlockList,
  BlockResult,
  BroadcastHexResult,
  BroadcastResult,
  ContractCallResult,
  ContractInfo,
  DelegatedResource,
  DelegatedResourceIndex,
  EmptyResult,
  NodeInfo,
  RPCError,
  SignWeight,
  SmartContract,
  TransactionBuildResult,
  TransactionInfo,
  TronAccount,
  TronBlock,
  TronTransaction,
  WitnessList,
} from './rpcTypes.ts'

export type * from './rpcInput.ts'
export type * from './rpcTypes.ts'

type Entry<P, R> = { params: P; result: R }
type EmptyParams = WalletParams | undefined
type Query<P> = P | undefined
type Build<C extends ContractName> = Entry<BuilderParams<C>, TransactionBuildResult<C>>

/** Program API contracts, before HTTP serialization. Rejections may also throw/reject. */
interface BaseRPCMethods {
  'wallet/getnowblock': Entry<EmptyParams, TronBlock>
  'wallet/getblock': Entry<Query<BlockParams>, BlockResult>
  /** Missing num selects genesis (height 0). */
  'wallet/getblockbynum': Entry<Query<Partial<NumberParams>>, Partial<TronBlock>>
  'wallet/getblockbyid': Entry<Query<ValueParams>, Partial<TronBlock>>
  'wallet/getblockbylimitnext': Entry<BlockRangeParams, BlockList>
  /** num must be between 1 and 99; otherwise the result is {}. */
  'wallet/getblockbylatestnum': Entry<NumberParams, BlockList>
  'wallet/getaccount': Entry<Query<AddressParams>, TronAccount>
  /** account_id is hex bytes, or text with visible:true. */
  'wallet/getaccountbyid': Entry<Query<WalletParams & { account_id?: string }>, TronAccount>
  'wallet/getaccountresource': Entry<Query<AddressParams>, AccountResources>
  'wallet/getaccountnet': Entry<Query<AddressParams>, AccountNet>
  'wallet/getsignweight': Entry<TransactionInput, SignWeight>
  'wallet/getapprovedlist': Entry<TransactionInput, ApprovedList>
  'wallet/getdelegatedresource': Entry<
    Query<DelegationParams>,
    { delegatedResource?: DelegatedResource[] }
  >
  'wallet/getdelegatedresourcev2': Entry<
    Query<DelegationParams>,
    { delegatedResource?: DelegatedResource[] }
  >
  /** value is the account address. */
  'wallet/getdelegatedresourceaccountindex': Entry<Query<ValueParams>, DelegatedResourceIndex>
  'wallet/getdelegatedresourceaccountindexv2': Entry<Query<ValueParams>, DelegatedResourceIndex>
  /** type: 0 = BANDWIDTH (default), 1 = ENERGY; max_size is sun. */
  'wallet/getcandelegatedmaxsize': Entry<
    Query<OwnerQueryParams & { type?: IntegerInput }>,
    { max_size?: bigint }
  >
  'wallet/getavailableunfreezecount': Entry<
    Query<
      OwnerQueryParams & {
        /** Legacy alias; unlike owner_address, its address encoding must match visible. */
        ownerAddress?: string
      }
    >,
    { count?: number }
  >
  /** timestamp is Unix milliseconds; omitted/zero uses the head block time. amount is sun. */
  'wallet/getcanwithdrawunfreezeamount': Entry<
    Query<OwnerQueryParams & { timestamp?: IntegerInput }>,
    { amount?: bigint }
  >
  'wallet/getReward': Entry<Query<AddressParams>, { reward: bigint } | RPCError>
  'wallet/getBrokerage': Entry<Query<AddressParams>, { brokerage: number } | RPCError>
  /** This chain's proposal/exchange/market lists return empty objects. */
  'wallet/listproposals': Entry<EmptyParams, EmptyResult>
  /** Decimal ID; this handler does not accept 0x integer strings. */
  'wallet/getproposalbyid': Entry<{ id: IntegerInput }, EmptyResult>
  'wallet/getpaginatedproposallist': Entry<PaginationParams, EmptyResult>
  'wallet/listexchanges': Entry<EmptyParams, EmptyResult>
  /** Always rejects: this chain has no exchange store. */
  'wallet/getexchangebyid': Entry<{ id: IntegerInput }, never>
  'wallet/getpaginatedexchangelist': Entry<PaginationParams, EmptyResult>
  'wallet/getmarketpairlist': Entry<EmptyParams, EmptyResult>
  'wallet/getmarketorderbyaccount': Entry<Query<ValueParams>, EmptyResult>
  /** Nonempty IDs reject because this chain has no market order store. */
  'wallet/getmarketorderbyid': Entry<Query<ValueParams>, EmptyResult>
  'wallet/getmarketorderlistbypair': Entry<MarketPairParams, EmptyResult>
  'wallet/getmarketpricebypair': Entry<
    MarketPairParams,
    { sell_token_id: string; buy_token_id: string }
  >
  'wallet/totaltransaction': Entry<EmptyParams, EmptyResult>
  'wallet/getburntrx': Entry<EmptyParams, { burnTrxAmount: bigint }>
  'wallet/validateaddress': Entry<
    Query<{ address?: string | null }>,
    { result: boolean; message: string }
  >
  /** value is the decimal asset ID as text, not hex-encoded bytes. */
  'wallet/getassetissuebyid': Entry<Query<ValueParams>, AssetIssue>
  /** value is hex-encoded name bytes, or plain text with visible:true. */
  'wallet/getassetissuebyname': Entry<Query<AssetNameParams>, AssetIssue>
  'wallet/getassetissuelistbyname': Entry<Query<AssetNameParams>, AssetIssueList>
  'wallet/getassetissuebyaccount': Entry<Query<AddressParams>, AssetIssueList>
  'wallet/getassetissuelist': Entry<EmptyParams, AssetIssueList>
  'wallet/getpaginatedassetissuelist': Entry<PaginationParams, AssetIssueList>
  'wallet/triggersmartcontract': Entry<ContractCallParams, ContractCallResult>
  'wallet/triggerconstantcontract': Entry<ConstantCallParams, ContractCallResult>
  'wallet/estimateenergy': Entry<ConstantCallParams, ContractCallResult>
  /** value is the contract address. */
  'wallet/getcontract': Entry<Query<ValueParams>, SmartContract>
  'wallet/getcontractinfo': Entry<Query<ValueParams>, ContractInfo>
  'wallet/getpendingsize': Entry<EmptyParams, { pendingSize: number }>
  'wallet/gettransactionlistfrompending': Entry<EmptyParams, { txId?: string[] }>
  'wallet/gettransactionfrompending': Entry<
    ValueParams & { value: string },
    Partial<TronTransaction>
  >
  'wallet/gettransactionbyid': Entry<Query<ValueParams>, Partial<TronTransaction>>
  'wallet/gettransactioninfobyid': Entry<Query<ValueParams>, TransactionInfo>
  'wallet/gettransactionreceiptbyid': Entry<
    Query<ValueParams>,
    { Receipt?: TransactionInfo['receipt'] }
  >
  /** Heights <= 0 return {}; absent positive heights return an empty array. */
  'wallet/gettransactioninfobyblocknum': Entry<NumberParams, TransactionInfo[] | EmptyResult>
  'wallet/gettransactioncountbyblocknum': Entry<NumberParams, { count: number }>
  'wallet/getnodeinfo': Entry<EmptyParams, NodeInfo>
  'wallet/listnodes': Entry<EmptyParams, { nodes: never[] }>
  'net/listnodes': Entry<EmptyParams, { nodes: never[] }>
  'wallet/listwitnesses': Entry<EmptyParams, Required<WitnessList>>
  'wallet/getpaginatednowwitnesslist': Entry<PaginationParams, WitnessList>
  'wallet/getchainparameters': Entry<
    EmptyParams,
    { chainParameter: { key: string; value: number | bigint }[] }
  >
  'wallet/getnextmaintenancetime': Entry<EmptyParams, { num: number }>
  /** prices is "timestamp:price" history; this chain reports its genesis price only. */
  'wallet/getenergyprices': Entry<EmptyParams, { prices: string }>
  'wallet/getbandwidthprices': Entry<EmptyParams, { prices: string }>
  'wallet/getmemofee': Entry<EmptyParams, { prices: string }>
  'wallet/broadcasttransaction': Entry<TransactionInput, BroadcastResult>
  'wallet/broadcasthex': Entry<{ transaction: string }, BroadcastHexResult>
  'wallet/createtransaction': Entry<TransferParams, TransactionBuildResult<'TransferContract'>>
  'wallet/deploycontract': Entry<
    Query<DeployContractParams>,
    TransactionBuildResult<'CreateSmartContract'>
  >
  'wallet/createassetissue': Entry<AssetIssueParams, TransactionBuildResult<'AssetIssueContract'>>
  'wallet/transferasset': Entry<
    AssetTransferParams & { extra_data?: string },
    TransactionBuildResult<'TransferAssetContract'>
  >
  'wallet/participateassetissue': Entry<
    ParticipateAssetIssueParams,
    TransactionBuildResult<'ParticipateAssetIssueContract'>
  >
  'wallet/unfreezeasset': Build<'UnfreezeAssetContract'>
  'wallet/accountpermissionupdate': Build<'AccountPermissionUpdateContract'>
  'wallet/updatesetting': Build<'UpdateSettingContract'>
  'wallet/updateenergylimit': Build<'UpdateEnergyLimitContract'>
  'wallet/clearabi': Build<'ClearABIContract'>
  'wallet/updateasset': Build<'UpdateAssetContract'>
  'wallet/updateaccount': Build<'AccountUpdateContract'>
  'wallet/setaccountid': Build<'SetAccountIdContract'>
  'wallet/createaccount': Build<'AccountCreateContract'>
  'wallet/createCommonTransaction': Entry<CommonTransactionParams, TransactionBuildResult>
  'wallet/freezebalancev2': Build<'FreezeBalanceV2Contract'>
  'wallet/unfreezebalancev2': Build<'UnfreezeBalanceV2Contract'>
  'wallet/withdrawexpireunfreeze': Build<'WithdrawExpireUnfreezeContract'>
  'wallet/cancelallunfreezev2': Build<'CancelAllUnfreezeV2Contract'>
  'wallet/delegateresource': Build<'DelegateResourceContract'>
  'wallet/undelegateresource': Build<'UnDelegateResourceContract'>
  'wallet/freezebalance': Build<'FreezeBalanceContract'>
  'wallet/unfreezebalance': Build<'UnfreezeBalanceContract'>
  /** Omit params (or pass []) to mine one block; blocks must be 1–100. */
  tre_mine: Entry<readonly [] | readonly [{ blocks: IntegerInput }] | undefined, string>
  /** Advance by seconds and mine a block; returns Unix milliseconds. */
  tre_increaseTime: Entry<readonly [seconds: IntegerInput], number>
  /** Seconds, 0–60. Zero selects instant mining. */
  tre_blockTime: Entry<readonly [seconds: IntegerInput], true>
  tre_setAccountBalance: Entry<readonly [address: string, balanceSun: IntegerInput], true>
  tre_setAccountCode: Entry<readonly [address: string, code: BytesInput], true>
  tre_setAccountStorageAt: Entry<
    readonly [address: string, slot: BytesInput, value: BytesInput],
    true
  >
  tre_unlockedAccounts: Entry<readonly [addresses: string | readonly string[]], true>
  debug_traceTransaction: Entry<readonly [txid: string], TransactionTrace>
  debug_storageRangeAt: Entry<
    readonly [
      block: string | number | bigint | null,
      txIndex: IntegerInput,
      address: string,
      startKey: string | null,
      limit: IntegerInput,
    ],
    StorageRange
  >
  admin: Entry<EmptyParams, string>
  'admin/': Entry<EmptyParams, string>
  /** format defaults to base58. */
  'admin/accounts': Entry<Query<{ format?: 'base58' | 'hex' | 'all' }>, string>
  'admin/accounts-json': Entry<EmptyParams, NodeAccounts>
  'admin/temporary-accounts-generation': Entry<TemporaryAccountsOptions | undefined, string>
  'admin/accounts-generation': Entry<EmptyParams, string>
  /** Program requests return plain text; media negotiation belongs to HTTP. */
  healthcheck: Entry<EmptyParams, string>
}

/** Exactly the 41 registered confirmed-state routes, including its separate witness pager. */
type SolidityMethod =
  | 'getnowblock'
  | 'getblock'
  | 'getblockbynum'
  | 'getblockbyid'
  | 'getblockbylimitnext'
  | 'getblockbylatestnum'
  | 'getaccount'
  | 'getaccountbyid'
  | 'getdelegatedresource'
  | 'getdelegatedresourcev2'
  | 'getdelegatedresourceaccountindex'
  | 'getdelegatedresourceaccountindexv2'
  | 'getcandelegatedmaxsize'
  | 'getavailableunfreezecount'
  | 'getcanwithdrawunfreezeamount'
  | 'getReward'
  | 'getBrokerage'
  | 'listexchanges'
  | 'getexchangebyid'
  | 'getmarketpairlist'
  | 'getmarketorderbyaccount'
  | 'getmarketorderbyid'
  | 'getmarketorderlistbypair'
  | 'getmarketpricebypair'
  | 'getburntrx'
  | 'getassetissuebyid'
  | 'getassetissuebyname'
  | 'getassetissuelistbyname'
  | 'getassetissuelist'
  | 'getpaginatedassetissuelist'
  | 'triggerconstantcontract'
  | 'estimateenergy'
  | 'gettransactionbyid'
  | 'gettransactioninfobyid'
  | 'gettransactioninfobyblocknum'
  | 'gettransactioncountbyblocknum'
  | 'getnodeinfo'
  | 'listwitnesses'
  | 'getpaginatednowwitnesslist'
  | 'getenergyprices'
  | 'getbandwidthprices'

type SolidityRPCMethods = {
  [M in SolidityMethod as `walletsolidity/${M}`]: BaseRPCMethods[`wallet/${M}`]
}

/** All registered requests; unregistered/dynamic method names retain unknown results. */
export interface RPCMethods extends BaseRPCMethods, SolidityRPCMethods {}

export type ProviderParams = object | readonly unknown[]
/**
 * Parameters for a literal method name; dynamic names accept generic request objects.
 * When extracting common-builder params into a variable, use `satisfies` to validate
 * the payload and preserve the literal `contractType`; otherwise it widens to `string`.
 * `as const` also preserves the literal, but does not validate the payload by itself.
 *
 * @example
 * ```ts
 * import type { ProviderMethodParams } from '@tvmjs/client'
 *
 * const params = {
 *   contractType: 'TransferContract',
 *   owner_address: ownerAddress,
 *   to_address: recipientAddress,
 *   amount: 1,
 * } satisfies ProviderMethodParams<'wallet/createCommonTransaction'>
 *
 * const transaction = await provider.request({ method: 'wallet/createCommonTransaction', params })
 * ```
 */
export type ProviderMethodParams<M extends string> = M extends keyof RPCMethods
  ? RPCMethods[M]['params']
  : ProviderParams | undefined
/** D narrows a string discriminator such as contractType; omit it to retain all variants. */
export type ProviderResult<
  M extends string,
  D extends string = string,
> = M extends 'wallet/createCommonTransaction'
  ? TransactionBuildResult<D & ContractName>
  : M extends keyof RPCMethods
    ? RPCMethods[M]['result']
    : unknown

type RequestParams<M extends string, D extends string> = ProviderMethodParams<M> &
  (M extends 'wallet/createCommonTransaction' ? { contractType: D } : unknown)

export type ProviderRequest<M extends string = string, D extends string = string> = {
  /** REST path (wallet/getaccount) or development method (tre_*, debug_*, admin/*). */
  method: M
} & (undefined extends ProviderMethodParams<NoInfer<M>>
  ? { params?: RequestParams<NoInfer<M>, D> }
  : { params: RequestParams<NoInfer<M>, D> })
