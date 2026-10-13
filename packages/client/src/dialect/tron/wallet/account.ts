import { TronWeb } from 'tronweb'

import {
  isVisible,
  optionalRequestAddress,
  parseTronAddress,
  toTronHex,
  tryParseTronAddress,
} from '../address.ts'
import { checkMergeField, fieldTokens } from '../mergeValue.ts'
import { permissionsOf, storedPermissionsOnly } from '../permission.ts'
import { withVisibleAddresses } from '../visible.ts'
import { accountIdHolder } from './asset.ts'
import { parseHexField } from './chain.ts'
import { isPostBody } from './types.ts'

import type { Address } from '@tvmjs/util'

import type { NodeCore } from '../../../core/node.ts'
import type { HandlerParams, Registry } from '../../registry.ts'
import type { Permission } from '../permission.ts'

/**
 * Free bandwidth an issuance grants its holders, reported per asset: the
 * limit from the issuance, the usage from this holder's own ledger, decayed
 * to the moment of the query.
 */
function assetNetMaps(
  node: NodeCore,
  address: Address,
  holdings: Record<number, bigint> | null | undefined,
): Record<string, unknown> {
  const legacy = node.config.chainParameters.allowSameTokenName === 0
  const ids = Object.keys({ ...holdings, ...node.assetNetLedgerOf(address) })
  if (ids.length === 0) return {}
  const keyOf = (id: string) => (legacy ? node.assets.byId(Number(id))!.name : id)
  return {
    assetNetUsed: ids.map((id) => ({
      key: keyOf(id),
      value: node.assetNetUsedOf(address, Number(id)),
    })),
    assetNetLimit: ids.map((id) => ({
      key: keyOf(id),
      value: node.assets.byId(Number(id))?.freeAssetNetLimit ?? 0,
    })),
  }
}

/**
 * The wire states the owner permission in its own field and the rest in a
 * repeated one; the account record here holds a single list told apart by type.
 */
function permissionFields(permissions: Permission[]): Record<string, unknown> {
  const owner = permissions.find((p) => p.type === 'Owner')
  const witness = permissions.find((p) => p.type === 'Witness')
  const actives = permissions.filter((p) => p.type === 'Active')
  return {
    ...(owner !== undefined
      ? {
          owner_permission: {
            permission_name: owner.permission_name,
            threshold: owner.threshold,
            keys: owner.keys,
          },
        }
      : {}),
    ...(witness !== undefined ? { witness_permission: witness } : {}),
    ...(actives.length > 0 ? { active_permission: actives } : {}),
  }
}

