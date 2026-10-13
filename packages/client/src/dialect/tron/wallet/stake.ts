import { INT64_MAX } from '../../../intBounds.ts'
import {
  formatTronAddress,
  isVisible,
  optionalRequestAddress,
  toTronHex,
  tryParseTronAddress,
} from '../address.ts'
import { addressValueField } from './chain.ts'
import { broadcastError, isPostBody, requireNumericField } from './types.ts'

import type { Address } from '@tvmjs/util'
import type { ChainParameters } from '../../../config.ts'
import type { DelegatableResource, NodeCore, StakeResource } from '../../../core/node.ts'
import type { Registry } from '../../registry.ts'
import type { AdaptContext, AdaptResult, ValidateContext } from './contractAdapter.ts'

/** slots one account's pending unstakes may occupy */
const UNFREEZE_MAX_TIMES = 32

/** flat protobuf size every delegation is assumed to cost, plus varint growth */
const DELEGATE_COST_BASE_SIZE = 275

/** blocks a locked delegation runs for when the request states no period */
const DEFAULT_DELEGATE_LOCK_BLOCKS = 86_400

const RESOURCE_NAMES: Record<string, 'BANDWIDTH' | 'ENERGY' | 'TRON_POWER'> = {
  BANDWIDTH: 'BANDWIDTH',
  ENERGY: 'ENERGY',
  TRON_POWER: 'TRON_POWER',
  0: 'BANDWIDTH',
  1: 'ENERGY',
  2: 'TRON_POWER',
}

/** the resource a request names; absent means the proto default */
function resourceOf(value: unknown): 'BANDWIDTH' | 'ENERGY' | 'TRON_POWER' | 'UNKNOWN' {
  if (value === undefined || value === null) return 'BANDWIDTH'
  return RESOURCE_NAMES[String(value)] ?? 'UNKNOWN'
}

/**
 * Proposal gates the stake-v2 families are judged by before any contract field
 * is examined, the owner address included.
 */
export function transactionActivationError(
  params: ChainParameters,
  contractType: string,
): string | undefined {
  if (contractType === 'UpdateBrokerageContract') {
    return params.allowChangeDelegation === 1
      ? undefined
      : 'contract type error, unexpected type [UpdateBrokerageContract]'
  }
  if (
    contractType === 'DelegateResourceContract' ||
    contractType === 'UnDelegateResourceContract'
  ) {
    if (params.allowDelegateResource !== 1) return 'No support for resource delegate'
    if (params.unfreezeDelayDays <= 0) {
      return contractType === 'DelegateResourceContract'
        ? 'Not support Delegate resource transaction, need to be opened by the committee'
        : 'Not support unDelegate resource transaction, need to be opened by the committee'
    }
    return undefined
  }
  if (contractType === 'CancelAllUnfreezeV2Contract') {
    return params.allowCancelAllUnfreezeV2 === 1 && params.unfreezeDelayDays > 0
      ? undefined
      : 'Not support CancelAllUnfreezeV2 transaction, need to be opened by the committee'
  }
  if (params.unfreezeDelayDays > 0) return undefined
  if (contractType === 'FreezeBalanceV2Contract') {
    return 'Not support FreezeV2 transaction, need to be opened by the committee'
  }
  if (contractType === 'UnfreezeBalanceV2Contract') {
    return 'Not support UnfreezeV2 transaction, need to be opened by the committee'
  }
  if (contractType === 'WithdrawExpireUnfreezeContract') {
    return 'Not support WithdrawExpireUnfreeze transaction, need to be opened by the committee'
  }
  return undefined
}

/** the wording the freeze, delegate, withdraw and cancel actuators use */
function accountNotExists(address: Address): string {
  return `Account[${toTronHex(address)}] not exists`
}

/** the same lookup, in the wording both unstake actuators and undelegate use */
function accountDoesNotExist(address: Address): string {
  return `Account[${toTronHex(address)}] does not exist`
}

