import { visibleText, withVisibleAddresses } from '../visible.ts'

/**
 * Transactions leave this node through a protobuf printer, so their JSON keys
 * follow the proto field numbers rather than the order the request happened to
 * use. The tables below name that order for every message a transaction can
 * carry; a type with no table keeps whatever order it arrived in.
 */
const RAW_DATA_ORDER = [
  'ref_block_bytes',
  'ref_block_num',
  'ref_block_hash',
  'expiration',
  'auths',
  'data',
  'contract',
  'scripts',
  'timestamp',
  'fee_limit',
]

const TRANSACTION_ORDER = [
  'raw_data',
  // not part of the transaction: the deploy builder states the address the
  // contract will take, right after the body it derived it from
  'contract_address',
  'signature',
  'ret',
  'raw_data_hex',
  'txID',
  'visible',
]

// a printed contract states these three and nothing else, whatever the
// message holds
const CONTRACT_ORDER = ['parameter', 'type', 'provider', 'ContractName', 'Permission_id']

const SMART_CONTRACT_ORDER = [
  'origin_address',
  'contract_address',
  'abi',
  'bytecode',
  'call_value',
  'consume_user_resource_percent',
  'name',
  'origin_energy_limit',
  'code_hash',
  'trx_hash',
  'version',
]

const CONTRACT_VALUE_ORDER: Record<string, string[]> = {
  AccountCreateContract: ['owner_address', 'account_address', 'type'],
  ExchangeCreateContract: [
    'owner_address',
    'first_token_id',
    'first_token_balance',
    'second_token_id',
    'second_token_balance',
  ],
  ExchangeInjectContract: ['owner_address', 'exchange_id', 'token_id', 'quant'],
  ExchangeTransactionContract: ['owner_address', 'exchange_id', 'token_id', 'quant', 'expected'],
  ExchangeWithdrawContract: ['owner_address', 'exchange_id', 'token_id', 'quant'],
  MarketCancelOrderContract: ['owner_address', 'order_id'],
  MarketSellAssetContract: [
    'owner_address',
    'sell_token_id',
    'sell_token_quantity',
    'buy_token_id',
    'buy_token_quantity',
  ],
  ProposalApproveContract: ['owner_address', 'proposal_id', 'is_add_approval'],
  ProposalCreateContract: ['owner_address', 'parameters'],
  ProposalDeleteContract: ['owner_address', 'proposal_id'],
  ShieldedTransferContract: [
    'transparent_from_address',
    'from_amount',
    'spend_description',
    'receive_description',
    'binding_signature',
    'transparent_to_address',
    'to_amount',
  ],
  UpdateBrokerageContract: ['owner_address', 'brokerage'],
  WitnessCreateContract: ['owner_address', 'url'],
  WitnessUpdateContract: ['owner_address', 'update_url'],
  VoteWitnessContract: ['owner_address', 'votes', 'support'],
  WithdrawBalanceContract: ['owner_address'],
  AccountUpdateContract: ['account_name', 'owner_address'],
  SetAccountIdContract: ['account_id', 'owner_address'],
  TransferContract: ['owner_address', 'to_address', 'amount'],
  FreezeBalanceContract: [
    'owner_address',
    'frozen_balance',
    'frozen_duration',
    'resource',
    'receiver_address',
  ],
  UnfreezeBalanceContract: ['owner_address', 'resource', 'receiver_address'],
  TransferAssetContract: ['asset_name', 'owner_address', 'to_address', 'amount'],
  ParticipateAssetIssueContract: ['owner_address', 'to_address', 'asset_name', 'amount'],
  AssetIssueContract: [
    'owner_address',
    'name',
    'abbr',
    'total_supply',
    'frozen_supply',
    'trx_num',
    'precision',
    'num',
    'start_time',
    'end_time',
    'order',
    'vote_score',
    'description',
    'url',
    'free_asset_net_limit',
    'public_free_asset_net_limit',
    'public_free_asset_net_usage',
    'public_latest_free_net_time',
    'id',
  ],
  UnfreezeAssetContract: ['owner_address'],
  UpdateAssetContract: ['owner_address', 'description', 'url', 'new_limit', 'new_public_limit'],
  CreateSmartContract: ['owner_address', 'new_contract', 'call_token_value', 'token_id'],
  TriggerSmartContract: [
    'owner_address',
    'contract_address',
    'call_value',
    'data',
    'call_token_value',
    'token_id',
  ],
  UpdateSettingContract: ['owner_address', 'contract_address', 'consume_user_resource_percent'],
  UpdateEnergyLimitContract: ['owner_address', 'contract_address', 'origin_energy_limit'],
  ClearABIContract: ['owner_address', 'contract_address'],
  AccountPermissionUpdateContract: ['owner_address', 'owner', 'witness', 'actives'],
  FreezeBalanceV2Contract: ['owner_address', 'frozen_balance', 'resource'],
  UnfreezeBalanceV2Contract: ['owner_address', 'unfreeze_balance', 'resource'],
  WithdrawExpireUnfreezeContract: ['owner_address'],
  CancelAllUnfreezeV2Contract: ['owner_address'],
  DelegateResourceContract: [
    'owner_address',
    'resource',
    'balance',
    'receiver_address',
    'lock',
    'lock_period',
  ],
  UnDelegateResourceContract: ['owner_address', 'resource', 'balance', 'receiver_address'],
}