export function registerAccountHandlers(registry: Registry): void {
  registry.register(
    'wallet/getaccount',
    async (node, params) => {
      const visible = isVisible(params)
      const address = optionalRequestAddress(params, 'address', 'protocol.Account.address')
      return address === undefined ? {} : accountJSON(node, address, visible)
    },
    { solidity: true },
  )

  // resolved through the chain-wide id registry setaccountid writes into
  registry.register(
    'wallet/getaccountbyid',
    async (node, params) => {
      // the id is one of the fields stated as text under `visible` and as the
      // hex of those bytes otherwise
      const visible = isVisible(params)
      let id = ''
      for (const token of fieldTokens(params, 'account_id')) {
        checkMergeField(token, 'bytes', { visible, selfFormat: 'name' })
        if (token.text === 'null') continue
        const raw = token.text.slice(1, -1)
        id = visible ? TronWeb.fromUtf8(raw).replace(/^0x/, '') : raw.replace(/^0x/i, '')
      }
      const owner = id === '' ? undefined : accountIdHolder(node, id)
      return owner === undefined ? {} : accountJSON(node, parseTronAddress(owner), visible, false)
    },
    { solidity: true },
  )

  /**
   * An address the servlet decodes itself rather than handing to the merge: a
   * value that is not hex surfaces the decoder's own exception, and one that
   * is hex but not an address simply finds nothing.
   */
  const decodedAddress = (params: HandlerParams): Address | undefined => {
    // the value is read as text whatever its JSON type, and an odd digit count
    // is padded rather than refused
    // a field stated as JSON null reads back as no text at all, which decodes
    // to empty bytes the same way an absent one does
    const held = params.address
    const raw =
      held === undefined || held === null
        ? ''
        : typeof held === 'object'
          ? JSON.stringify(held)
          : String(held)
    if (!isVisible(params)) {
      parseHexField(raw)
      return tryParseTronAddress(raw)
    }
    return tryParseTronAddress(raw)
  }

  /** the staked-bandwidth block both resource endpoints share, zeros left off */
  const stakedNetFields = (node: NodeCore, address: Address): Record<string, unknown> => {
    const used = node.stakedNetUsedOf(address)
    const limit = node.stakedNetLimitOf(address)
    return {
      ...(used > 0 ? { NetUsed: used } : {}),
      ...(limit !== 0n ? { NetLimit: limit } : {}),
    }
  }

  // this one decodes for itself whichever verb it is reached by
  registry.register('wallet/getaccountresource', async (node, params) => {
    const address = decodedAddress(params)
    // an account that does not exist has no resources to report
    if (address === undefined || (await node.getAccount(address)) === undefined) return {}
    const energyUsed = node.stakedEnergyUsedOf(address)
    const energyLimit = node.stakedEnergyLimitOf(address)
    const tronPower = node.tronPowerTrxOf(address)
    return {
      // free bandwidth used, after the 24h linear recovery
      freeNetUsed: node.getFreeBandwidthUsed(address),
      freeNetLimit: node.config.chainParameters.freeNetLimit,
      ...stakedNetFields(node, address),
      ...assetNetMaps(node, address, (await node.getAccount(address))?.asset),
      TotalNetLimit: node.config.chainParameters.totalNetLimit,
      ...(node.totalNetWeightTrx !== 0n ? { TotalNetWeight: node.totalNetWeightTrx } : {}),
      ...(tronPower !== 0n ? { tronPowerLimit: tronPower } : {}),
      ...(node.totalTronPowerWeightTrx !== 0n
        ? { TotalTronPowerWeight: node.totalTronPowerWeightTrx }
        : {}),
      ...(energyUsed > 0 ? { EnergyUsed: energyUsed } : {}),
      ...(energyLimit !== 0n ? { EnergyLimit: energyLimit } : {}),
      TotalEnergyLimit: node.config.chainParameters.totalEnergyCurrentLimit,
      ...(node.totalEnergyWeightTrx !== 0n ? { TotalEnergyWeight: node.totalEnergyWeightTrx } : {}),
    }
  })

  // a body reaches this one through the merge; a query string does not
  registry.register('wallet/getaccountnet', async (node, params) => {
    const address = isPostBody(params)
      ? optionalRequestAddress(params, 'address', 'protocol.Account.address')
      : decodedAddress(params)
    if (address === undefined || (await node.getAccount(address)) === undefined) return {}
    return {
      freeNetUsed: node.getFreeBandwidthUsed(address),
      freeNetLimit: node.config.chainParameters.freeNetLimit,
      ...stakedNetFields(node, address),
      ...assetNetMaps(node, address, (await node.getAccount(address))?.asset),
      TotalNetLimit: node.config.chainParameters.totalNetLimit,
      ...(node.totalNetWeightTrx !== 0n ? { TotalNetWeight: node.totalNetWeightTrx } : {}),
    }
  })
}

/**
 * The account record in wire form: proto field order, defaults left
 * out, and the slot-counted consumption stamps expanded back into milliseconds.
 */