function amountOf(value: unknown): bigint {
  try {
    return BigInt(String(value ?? 0))
  } catch {
    return 0n
  }
}

/** The lock-period field is active only once the configured maximum exceeds
 * the original three-day period; before that proposal state, the source
 * ignores a stated period and uses the original period. */
export function supportsMaxDelegateLockPeriod(params: ChainParameters): boolean {
  return params.maxDelegateLockPeriod > DEFAULT_DELEGATE_LOCK_BLOCKS && params.unfreezeDelayDays > 0
}

/** protobuf varint length of a non-negative value */
function varintLength(value: number): number {
  let length = 1
  let rest = Math.floor(value / 128)
  while (rest > 0) {
    length += 1
    rest = Math.floor(rest / 128)
  }
  return length
}

/**
 * Bytes a delegation of `balanceSun` is charged for when the availability of
 * a build is judged: a fixed base plus how much the varint fields outgrow a
 * one-TRX reference contract. Zero-valued fields stay off the wire, like the
 * serializer leaves them.
 */
export function estimateDelegateTxSize(node: NodeCore, balanceSun: bigint): number {
  const lockPeriod = supportsMaxDelegateLockPeriod(node.config.chainParameters)
    ? node.config.chainParameters.maxDelegateLockPeriod
    : undefined
  const balance = Number(balanceSun)
  const withBalance =
    (balance > 0 ? 1 + varintLength(balance) : 0) +
    2 +
    (lockPeriod === undefined ? 0 : 1 + varintLength(lockPeriod))
  const reference = 1 + varintLength(1_000_000)
  return DELEGATE_COST_BASE_SIZE + Math.max(0, withBalance - reference)
}

/** usage share in sun that one resource's decayed usage pins down */
function usageAsSun(node: NodeCore, usage: number, resource: DelegatableResource): bigint {
  const totals =
    resource === 'BANDWIDTH'
      ? { limit: node.config.chainParameters.totalNetLimit, weight: node.totalNetWeightTrx }
      : {
          limit: node.config.chainParameters.totalEnergyCurrentLimit,
          weight: node.totalEnergyWeightTrx,
        }
  if (totals.weight === 0n || usage <= 0) return 0n
  // A zero global limit leaves the usage share unbounded, and the chain carries
  // that share as a signed 64-bit integer, so it lands on the ceiling: any use
  // of the resource then occupies every sun of V2 stake.
  if (totals.limit === 0) return INT64_MAX
  return BigInt(Math.trunc(usage * 1e6 * (Number(totals.weight) / totals.limit)))
}

/**
 * Sun still delegatable from one resource's own v2 stake: the frozen balance
 * less the share current usage keeps occupied. A build charges the bytes the
 * delegation itself will cost on top.
 */
function delegatableSun(
  node: NodeCore,
  owner: Address,
  resource: DelegatableResource,
  withEstimate: boolean,
): bigint {
  const frozen = node.frozenV2Of(owner)
  const own = resource === 'BANDWIDTH' ? frozen.bandwidth : frozen.energy
  let usage =
    resource === 'BANDWIDTH' ? node.stakedNetUsedOf(owner) : node.stakedEnergyUsedOf(owner)
  if (withEstimate && resource === 'BANDWIDTH') {
    usage += estimateDelegateTxSize(node, frozen.bandwidth)
  }
  const usageSun = usageAsSun(node, usage, resource)
  const acquired = node.acquiredDelegatedOf(owner)
  const occupied = usageSun - (resource === 'BANDWIDTH' ? acquired.bandwidth : acquired.energy)
  return own - (occupied > 0n ? occupied : 0n)
}

