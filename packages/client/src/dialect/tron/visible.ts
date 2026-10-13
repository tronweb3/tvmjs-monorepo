import { TronWeb } from 'tronweb'

/**
 * Response-side `visible=true` conversion. The protobuf JSON printer converts
 * keyed on `message.field`, knowing each field's
 * type; a deep walk only sees the leaf name, so the tables below are the
 * projection of the self-format field set onto leaf names, **restricted to
 * names that are unambiguous across every `.proto`**.
 *
 * Seven name-table entries are deliberately absent — `name`, `url`, `message`,
 * `token_id`, `ContractName`, `host`, `permission_name` — because the same leaf
 * name also names a plain string field elsewhere (`SmartContract.name`,
 * `Witness.url`, …) that is never converted. Converting by leaf name
 * would corrupt those. Endpoints that own such a field convert it themselves.
 *
 * `asset_issued_ID` is absent for the opposite reason: the account printer
 * decodes it whether or not `visible` is set, so it reaches here as digits.
 */

const HEX41 = /^41[0-9a-fA-F]{40}$/
const HEX20 = /^[0-9a-fA-F]{40}$/
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/

/** Decode text bytes once; the JSON serializer escapes the resulting string. */
export function visibleText(value: unknown): unknown {
  return typeof value === 'string' && HEX_BYTES.test(value) ? TronWeb.toUtf8(value) : value
}

/** address-valued fields, from `AddressFieldNameMap` */
export const ADDRESS_FIELDS: ReadonlySet<string> = new Set([
  'account',
  'account_address',
  'address',
  'approvals',
  'approved_list',
  'caller_address',
  'contract_address',
  'creator_address',
  'from',
  'fromAccounts',
  'fromAddress',
  'origin_address',
  'ownerAddress',
  'owner_address',
  'proposer_address',
  'receiverAddress',
  'receiver_address',
  'senderAddress',
  'to',
  'toAccounts',
  'toAddress',
  'to_address',
  'transferTo_address',
  'transparent_from_address',
  'transparent_to_address',
  'vote_address',
  'witness_address',
])

/** fields printed as UTF-8 text under visible, from `NameFieldNameMap` */
export const NAME_FIELDS: ReadonlySet<string> = new Set([
  'abbr',
  'account_id',
  'account_name',
  'asset_issued_name',
  'asset_name',
  'buy_token_id',
  'description',
  'first_token_id',
  'memo',
  'resMessage',
  'second_token_id',
  'sell_token_id',
  'update_url',
])

/** convert one leaf, or return it untouched when the key does not name one */
function convertLeaf(key: string, entry: unknown): unknown | undefined {
  if (typeof entry !== 'string') return undefined
  if (NAME_FIELDS.has(key) && HEX_BYTES.test(entry)) {
    return visibleText(entry)
  }
  if (ADDRESS_FIELDS.has(key)) {
    if (HEX41.test(entry)) return TronWeb.address.fromHex(entry)
    // event log addresses are printed as bare 20-byte hex
    if (HEX20.test(entry)) return TronWeb.address.fromHex(`41${entry}`)
  }
  return undefined
}

// repeated fields carry the parent's key, so the element type is decided by it
function convert(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const leaf = key === undefined ? undefined : convertLeaf(key, entry)
      return leaf ?? convert(entry, key)
    })
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [entryKey, entry] of Object.entries(value)) {
    const leaf = convertLeaf(entryKey, entry)
    out[entryKey] = leaf ?? convert(entry, entryKey)
  }
  return out
}

export function withVisibleAddresses<T>(json: T, visible: boolean): T {
  return visible ? (convert(json) as T) : json
}