async function accountJSON(
  node: NodeCore,
  address: Address,
  visible: boolean,
  sortFrozenV2 = true,
): Promise<Record<string, unknown>> {
  const account = await node.getAccount(address)
  if (account === undefined) {
    // unknown accounts answer a literal {} (store miss → "{}");
    // separately, existing accounts omit default-valued fields via proto3
    // JSON printing — the transport layer replicates that omission
    return {}
  }
  const genesisTime = node.blocks.getByNumber(0n)?.timestampMs ?? 0
  // the VM builds contract accounts, which carry neither a creation stamp
  // nor permissions
  // a contract account stays one after its code is cleared, so the type the
  // account carries answers as well as the code does
  const isContract =
    (await node.getCode(address)).length > 0 || node.accountTypeOf(address) === 'Contract'
  const createTime = isContract ? 0 : (node.accountCreatedAt(address) ?? genesisTime)
  const bandwidth = node.bandwidthLedgerOf(address)
  const operationTime = node.operationTime(address)
  const allowance = node.allowanceOf(address)
  const freeNetUsage = node.getFreeBandwidthUsed(address)
  // TRC-10: holdings as assetV2 [{key,value}]; issuers additionally carry
  // asset_issued_ID (printed as plain digits)
  const holdings = Object.entries(account.asset ?? {}).map(([id, value]) => ({
    key: String(id),
    value,
  }))
  const issued = node.assets.byOwner(toTronHex(address).slice(2).toLowerCase())
  const assetLedger = node.assetNetLedgerOf(address)
  const assetTimes = Object.entries(assetLedger).map(([id, entry]) => ({
    key: id,
    value: Math.floor((entry.lastMs - genesisTime) / BLOCK_INTERVAL_MS),
  }))
  const assetUsage = Object.keys({ ...account.asset, ...assetLedger }).map((id) => ({
    key: id,
    value: node.assetNetUsedOf(address, Number(id)),
  }))
  const legacyBalances =
    node.config.chainParameters.allowSameTokenName === 0 ? (account.asset ?? {}) : {}
  const legacyMap = <T>(entries: { key: string; value: T }[]) =>
    entries.map(({ key, value }) => ({
      key: node.assets.byId(Number(key))!.name,
      value,
    }))
  const frozenSupply = node.frozenSupplyOf(address)
  // an account is written with its owner and active permissions the moment a
  // transaction creates it; the VM builds contract accounts and sets none, and
  // the genesis roll writes its witness account bare — the witness prints
  // permissions only once some are stored
  const permissions = isContract
    ? []
    : node.isWitness(address)
      ? storedPermissionsOnly(node, address)
      : await permissionsOf(node, address)
  const frozenV2 = node.frozenV2Of(address)
  const storedFrozenV2Order = node.frozenV2OrderOf(address)
  const frozenLegacy = node.legacyFrozenOf(address)
  const oldTronPower = node.oldTronPowerOf(address)
  // the resource window is only resized, and only marked optimized, on the path
  // the cancel-unfreeze proposal opens
  const { allowCancelAllUnfreezeV2, unfreezeDelayDays } = node.config.chainParameters
  const windowOptimized = allowCancelAllUnfreezeV2 === 1 && unfreezeDelayDays > 0
  const unfrozenV2 = node.unfrozenV2Of(address)
  const delegatedOut = node.delegatedOutOf(address)
  const acquired = node.acquiredDelegatedOf(address)
  const legacyDelegatedOut = node.legacyDelegatedOutOf(address)
  const legacyAcquired = node.legacyAcquiredDelegatedOf(address)
  const stakedNet = node.stakedNetLedgerOf(address)
  const stakedNetUsed = node.stakedNetUsedOf(address)
  const stakedEnergyUsed = node.stakedEnergyUsedOf(address)
  return withVisibleAddresses(
    {
      ...(node.accountNameOf(address) !== undefined
        ? { account_name: node.accountNameOf(address) }
        : {}),
      // a declared type survives creation; VM-built contracts imply theirs
      ...(node.accountTypeOf(address) !== undefined
        ? { type: node.accountTypeOf(address) }
        : isContract
          ? { type: 'Contract' }
          : {}),
      address: toTronHex(address),
      balance: account.balance,
      ...(frozenLegacy.bandwidth !== undefined
        ? {
            frozen: [
              {
                frozen_balance: frozenLegacy.bandwidth.amount,
                expire_time: frozenLegacy.bandwidth.expireMs,
              },
            ],
          }
        : {}),
      ...(stakedNetUsed > 0 ? { net_usage: stakedNetUsed } : {}),
      ...(createTime !== 0 ? { create_time: createTime } : {}),
      ...(operationTime !== undefined ? { latest_opration_time: operationTime } : {}),
      ...(allowance !== 0n ? { allowance } : {}),
      ...(node.isWitness(address) ? { is_witness: true } : {}),
      ...(frozenSupply.length > 0
        ? {
            frozen_supply: frozenSupply.map((tranche) => ({
              frozen_balance: tranche.frozenBalance,
              expire_time: tranche.expireTime,
            })),
          }
        : {}),
      ...(issued !== undefined
        ? { asset_issued_name: TronWeb.fromUtf8(issued.name).replace(/^0x/, '') }
        : {}),
      ...(freeNetUsage > 0 ? { free_net_usage: freeNetUsage } : {}),
      ...(stakedNet !== undefined
        ? { latest_consume_time: slotTime(stakedNet.lastMs, genesisTime) }
        : {}),
      ...(bandwidth !== undefined
        ? { latest_consume_free_time: slotTime(bandwidth.lastMs, genesisTime) }
        : {}),
      ...(node.accountIdOf(address) !== undefined ? { account_id: node.accountIdOf(address) } : {}),
      ...(windowOptimized ? { net_window_size: 28_800_000, net_window_optimized: true } : {}),
      account_resource: {
        ...(stakedEnergyUsed > 0 ? { energy_usage: stakedEnergyUsed } : {}),
        ...(frozenLegacy.energy !== undefined
          ? {
              frozen_balance_for_energy: {
                frozen_balance: frozenLegacy.energy.amount,
                expire_time: frozenLegacy.energy.expireMs,
              },
            }
          : {}),
        ...(node.energyUsedAt(address) !== undefined
          ? { latest_consume_time_for_energy: node.energyUsedAt(address) }
          : {}),
        ...(legacyAcquired.energy !== 0n
          ? { acquired_delegated_frozen_balance_for_energy: legacyAcquired.energy }
          : {}),
        ...(legacyDelegatedOut.energy !== 0n
          ? { delegated_frozen_balance_for_energy: legacyDelegatedOut.energy }
          : {}),
        ...(windowOptimized ? { energy_window_size: 28_800_000 } : {}),
        ...(delegatedOut.energy !== 0n
          ? { delegated_frozenV2_balance_for_energy: delegatedOut.energy }
          : {}),
        ...(acquired.energy !== 0n
          ? { acquired_delegated_frozenV2_balance_for_energy: acquired.energy }
          : {}),
        ...(windowOptimized ? { energy_window_optimized: true } : {}),
      },
      ...permissionFields(permissions),
      // the id lookup skips the padding, not the holdings: a staked account
      // still shows its slots, an unstaked one shows none
      ...(sortFrozenV2 || storedFrozenV2Order.length > 0
        ? {
            frozenV2: (sortFrozenV2
              ? (['BANDWIDTH', 'ENERGY', 'TRON_POWER'] as const)
              : storedFrozenV2Order
            ).map((type) => ({
              ...(type === 'BANDWIDTH' ? {} : { type }),
              ...(type === 'BANDWIDTH'
                ? frozenV2.bandwidth !== 0n
                  ? { amount: frozenV2.bandwidth }
                  : {}
                : type === 'ENERGY' && frozenV2.energy !== 0n
                  ? { amount: frozenV2.energy }
                  : type === 'TRON_POWER' && frozenV2.tronPower !== 0n
                    ? { amount: frozenV2.tronPower }
                    : {}),
            })),
          }
        : {}),
      ...(unfrozenV2.length > 0
        ? {
            unfrozenV2: unfrozenV2.map((entry) => ({
              ...(entry.type !== 'BANDWIDTH' ? { type: entry.type } : {}),
              unfreeze_amount: entry.amount,
              unfreeze_expire_time: entry.expireMs,
            })),
          }
        : {}),
      ...(delegatedOut.bandwidth !== 0n
        ? { delegated_frozenV2_balance_for_bandwidth: delegatedOut.bandwidth }
        : {}),
      ...(acquired.bandwidth !== 0n
        ? { acquired_delegated_frozenV2_balance_for_bandwidth: acquired.bandwidth }
        : {}),
      ...(legacyAcquired.bandwidth !== 0n
        ? { acquired_delegated_frozen_balance_for_bandwidth: legacyAcquired.bandwidth }
        : {}),
      ...(legacyDelegatedOut.bandwidth !== 0n
        ? { delegated_frozen_balance_for_bandwidth: legacyDelegatedOut.bandwidth }
        : {}),
      ...(oldTronPower !== 0n ? { old_tron_power: oldTronPower } : {}),
      ...(frozenLegacy.tronPower !== undefined
        ? {
            tron_power: {
              frozen_balance: frozenLegacy.tronPower.amount,
              expire_time: frozenLegacy.tronPower.expireMs,
            },
          }
        : {}),
      ...(holdings.length > 0 ? { assetV2: holdings } : {}),
      ...(Object.keys(legacyBalances).length > 0
        ? {
            asset: legacyMap(
              Object.entries(legacyBalances).map(([key, value]) => ({ key, value })),
            ),
          }
        : {}),
      ...(issued !== undefined ? { asset_issued_ID: String(issued.id) } : {}),
      ...(assetTimes.length > 0 ? { latest_asset_operation_timeV2: assetTimes } : {}),
      ...(assetUsage.length > 0 ? { free_asset_net_usageV2: assetUsage } : {}),
      ...(node.config.chainParameters.allowSameTokenName === 0
        ? {
            ...(assetTimes.length > 0
              ? { latest_asset_operation_time: legacyMap(assetTimes) }
              : {}),
            ...(assetUsage.length > 0 ? { free_asset_net_usage: legacyMap(assetUsage) } : {}),
          }
        : {}),
      // the flag is stamped on every record the root account store takes, so
      // it appears once the account has outlived the block that created it
      ...(node.isRootStored(address) ? { asset_optimized: true } : {}),
    },
    visible,
  )
}

/** block cadence, the unit the consumption stamps are counted in */
const BLOCK_INTERVAL_MS = 3_000

/** the stamp is stored as a slot count and printed back as a block time */
function slotTime(atMs: number, genesisMs: number): number {
  return genesisMs + BLOCK_INTERVAL_MS * Math.floor((atMs - genesisMs) / BLOCK_INTERVAL_MS)
}