export function adaptFreezeBalanceV2(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const amount = amountOf(value.frozen_balance)
  const resource = resourceOf(value.resource)
  return {
    validate: async (n) => {
      if ((await n.getAccount(caller)) === undefined) return accountNotExists(caller)
      if (amount <= 0n) return 'frozenBalance must be positive'
      if (amount < 1_000_000n) return 'frozenBalance must be greater than or equal to 1 TRX'
      if (amount > (await n.getBalance(caller))) {
        return 'frozenBalance must be less than or equal to accountBalance'
      }
      if (resource === 'TRON_POWER' && n.config.chainParameters.allowNewResourceModel !== 1) {
        return 'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY]'
      }
      if (resource !== 'BANDWIDTH' && resource !== 'ENERGY' && resource !== 'TRON_POWER') {
        return n.config.chainParameters.allowNewResourceModel === 1
          ? 'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY、TRON_POWER]'
          : 'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY]'
      }
      return undefined
    },
    stateOp: async (n) => {
      await n.freezeV2(caller, amount, resource as StakeResource)
      return { feeSun: 0n }
    },
  }
}

export function adaptUnfreezeBalanceV2(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const amount = amountOf(value.unfreeze_balance)
  const resource = resourceOf(value.resource)
  return {
    validate: async (n) => {
      if ((await n.getAccount(caller)) === undefined) return accountDoesNotExist(caller)
      const frozen = n.frozenV2Of(caller)
      if (resource === 'BANDWIDTH') {
        if (frozen.bandwidth <= 0n) return 'no frozenBalance(BANDWIDTH)'
      } else if (resource === 'ENERGY') {
        if (frozen.energy <= 0n) return 'no frozenBalance(Energy)'
      } else if (resource === 'TRON_POWER') {
        if (n.config.chainParameters.allowNewResourceModel !== 1) {
          return 'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy]'
        }
        if (frozen.tronPower <= 0n) return 'no frozenBalance(TronPower)'
      } else {
        return n.config.chainParameters.allowNewResourceModel === 1
          ? 'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy、TRON_POWER]'
          : 'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy]'
      }
      const held =
        resource === 'BANDWIDTH'
          ? frozen.bandwidth
          : resource === 'ENERGY'
            ? frozen.energy
            : frozen.tronPower
      if (amount <= 0n || amount > held) {
        return `Invalid unfreeze_balance, [${amount}] is error`
      }
      const nowMs = n.head().timestampMs
      if (n.unfreezingCountAt(caller, nowMs) >= UNFREEZE_MAX_TIMES) {
        return 'Invalid unfreeze operation, unfreezing times is over limit'
      }
      return undefined
    },
    stateOp: async (n) => {
      const withdrawn = await n.unfreezeV2(caller, amount, resource as StakeResource)
      return {
        feeSun: 0n,
        ...(withdrawn > 0n ? { extra: { withdraw_expire_amount: withdrawn } } : {}),
      }
    },
  }
}

export function adaptWithdrawExpireUnfreeze(ctx: AdaptContext): AdaptResult {
  const { caller } = ctx
  return {
    validate: async (n) => {
      if ((await n.getAccount(caller)) === undefined) return accountNotExists(caller)
      const withdrawable = n.withdrawableAt(caller, n.head().timestampMs)
      if (withdrawable <= 0n) {
        // the wording carries its trailing space on the wire
        return 'no unFreeze balance to withdraw '
      }
      if ((await n.getBalance(caller)) + withdrawable > INT64_MAX) return 'long overflow'
      return undefined
    },
    stateOp: async (n) => {
      const withdrawn = await n.withdrawExpiredUnfreeze(caller)
      return { feeSun: 0n, extra: { withdraw_expire_amount: withdrawn } }
    },
  }
}

