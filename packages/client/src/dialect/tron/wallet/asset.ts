import { TronWeb } from 'tronweb'

import { isVisible, optionalRequestAddress, toTronHex, tryParseTronAddress } from '../address.ts'
import { withVisibleAddresses } from '../visible.ts'

import { numericField, parseHexField } from './chain.ts'
import { HexDecodeError, JavaExceptionError, isPostBody, requireIntFields } from './types.ts'

import type { AssetMeta } from '../../../core/assets.ts'
import type { NodeCore } from '../../../core/node.ts'
import type { HandlerParams, Registry } from '../../registry.ts'

function utf8ToHex(text: string): string {
  return TronWeb.fromUtf8(text).replace(/^0x/, '')
}

/** the page size a paginated asset query is capped at */
const ASSET_ISSUE_COUNT_LIMIT_MAX = 1000

export function hexToUtf8Loose(hex: unknown): string {
  const raw = String(hex ?? '').replace(/^0x/i, '')
  if (raw === '' || !/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) {
    return String(hex ?? '')
  }
  try {
    return TronWeb.toUtf8(raw)
  } catch {
    return String(hex ?? '')
  }
}

/**
 * The bytes the `value` parameter carries: UTF-8 text under `visible`, hex
 * otherwise. Non-hex input is a decode failure, not an empty name.
 */
function nameBytes(value: unknown, visible: boolean): string {
  if (value === undefined || value === null) {
    // under `visible` the text is read as characters, and there is nothing to
    // read the characters of
    if (visible) {
      throw new JavaExceptionError(
        'Cannot invoke "String.getBytes(java.nio.charset.Charset)" because "text" is null',
      )
    }
    return ''
  }
  const text = String(value)
  if (visible) return text
  const raw = text.replace(/^0x/, '')
  const padded = raw.length % 2 === 0 ? raw : `0${raw}`
  if (padded !== '' && !/^[0-9a-fA-F]+$/.test(padded)) throw new HexDecodeError(padded)
  return padded === '' ? '' : TronWeb.toUtf8(padded)
}

/** key order follows the protobuf field numbers, `id` last */
export function assetToJSON(
  meta: AssetMeta,
  visible = false,
  publicFreeAssetNetUsage = meta.publicFreeAssetNetUsage,
): Record<string, unknown> {
  return {
    owner_address: `41${meta.ownerKey}`,
    name: visible ? meta.name : utf8ToHex(meta.name),
    abbr: utf8ToHex(meta.abbr),
    total_supply: meta.totalSupply,
    ...(meta.frozenSupply !== undefined && meta.frozenSupply.length > 0
      ? { frozen_supply: meta.frozenSupply }
      : {}),
    trx_num: meta.trxNum,
    precision: meta.precision,
    num: meta.num,
    start_time: meta.startTime,
    end_time: meta.endTime,
    order: meta.order,
    vote_score: meta.voteScore,
    description: utf8ToHex(meta.description),
    url: visible ? meta.url : utf8ToHex(meta.url),
    free_asset_net_limit: meta.freeAssetNetLimit,
    public_free_asset_net_limit: meta.publicFreeAssetNetLimit,
    public_free_asset_net_usage: publicFreeAssetNetUsage,
    public_latest_free_net_time: meta.publicLatestFreeNetTime,
    id: String(meta.id),
  }
}

/** the printed issuance, addresses converted along with it */
function assetJSON(
  node: NodeCore,
  meta: AssetMeta,
  visible: boolean,
  byId = false,
): Record<string, unknown> {
  const projected =
    byId && node.config.chainParameters.allowSameTokenName === 0 ? { ...meta, precision: 0 } : meta
  return withVisibleAddresses(
    assetToJSON(projected, visible, node.assetPublicNetUsedOf(meta)),
    visible,
  )
}

/** a name that matches more than one issuance has no single answer */
function nonUnique(): JavaExceptionError {
  return new JavaExceptionError('To get more than one asset, please use getAssetIssueById syntax')
}