/** enum members by value, the spelling a printer states them in */
const ACCOUNT_TYPE = ['Normal', 'AssetIssue', 'Contract'] as const
const RESOURCE_CODE = ['BANDWIDTH', 'ENERGY', 'TRON_POWER'] as const
const PERMISSION_TYPE = ['Owner', 'Witness', 'Active'] as const

/** the enum fields a contract value carries */
const ENUM_FIELDS: Record<string, Record<string, readonly string[]>> = {
  AccountCreateContract: { type: ACCOUNT_TYPE },
  FreezeBalanceContract: { resource: RESOURCE_CODE },
  UnfreezeBalanceContract: { resource: RESOURCE_CODE },
  FreezeBalanceV2Contract: { resource: RESOURCE_CODE },
  UnfreezeBalanceV2Contract: { resource: RESOURCE_CODE },
  DelegateResourceContract: { resource: RESOURCE_CODE },
  UnDelegateResourceContract: { resource: RESOURCE_CODE },
}

/**
 * An enum field as a printer states it: by member name, and not at all at its
 * zero value. The request may have spelled it as the number or the name.
 */
function enumName(value: unknown, members: readonly string[]): string | undefined {
  const index =
    typeof value === 'number' || typeof value === 'bigint'
      ? Number(value)
      : /^\d+$/.test(String(value))
        ? Number(value)
        : members.indexOf(String(value))
  return index > 0 && index < members.length ? members[index] : undefined
}

const PERMISSION_ORDER = [
  'type',
  'id',
  'permission_name',
  'threshold',
  'parent_id',
  'operations',
  'keys',
]

/** a Permission message as printed: proto order, zero values left off */
function permissionPrint(value: unknown): unknown {
  if (!isRecord(value)) return value
  const out = ordered(value, PERMISSION_ORDER)
  const type = enumName(out.type, PERMISSION_TYPE)
  if (type === undefined) delete out.type
  else out.type = type
  if (Number(out.id ?? 0) === 0) delete out.id
  if (Number(out.parent_id ?? 0) === 0) delete out.parent_id
  if (out.operations === '' || out.operations === undefined) delete out.operations
  if (Array.isArray(out.keys)) {
    out.keys = out.keys.map((key) => (isRecord(key) ? ordered(key, ['address', 'weight']) : key))
  }
  return out
}

/** the fields a contract type declares, in proto order */
export function fieldsOf(type: string): readonly string[] {
  return CONTRACT_VALUE_ORDER[type] ?? []
}