export function adaptCancelAllUnfreezeV2(ctx: AdaptContext): AdaptResult {
  const { caller } = ctx
  return {
    validate: async (n) => {
      if ((await n.getAccount(caller)) === undefined) return accountNotExists(caller)
      if (n.unfrozenV2Of(caller).length === 0) return 'No unfreezeV2 list to cancel'
      return undefined
    },
    stateOp: async (n) => {
      const { withdrawnSun, canceled } = await n.cancelAllUnfreezeV2(caller)
      return {
        feeSun: 0n,
        extra: {
          ...(withdrawnSun > 0n ? { withdraw_expire_amount: withdrawnSun } : {}),
          // map order and kept zeros follow the wire receipt
          cancel_unfreezeV2_amount: [
            { key: 'ENERGY', value: canceled.ENERGY },
            { key: 'TRON_POWER', value: canceled.TRON_POWER },
            { key: 'BANDWIDTH', value: canceled.BANDWIDTH },
          ],
        },
      }
    },
  }
}

export function adaptDelegateResource(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const amount = amountOf(value.balance)
  const resource = resourceOf(value.resource)
  const lock = value.lock === true || String(value.lock) === 'true'
  const statedPeriod = Number(amountOf(value.lock_period))
  return {
    validate: async (n, held?: ValidateContext) => {
      if ((await n.getAccount(caller)) === undefined) return accountNotExists(caller)
      if (amount < 1_000_000n) return 'delegateBalance must be greater than or equal to 1 TRX'
      if (resource !== 'BANDWIDTH' && resource !== 'ENERGY') {
        return 'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY]'
      }
      const available = delegatableSun(n, caller, resource, held?.building === true)
      if (available < amount) {
        return resource === 'BANDWIDTH'
          ? 'delegateBalance must be less than or equal to available FreezeBandwidthV2 balance'
          : 'delegateBalance must be less than or equal to available FreezeEnergyV2 balance'
      }
      const receiver = tryParseTronAddress(String(value.receiver_address ?? ''))
      if (receiver === undefined) return 'Invalid receiverAddress'
      if (toTronHex(receiver) === toTronHex(caller)) {
        return 'receiverAddress must not be the same as ownerAddress'
      }
      if ((await n.getAccount(receiver)) === undefined) return accountNotExists(receiver)
      const maxLockPeriodActive = supportsMaxDelegateLockPeriod(n.config.chainParameters)
      const lockPeriod = maxLockPeriodActive
        ? statedPeriod === 0
          ? DEFAULT_DELEGATE_LOCK_BLOCKS
          : statedPeriod
        : DEFAULT_DELEGATE_LOCK_BLOCKS
      if (lock && maxLockPeriodActive) {
        const max = n.config.chainParameters.maxDelegateLockPeriod
        if (lockPeriod < 0 || lockPeriod > max) {
          return `The lock period of delegate resource cannot be less than 0 and cannot exceed ${max}!`
        }
        const nowMs = n.head().timestampMs
        const locked = n
          .delegationEntriesOf(toTronHex(caller).slice(2), toTronHex(receiver).slice(2))
          .find((entry) => entry.locked)
        if (locked !== undefined) {
          const expireMs =
            resource === 'BANDWIDTH' ? locked.expireBandwidthMs : locked.expireEnergyMs
          const remain = expireMs - nowMs
          if (lockPeriod * 3000 < remain) {
            return (
              `The lock period for ${resource} this time cannot be less than the ` +
              `remaining time[${remain}ms] of the last lock period for ${resource}!`
            )
          }
        }
      }
      if (n.accountTypeOf(receiver) === 'Contract') {
        return 'Do not allow delegate resources to contract addresses'
      }
      return undefined
    },
    stateOp: async (n) => {
      const receiver = tryParseTronAddress(String(value.receiver_address ?? ''))
      if (receiver === undefined) {
        return { error: broadcastError('CONTRACT_VALIDATE_ERROR', 'Invalid receiverAddress') }
      }
      const maxLockPeriodActive = supportsMaxDelegateLockPeriod(n.config.chainParameters)
      const lockPeriod = maxLockPeriodActive
        ? statedPeriod === 0
          ? DEFAULT_DELEGATE_LOCK_BLOCKS
          : statedPeriod
        : DEFAULT_DELEGATE_LOCK_BLOCKS
      await n.delegateResource(
        caller,
        receiver,
        amount,
        resource as DelegatableResource,
        lock,
        lockPeriod,
      )
      return { feeSun: 0n }
    },
  }
}