export function registerAssetHandlers(registry: Registry): void {
  // the store is keyed by the id's ASCII bytes, so the match is exact
  registry.register(
    'wallet/getassetissuebyid',
    (node, params: HandlerParams) => {
      const id = params.value === undefined || params.value === null ? '' : String(params.value)
      const meta = /^[0-9]+$/.test(id) ? node.assets.byId(Number(id)) : undefined
      return meta === undefined || String(meta.id) !== id
        ? {}
        : assetJSON(node, meta, isVisible(params), true)
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getassetissuebyname',
    (node, params) => {
      const visible = isVisible(params)
      const name = nameBytes(params.value, visible)
      if (name === '') return {}
      const matches = node.assets.listInStoreOrder().filter((meta) => meta.name === name)
      if (matches.length > 1) throw nonUnique()
      if (node.config.chainParameters.allowSameTokenName === 0) {
        return matches.length === 0 ? {} : assetJSON(node, matches[0], visible)
      }
      // the same bytes are then tried as an id, which may turn up a second one
      const byId = node.assets.list().find((meta) => String(meta.id) === name)
      if (byId !== undefined) {
        if (matches.length === 0) return assetJSON(node, byId, visible)
        if (matches[0].id !== byId.id) throw nonUnique()
      }
      return matches.length === 0 ? {} : assetJSON(node, matches[0], visible)
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getassetissuelistbyname',
    (node, params) => {
      const visible = isVisible(params)
      const name = nameBytes(params.value, visible)
      const matches =
        name === '' ? [] : node.assets.listInStoreOrder().filter((meta) => meta.name === name)
      return matches.length === 0
        ? {}
        : { assetIssue: matches.map((meta) => assetJSON(node, meta, visible)) }
    },
    { solidity: true },
  )

  registry.register('wallet/getassetissuebyaccount', (node, params) => {
    // The body goes through a protobuf merge, but the query is decoded by this
    // endpoint itself. In particular, bad hex in a query is a decoder failure
    // rather than a merge failure.
    const address = isPostBody(params)
      ? optionalRequestAddress(params, 'address', 'protocol.Account.address')
      : assetOwnerAddress(params)
    const meta =
      address === undefined
        ? undefined
        : node.assets.byOwner(toTronHex(address).slice(2).toLowerCase())
    return meta === undefined
      ? {}
      : withVisibleAddresses(
          {
            assetIssue: [assetToJSON(meta, isVisible(params), node.assetPublicNetUsedOf(meta))],
          },
          isVisible(params),
        )
  })

  registry.register(
    'wallet/getassetissuelist',
    (node, params) => {
      const all = node.assets.listInStoreOrder(node.config.chainParameters.allowSameTokenName === 0)
      return all.length === 0
        ? {}
        : withVisibleAddresses(
            {
              assetIssue: all.map((meta) =>
                assetToJSON(meta, isVisible(params), node.assetPublicNetUsedOf(meta)),
              ),
            },
            isVisible(params),
          )
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getpaginatedassetissuelist',
    (node, params) => {
      requireIntFields(params, ['offset', 'limit'])
      const offset = Number(numericField(params, 'offset'))
      const limit = Number(numericField(params, 'limit'))
      const all = node.assets.listInStoreOrder(node.config.chainParameters.allowSameTokenName === 0)
      // a negative bound or an offset past the end has no page to return
      if (limit <= 0 || offset < 0 || all.length <= offset) return {}
      const capped = Math.min(limit, ASSET_ISSUE_COUNT_LIMIT_MAX)
      // same-name entries retain the asset-store iteration order
      const sorted = [...all].sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))
      return withVisibleAddresses(
        {
          assetIssue: sorted
            .slice(offset, offset + capped)
            .map((meta) => assetToJSON(meta, isVisible(params), node.assetPublicNetUsedOf(meta))),
        },
        isVisible(params),
      )
    },
    { solidity: true },
  )
}

/** address decoding specific to the GET form of getassetissuebyaccount */
function assetOwnerAddress(params: HandlerParams) {
  const raw = params.address === undefined || params.address === null ? '' : String(params.address)
  if (!isVisible(params)) parseHexField(raw)
  return tryParseTronAddress(raw)
}

/**
 * The key an account id is stored and looked up under. The index lowercases
 * the id's text — not the hex that carries it — so `ZqMSX` and `zqmsx` are one
 * and the same id.
 */
export function accountIdKey(hex: string): string {
  return TronWeb.fromUtf8(hexToUtf8Loose(hex).toLowerCase()).replace(/^0x/, '')
}

/**
 * The owner that claimed this id. The store keys ids by their original text,
 * so the match lowercases both sides.
 */
export function accountIdHolder(node: NodeCore, hex: string): string | undefined {
  const wanted = accountIdKey(hex)
  for (const [id, owner] of node.accountIds) {
    if (accountIdKey(id) === wanted) return owner
  }
  return undefined
}