/** the fields present in `value`, arranged the way `order` names them */
function ordered(value: Record<string, unknown>, order: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of order) {
    if (key in value) out[key] = value[key]
  }
  for (const key of Object.keys(value)) {
    if (!(key in out)) out[key] = value[key]
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contractValue(type: string, value: unknown): unknown {
  if (!isRecord(value)) return value
  const order = CONTRACT_VALUE_ORDER[type]
  const arranged = order === undefined ? { ...value } : ordered(value, order)
  // the builders carry empty bytes fields so the encoder sees what an absent
  // field merges to; a printer never puts a default on the wire
  for (const [key, entry] of Object.entries(arranged)) {
    if (entry === '') delete arranged[key]
  }
  for (const [key, members] of Object.entries(ENUM_FIELDS[type] ?? {})) {
    if (!(key in arranged)) continue
    const name = enumName(arranged[key], members)
    if (name === undefined) delete arranged[key]
    else arranged[key] = name
  }
  if (type === 'AccountPermissionUpdateContract') {
    for (const key of ['owner', 'witness']) {
      if (key in arranged) arranged[key] = permissionPrint(arranged[key])
    }
    if (Array.isArray(arranged.actives)) arranged.actives = arranged.actives.map(permissionPrint)
  }
  if (type === 'AssetIssueContract' && Array.isArray(arranged.frozen_supply)) {
    arranged.frozen_supply = arranged.frozen_supply.map((entry) =>
      isRecord(entry) ? ordered(entry, ['frozen_amount', 'frozen_days']) : entry,
    )
  }
  if (type === 'VoteWitnessContract' && Array.isArray(arranged.votes)) {
    arranged.votes = arranged.votes.map((entry) =>
      isRecord(entry) ? ordered(entry, ['vote_address', 'vote_count']) : entry,
    )
  }
  if (type === 'ProposalCreateContract' && Array.isArray(arranged.parameters)) {
    arranged.parameters = arranged.parameters.map((entry) =>
      isRecord(entry) ? ordered(entry, ['key', 'value']) : entry,
    )
  }
  if (type === 'ShieldedTransferContract') {
    if (Array.isArray(arranged.spend_description)) {
      arranged.spend_description = arranged.spend_description.map((entry) =>
        isRecord(entry)
          ? ordered(entry, [
              'value_commitment',
              'anchor',
              'nullifier',
              'rk',
              'zkproof',
              'spend_authority_signature',
            ])
          : entry,
      )
    }
    if (Array.isArray(arranged.receive_description)) {
      arranged.receive_description = arranged.receive_description.map((entry) =>
        isRecord(entry)
          ? ordered(entry, [
              'value_commitment',
              'note_commitment',
              'epk',
              'c_enc',
              'c_out',
              'zkproof',
            ])
          : entry,
      )
    }
  }
  if (isRecord(arranged.new_contract)) {
    const contract = ordered(arranged.new_contract, SMART_CONTRACT_ORDER)
    for (const [key, entry] of Object.entries(contract)) {
      if (entry === '') delete contract[key]
    }
    if (isRecord(contract.abi) && Array.isArray(contract.abi.entrys)) {
      // the abi is a message the record always sets, but an empty entry list is
      // a repeated field at its default and prints as nothing
      contract.abi =
        contract.abi.entrys.length === 0 ? {} : { entrys: abiEntries(contract.abi.entrys) }
    }
    arranged.new_contract = contract
  }
  return arranged
}

/** the `SmartContract.ABI.Entry` enums, whose members are named in TitleCase */
const ENTRY_TYPES: Record<string, string> = {
  constructor: 'Constructor',
  function: 'Function',
  event: 'Event',
  fallback: 'Fallback',
  receive: 'Receive',
  error: 'Error',
}

const MUTABILITY_TYPES: Record<string, string> = {
  pure: 'Pure',
  view: 'View',
  nonpayable: 'Nonpayable',
  payable: 'Payable',
}

const ENTRY_ORDER = [
  'anonymous',
  'constant',
  'name',
  'inputs',
  'outputs',
  'type',
  'payable',
  'stateMutability',
]

/** an abi parameter: `indexed`, `name`, `type`, minus whatever is at default */
function abiParam(param: unknown): unknown {
  if (!isRecord(param)) return param
  const out: Record<string, unknown> = {}
  if (param.indexed === true) out.indexed = true
  if (typeof param.name === 'string' && param.name !== '') out.name = param.name
  if (param.type !== undefined) out.type = param.type
  return out
}

/**
 * An abi as the contract record holds it. The JSON form solidity emits names
 * its enums in lower case and lists empty parameter arrays; the stored message
 * has enum members and drops what is at default.
 */
export function abiEntries(entries: unknown[]): unknown[] {
  return entries.map((entry) => {
    if (!isRecord(entry)) return entry
    const out: Record<string, unknown> = { ...entry }
    const type = String(entry.type ?? '').toLowerCase()
    if (ENTRY_TYPES[type] !== undefined) out.type = ENTRY_TYPES[type]
    const mutability = String(entry.stateMutability ?? '').toLowerCase()
    if (MUTABILITY_TYPES[mutability] !== undefined)
      out.stateMutability = MUTABILITY_TYPES[mutability]
    for (const key of ['inputs', 'outputs']) {
      const params = out[key]
      if (Array.isArray(params)) {
        if (params.length === 0) delete out[key]
        else out[key] = params.map(abiParam)
      }
    }
    if (out.anonymous !== true) delete out.anonymous
    if (out.constant !== true) delete out.constant
    if (out.payable !== true) delete out.payable
    if (out.name === '') delete out.name
    return ordered(out, ENTRY_ORDER)
  })
}

/** a transaction as the protobuf printer lays it out, keys and all */
export function printTransaction<T extends Record<string, unknown>>(tx: T): T {
  const out: Record<string, unknown> = { ...tx }
  if (isRecord(out.raw_data)) {
    const raw = ordered(out.raw_data, RAW_DATA_ORDER)
    if (Array.isArray(raw.contract)) {
      raw.contract = raw.contract.map((entry) => {
        if (!isRecord(entry)) return entry
        const arranged = ordered(entry, CONTRACT_ORDER)
        // Util.printTransactionToJSON omits nonpositive IDs only in the JSON echo.
        if (typeof arranged.Permission_id === 'number' && arranged.Permission_id <= 0) {
          delete arranged.Permission_id
        }
        if (isRecord(arranged.parameter)) {
          arranged.parameter = ordered(
            {
              ...arranged.parameter,
              value: contractValue(String(entry.type ?? ''), arranged.parameter.value),
            },
            ['value', 'type_url'],
          )
        }
        return arranged
      })
    }
    out.raw_data = raw
  }
  return ordered(out, TRANSACTION_ORDER) as T
}

const VISIBLE_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // `abbr` and `description` are covered by NAME_FIELDS in visible.ts.
  // These entries cannot be handled there because their leaf names also
  // occur as ordinary string fields in unrelated protobuf messages.
  AssetIssueContract: ['name', 'url'],
  UpdateAssetContract: ['url'],
}

/** Print a stored transaction in the address and text form the caller requested. */
export function formatTransaction<T>(transaction: T, visible: boolean): T {
  if (!visible || transaction === null || typeof transaction !== 'object') return transaction
  const formatted = withVisibleAddresses(transaction, true) as T & {
    raw_data?: {
      contract?: { type?: string; parameter?: { value?: Record<string, unknown> } }[]
      auths?: { permission_name?: unknown; account?: { name?: unknown } }[]
    }
  }
  for (const contract of formatted.raw_data?.contract ?? []) {
    const fields = VISIBLE_TEXT_FIELDS[contract.type ?? '']
    const value = contract.parameter?.value
    if (fields === undefined || value === undefined) continue
    for (const field of fields) value[field] = visibleText(value[field])
  }
  for (const authority of formatted.raw_data?.auths ?? []) {
    if (authority.permission_name !== undefined) {
      authority.permission_name = visibleText(authority.permission_name)
    }
    if (authority.account?.name !== undefined) {
      authority.account.name = visibleText(authority.account.name)
    }
  }
  return formatted
}