export function adaptUnDelegateResource(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const amount = amountOf(value.balance)
  const resource = resourceOf(value.resource)
  return {
    validate: async (n) => {
      if ((await n.getAccount(caller)) === undefined) return accountDoesNotExist(caller)
      const receiver = tryParseTronAddress(String(value.receiver_address ?? ''))
      if (receiver === undefined) return 'Invalid receiverAddress'
      if (toTronHex(receiver) === toTronHex(caller)) {
        return 'receiverAddress must not be the same as ownerAddress'
      }
      const entries = n.delegationEntriesOf(
        toTronHex(caller).slice(2),
        toTronHex(receiver).slice(2),
      )
      if (entries.length === 0) return 'delegated Resource does not exist'
      if (amount <= 0n) return 'unDelegateBalance must be more than 0 TRX'
      const nowMs = n.head().timestampMs
      let available = 0n
      for (const entry of entries) {
        if (resource === 'BANDWIDTH') {
          if (!entry.locked || entry.expireBandwidthMs < nowMs) available += entry.bandwidth
        } else if (resource === 'ENERGY') {
          if (!entry.locked || entry.expireEnergyMs < nowMs) available += entry.energy
        }
      }
      if (resource === 'BANDWIDTH') {
        if (available < amount) {
          return `insufficient delegatedFrozenBalance(BANDWIDTH), request=${amount}, unlock_balance=${available}`
        }
      } else if (resource === 'ENERGY') {
        if (available < amount) {
          return `insufficient delegateFrozenBalance(Energy), request=${amount}, unlock_balance=${available}`
        }
      } else {
        return 'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy]'
      }
      return undefined
    },
    stateOp: async (n) => {
      const receiver = tryParseTronAddress(String(value.receiver_address ?? ''))
      if (receiver === undefined) {
        return { error: broadcastError('CONTRACT_VALIDATE_ERROR', 'Invalid receiverAddress') }
      }
      await n.undelegateResource(caller, receiver, amount, resource as DelegatableResource)
      return { feeSun: 0n }
    },
  }
}

/** Stake 1.0 freezes stay locked until their individual expiry. */
export function adaptFreezeBalance(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const amount = amountOf(value.frozen_balance)
  const duration = Number(amountOf(value.frozen_duration))
  const resource = resourceOf(value.resource)
  return {
    validate: async (n) => {
      if ((await n.getAccount(caller)) === undefined) return accountNotExists(caller)
      if (amount <= 0n) return 'frozenBalance must be positive'
      if (amount < 1_000_000n) return 'frozenBalance must be greater than or equal to 1 TRX'
      if (amount > (await n.getBalance(caller))) {
        return 'frozenBalance must be less than or equal to accountBalance'
      }
      const { checkFrozenTime, minFrozenTime, maxFrozenTime } = n.config.chainParameters
      if (checkFrozenTime === 1 && (duration < minFrozenTime || duration > maxFrozenTime)) {
        return `frozenDuration must be less than ${maxFrozenTime} days and more than ${minFrozenTime} days`
      }
      if (resource === 'TRON_POWER' && n.config.chainParameters.allowNewResourceModel !== 1) {
        return 'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY]'
      }
      if (resource !== 'BANDWIDTH' && resource !== 'ENERGY' && resource !== 'TRON_POWER') {
        return n.config.chainParameters.allowNewResourceModel === 1
          ? 'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY、TRON_POWER]'
          : 'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY]'
      }
      const receiverField = String(value.receiver_address ?? '')
      if (resource === 'TRON_POWER' && receiverField !== '') {
        return 'TRON_POWER is not allowed to delegate to other accounts.'
      }
      if (receiverField !== '' && n.config.chainParameters.allowDelegateResource === 1) {
        const receiver = tryParseTronAddress(receiverField)
        if (receiver !== undefined && toTronHex(receiver) === toTronHex(caller)) {
          return 'receiverAddress must not be the same as ownerAddress'
        }
        if (receiver === undefined) return 'Invalid receiverAddress'
        if ((await n.getAccount(receiver)) === undefined) return accountNotExists(receiver)
        if (n.accountTypeOf(receiver) === 'Contract') {
          return 'Do not allow delegate resources to contract addresses'
        }
      }
      if (n.config.chainParameters.unfreezeDelayDays > 0) {
        return 'freeze v2 is open, old freeze is closed'
      }
      return undefined
    },
    stateOp: async (n) => {
      const receiverField = String(value.receiver_address ?? '')
      const receiver =
        receiverField !== '' &&
        resource !== 'TRON_POWER' &&
        n.config.chainParameters.allowDelegateResource === 1
          ? tryParseTronAddress(receiverField)
          : undefined
      if (
        receiverField !== '' &&
        resource !== 'TRON_POWER' &&
        n.config.chainParameters.allowDelegateResource === 1 &&
        receiver === undefined
      ) {
        return { error: broadcastError('CONTRACT_VALIDATE_ERROR', 'Invalid receiverAddress') }
      }
      await n.freezeLegacy(caller, amount, resource as StakeResource, duration, receiver)
      return { feeSun: 0n }
    },
  }
}

/** Stake 1.0 unfreezing releases a full local resource or delegated pair. */
export function adaptUnfreezeBalance(ctx: AdaptContext): AdaptResult {
  const { value, caller } = ctx
  const resource = resourceOf(value.resource)
  return {
    validate: async (n) => {
      if ((await n.getAccount(caller)) === undefined) return accountDoesNotExist(caller)
      const receiverField = String(value.receiver_address ?? '')
      if (receiverField !== '' && n.config.chainParameters.allowDelegateResource === 1) {
        const receiver = tryParseTronAddress(receiverField)
        if (receiver !== undefined && toTronHex(receiver) === toTronHex(caller)) {
          return 'receiverAddress must not be the same as ownerAddress'
        }
        if (receiver === undefined) return 'Invalid receiverAddress'
        const delegated = n.legacyDelegationOf(
          toTronHex(caller).slice(2),
          toTronHex(receiver).slice(2),
        )
        if (delegated === undefined) return 'delegated Resource does not exist'
        const nowMs = n.head().timestampMs
        if (resource === 'BANDWIDTH') {
          if (delegated.bandwidth <= 0n) return 'no delegatedFrozenBalance(BANDWIDTH)'
          if (delegated.expireBandwidthMs > nowMs) return "It's not time to unfreeze."
          return undefined
        }
        if (resource === 'ENERGY') {
          if (delegated.energy <= 0n) return 'no delegateFrozenBalance(Energy)'
          const expiry =
            n.config.chainParameters.allowMultiSign === 0
              ? delegated.expireBandwidthMs
              : delegated.expireEnergyMs
          if (expiry > nowMs) return "It's not time to unfreeze."
          return undefined
        }
        return 'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy]'
      }
      const frozen = n.legacyFrozenOf(caller)
      const nowMs = n.head().timestampMs
      if (resource === 'BANDWIDTH') {
        if (frozen.bandwidth === undefined || frozen.bandwidth.amount <= 0n) {
          return 'no frozenBalance(BANDWIDTH)'
        }
        return frozen.bandwidth.expireMs > nowMs
          ? "It's not time to unfreeze(BANDWIDTH)."
          : undefined
      }
      if (resource === 'ENERGY') {
        if (frozen.energy === undefined || frozen.energy.amount <= 0n) {
          return 'no frozenBalance(Energy)'
        }
        return frozen.energy.expireMs > nowMs ? "It's not time to unfreeze(Energy)." : undefined
      }
      if (resource === 'TRON_POWER') {
        if (n.config.chainParameters.allowNewResourceModel !== 1) {
          return 'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy]'
        }
        if (frozen.tronPower === undefined || frozen.tronPower.amount <= 0n) {
          return 'no frozenBalance(TronPower)'
        }
        return frozen.tronPower.expireMs > nowMs
          ? "It's not time to unfreeze(TronPower)."
          : undefined
      }
      return n.config.chainParameters.allowNewResourceModel === 1
        ? 'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy、TRON_POWER]'
        : 'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy]'
    },
    stateOp: async (n) => {
      const receiverField = String(value.receiver_address ?? '')
      const receiver =
        receiverField !== '' &&
        resource !== 'TRON_POWER' &&
        n.config.chainParameters.allowDelegateResource === 1
          ? tryParseTronAddress(receiverField)
          : undefined
      if (
        receiverField !== '' &&
        resource !== 'TRON_POWER' &&
        n.config.chainParameters.allowDelegateResource === 1 &&
        receiver === undefined
      ) {
        return { error: broadcastError('CONTRACT_VALIDATE_ERROR', 'Invalid receiverAddress') }
      }
      const amount = await n.unfreezeLegacy(caller, resource as StakeResource, receiver)
      return { feeSun: 0n, extra: { unfreeze_amount: amount } }
    },
  }
}

/** one delegation entry as the wire states it, zeros left off */
function delegationJSON(
  entry: {
    fromKey: string
    toKey: string
    bandwidth: bigint
    energy: bigint
    expireBandwidthMs: number
    expireEnergyMs: number
  },
  visible: boolean,
): Record<string, unknown> {
  const from = tryParseTronAddress(`41${entry.fromKey}`)
  const to = tryParseTronAddress(`41${entry.toKey}`)
  return {
    from: from === undefined ? `41${entry.fromKey}` : formatTronAddress(from, visible),
    to: to === undefined ? `41${entry.toKey}` : formatTronAddress(to, visible),
    ...(entry.bandwidth !== 0n ? { frozen_balance_for_bandwidth: entry.bandwidth } : {}),
    ...(entry.energy !== 0n ? { frozen_balance_for_energy: entry.energy } : {}),
    ...(entry.expireBandwidthMs !== 0
      ? { expire_time_for_bandwidth: entry.expireBandwidthMs }
      : {}),
    ...(entry.expireEnergyMs !== 0 ? { expire_time_for_energy: entry.expireEnergyMs } : {}),
  }
}

export function registerStakeQueryHandlers(registry: Registry): void {
  registry.register(
    'wallet/getdelegatedresource',
    (node, params) => {
      const visible = isVisible(params)
      const from = optionalRequestAddress(
        params,
        'fromAddress',
        'protocol.DelegatedResourceMessage.fromAddress',
      )
      const to = optionalRequestAddress(
        params,
        'toAddress',
        'protocol.DelegatedResourceMessage.toAddress',
      )
      if (from === undefined || to === undefined) return {}
      const entry = node.legacyDelegationOf(toTronHex(from).slice(2), toTronHex(to).slice(2))
      return entry === undefined ? {} : { delegatedResource: [delegationJSON(entry, visible)] }
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getdelegatedresourcev2',
    (node, params) => {
      const visible = isVisible(params)
      const from = optionalRequestAddress(
        params,
        'fromAddress',
        'protocol.DelegatedResourceMessage.fromAddress',
      )
      const to = optionalRequestAddress(
        params,
        'toAddress',
        'protocol.DelegatedResourceMessage.toAddress',
      )
      if (from === undefined || to === undefined) return {}
      const entries = node.delegationEntriesOf(toTronHex(from).slice(2), toTronHex(to).slice(2))
      if (entries.length === 0) return {}
      return { delegatedResource: entries.map((entry) => delegationJSON(entry, visible)) }
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getdelegatedresourceaccountindexv2',
    (node, params) => {
      const visible = isVisible(params)
      // under `visible` the value is the Base58 text itself; otherwise it is
      // the hex of the address bytes
      let account: Address | undefined
      if (visible) {
        account = tryParseTronAddress(String(params.value ?? ''))
      } else {
        const value = addressValueField(params, 'value', 'get-only')
        account = value.length === 42 ? tryParseTronAddress(value) : undefined
      }
      if (account === undefined) return {}
      const index = node.delegationIndexOf(toTronHex(account).slice(2))
      const asAddresses = (keys: string[]): string[] =>
        keys.map((key) => {
          const held = tryParseTronAddress(`41${key}`)
          return held === undefined ? `41${key}` : formatTronAddress(held, visible)
        })
      return {
        account: formatTronAddress(account, visible),
        ...(index.from.length > 0 ? { fromAccounts: asAddresses(index.from) } : {}),
        ...(index.to.length > 0 ? { toAccounts: asAddresses(index.to) } : {}),
      }
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getdelegatedresourceaccountindex',
    (node, params) => {
      const visible = isVisible(params)
      let account: Address | undefined
      if (visible) {
        account = tryParseTronAddress(String(params.value ?? ''))
      } else {
        const value = addressValueField(params, 'value', 'get-only')
        account = value.length === 42 ? tryParseTronAddress(value) : undefined
      }
      if (account === undefined) return {}
      const index = node.legacyDelegationIndexOf(toTronHex(account).slice(2))
      const asAddresses = (keys: string[]): string[] =>
        keys.map((key) => {
          const held = tryParseTronAddress(`41${key}`)
          return held === undefined ? `41${key}` : formatTronAddress(held, visible)
        })
      return {
        account: formatTronAddress(account, visible),
        ...(index.from.length > 0 ? { fromAccounts: asAddresses(index.from) } : {}),
        ...(index.to.length > 0 ? { toAccounts: asAddresses(index.to) } : {}),
      }
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getcandelegatedmaxsize',
    async (node, params) => {
      const owner = optionalRequestAddress(
        params,
        'owner_address',
        'protocol.CanDelegatedMaxSizeRequestMessage.owner_address',
      )
      // the resource kind is parsed whether or not the answer depends on it
      requireNumericField(params, 'type')
      if (owner === undefined || (await node.getAccount(owner)) === undefined) return {}
      const type = Number(params.type ?? 0)
      let maxSize = 0n
      if (type === 0 || type === 1) {
        maxSize = delegatableSun(node, owner, type === 0 ? 'BANDWIDTH' : 'ENERGY', true)
        if (maxSize < 0n) maxSize = 0n
      }
      if (maxSize < 1_000_000n) maxSize = 0n
      return maxSize === 0n ? {} : { max_size: maxSize }
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getavailableunfreezecount',
    async (node, params) => {
      // the query string takes a camel-cased spelling too; a body does not
      const address = optionalRequestAddress(
        params,
        params.ownerAddress !== undefined && !isPostBody(params) ? 'ownerAddress' : 'owner_address',
        'protocol.GetAvailableUnfreezeCountRequestMessage.owner_address',
      )
      if (address === undefined || (await node.getAccount(address)) === undefined) return {}
      const count = UNFREEZE_MAX_TIMES - node.unfreezingCountAt(address, node.head().timestampMs)
      return count === 0 ? {} : { count }
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getcanwithdrawunfreezeamount',
    async (node, params) => {
      const owner = optionalRequestAddress(
        params,
        'owner_address',
        'protocol.CanWithdrawUnfreezeAmountRequestMessage.owner_address',
      )
      requireNumericField(params, 'timestamp')
      if (owner === undefined || (await node.getAccount(owner)) === undefined) return {}
      let timestamp = Number(params.timestamp ?? 0)
      if (timestamp < 0) return {}
      if (timestamp === 0) timestamp = node.head().timestampMs
      const amount = node.withdrawableAt(owner, timestamp)
      return amount === 0n ? {} : { amount }
    },
    { solidity: true },
  )
}
