import os from 'node:os'
import v8 from 'node:v8'

import { WITNESS_ADDRESS } from '../../../core/witness.ts'
import { isVisible } from '../address.ts'
import { Float } from '../proto.ts'
import { withVisibleAddresses } from '../visible.ts'
import { JavaExceptionError, requireIntFields } from './types.ts'

import type { NodeCore } from '../../../core/node.ts'
import type { Handler, Registry } from '../../registry.ts'

/** block cadence, the unit a slot number counts in */
const BLOCK_INTERVAL_MS = 3_000

/**
 * The node-info response carries a release identifier and matching build
 * number. They stay fixed for response compatibility; this client's own
 * identity is available from the admin route and Server header.
 */
const NODE_INFO_CODE_VERSION = '4.8.2'

/**
 * The stored maintenance time, which only ever moves when a block crosses a
 * boundary — so it is strictly after the head block, never equal to it.
 */
export function nextMaintenanceTime(node: NodeCore): number {
  const interval = node.config.chainParameters.maintenanceTimeIntervalMs
  return (Math.floor(node.head().timestampMs / interval) + 1) * interval
}

/**
 * Maintenance periods this chain has been through — a count, stepped once per
 * maintenance, not an absolute period index. It runs from the first sealed
 * block because the genesis header carries timestamp 0.
 */
export function currentCycleNumber(node: NodeCore): number {
  const interval = node.config.chainParameters.maintenanceTimeIntervalMs
  const head = node.head().timestampMs
  const start = node.blocks.getByNumber(1n)?.timestampMs ?? head
  return Math.floor(head / interval) - Math.floor(start / interval)
}

/**
 * What the process is running on, in the shape the node-info message declares.
 * That shape fixes the field names; the values are this process's own — heap
 * spaces stand in for the memory pools, and the version is this runtime's.
 */
function machineInfo(): Record<string, unknown> {
  const heap = v8.getHeapStatistics()
  const cpu = process.cpuUsage()
  const elapsed = process.uptime() * 1_000_000
  return {
    threadCount: 1,
    deadLockThreadCount: 0,
    cpuCount: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    cpuRate: elapsed === 0 ? 0 : (cpu.user + cpu.system) / elapsed / os.cpus().length,
    javaVersion: process.version.replace(/^v/, ''),
    osName: `${os.type()} ${os.release()}`,
    jvmTotalMemory: heap.heap_size_limit,
    jvmFreeMemory: heap.heap_size_limit - heap.used_heap_size,
    // the process's share of the whole machine, the same 0..1 scale the
    // system-wide rate above is on
    processCpuRate: elapsed === 0 ? 0 : (cpu.user + cpu.system) / elapsed / os.cpus().length,
    memoryDescInfoList: v8.getHeapSpaceStatistics().map((space) => ({
      name: space.space_name,
      initSize: 0,
      useSize: space.space_used_size,
      maxSize: space.space_size,
      useRate: space.space_size === 0 ? 0 : space.space_used_size / space.space_size,
    })),
    deadLockThreadInfoList: [],
  }
}

/** the page size a witness query is capped at */
const WITNESS_COUNT_LIMIT_MAX = 1000
const MAINTENANCE_UNAVAILABLE =
  'Service temporarily unavailable during maintenance period. Please try again later.'

function paginatedWitnessList(
  node: NodeCore,
  params: Record<string, unknown>,
  confirmed: boolean,
): Record<string, unknown> {
  requireIntFields(params, ['offset', 'limit'])
  const offset = Number(params.offset ?? 0)
  const limit = Number(params.limit ?? 0)
  if (limit <= 0 || offset < 0) return {}
  if (!confirmed && node.isMaintenanceInProgress()) {
    throw new JavaExceptionError(MAINTENANCE_UNAVAILABLE)
  }
  const all = witnessListFrom(node, node.currentWitnessEntries()).witnesses as Record<
    string,
    unknown
  >[]
  if (offset >= all.length) return {}
  const page = all.slice(offset, offset + Math.min(limit, WITNESS_COUNT_LIMIT_MAX))
  return withVisibleAddresses({ witnesses: page }, isVisible(params))
}

const paginatedNowWitnessList: Handler = (node, params) => paginatedWitnessList(node, params, false)
const paginatedNowWitnessListSolidity: Handler = (node, params) =>
  paginatedWitnessList(node, params, true)

/** witness-store rows, with production fields only on this node's fixed producer */
function witnessList(node: NodeCore): Record<string, unknown> {
  return witnessListFrom(node, node.witnessEntries())
}

/** print one witness-store view; the two read routes choose different views */
function witnessListFrom(
  node: NodeCore,
  entries: ReturnType<NodeCore['witnessEntries']>,
): Record<string, unknown> {
  return {
    witnesses: entries.map(({ address, record }) => ({
      address,
      ...(record.voteCount !== 0n ? { voteCount: Number(record.voteCount) } : {}),
      url: record.url,
      ...(address === WITNESS_ADDRESS
        ? {
            totalProduced: Number(node.head().number),
            latestBlockNum: Number(node.head().number),
            // the slot a block time falls in, counted from the genesis timestamp
            latestSlotNum: Math.floor(node.head().timestampMs / BLOCK_INTERVAL_MS),
            isJobs: true,
          }
        : {}),
    })),
  }
}

export function registerNodeInfoHandlers(registry: Registry): void {
  const nodeInfo: Handler = (node) => {
    const head = node.head()
    const blockTag = `Num:${Number(head.number)},ID:${head.blockID}`
    return {
      beginSyncNum: Number(head.number),
      block: blockTag,
      solidityBlock: blockTag,
      currentConnectCount: 0,
      activeConnectCount: 0,
      passiveConnectCount: 0,
      totalFlow: 0,
      peerList: [],
      configNodeInfo: {
        codeVersion: NODE_INFO_CODE_VERSION,
        // the build number that ships with the advertised codeVersion
        versionNum: '18817',
        p2pVersion: '11111',
        // the P2P listen port, which this node does not open; the HTTP port
        // belongs to a different field
        listenPort: 0,
        discoverEnable: false,
        activeNodeSize: 0,
        passiveNodeSize: 0,
        sendNodeSize: 0,
        maxConnectCount: 0,
        sameIpMaxConnectCount: 0,
        backupListenPort: 0,
        backupMemberSize: 0,
        backupPriority: 0,
        dbVersion: 2,
        minParticipationRate: 0,
        supportConstant: true,
        minTimeRatio: new Float(0),
        maxTimeRatio: new Float(5),
        allowCreationOfContracts: 1,
        allowAdaptiveEnergy: 0,
      },
      machineInfo: machineInfo(),
      cheatWitnessInfoMap: {},
    }
  }

  // handwritten reply: zero values stay on the wire
  registry.register('wallet/getnodeinfo', nodeInfo, {
    solidity: true,
    verbatim: true,
    selfPrinted: true,
  })

  const listNodes: Handler = () => ({ nodes: [] })
  registry.register('wallet/listnodes', listNodes)
  registry.register('net/listnodes', listNodes)

  registry.register(
    'wallet/listwitnesses',
    (node, params) => withVisibleAddresses(witnessList(node), isVisible(params)),
    { solidity: true },
  )

  // the same set, taken a page at a time; a page that starts past the end has
  // nothing to answer with
  registry.register('wallet/getpaginatednowwitnesslist', paginatedNowWitnessList)
  registry.register('walletsolidity/getpaginatednowwitnesslist', paginatedNowWitnessListSolidity)

  registry.register('wallet/getchainparameters', (node) => {
    const params = node.config.chainParameters
    return {
      chainParameter: [
        { key: 'getMaintenanceTimeInterval', value: params.maintenanceTimeIntervalMs },
        { key: 'getAccountUpgradeCost', value: params.accountUpgradeCost },
        { key: 'getCreateAccountFee', value: params.createAccountFee },
        { key: 'getTransactionFee', value: params.transactionFee },
        { key: 'getAssetIssueFee', value: params.assetIssueFee },
        { key: 'getWitnessPayPerBlock', value: params.witnessPayPerBlock },
        { key: 'getWitnessStandbyAllowance', value: 115_200_000_000 },
        {
          key: 'getCreateNewAccountFeeInSystemContract',
          value: params.createNewAccountFeeInSystemContract,
        },
        { key: 'getCreateNewAccountBandwidthRate', value: 1 },
        { key: 'getAllowCreationOfContracts', value: 1 },
        { key: 'getRemoveThePowerOfTheGr', value: -1 },
        { key: 'getEnergyFee', value: params.energyFee },
        { key: 'getExchangeCreateFee', value: 1_024_000_000 },
        { key: 'getMaxCpuTimeOfOneTx', value: 80 },
        { key: 'getAllowUpdateAccountName', value: params.allowUpdateAccountName },
        { key: 'getAllowSameTokenName', value: params.allowSameTokenName },
        { key: 'getAllowDelegateResource', value: params.allowDelegateResource },
        { key: 'getTotalEnergyLimit', value: params.totalEnergyCurrentLimit },
        { key: 'getAllowTvmTransferTrc10', value: 1 },
        { key: 'getTotalEnergyCurrentLimit', value: params.totalEnergyCurrentLimit },
        { key: 'getAllowMultiSign', value: params.allowMultiSign },
        { key: 'getAllowAdaptiveEnergy', value: 0 },
        {
          key: 'getTotalEnergyTargetLimit',
          value: Math.floor(params.totalEnergyCurrentLimit / 14400),
        },
        { key: 'getTotalEnergyAverageUsage', value: 0 },
        { key: 'getUpdateAccountPermissionFee', value: params.updateAccountPermissionFee },
        { key: 'getMultiSignFee', value: params.multiSignFee },
        { key: 'getAllowAccountStateRoot', value: 0 },
        { key: 'getAllowProtoFilterNum', value: 0 },
        { key: 'getAllowTvmConstantinople', value: 1 },
        { key: 'getAllowTvmSolidity059', value: 1 },
        { key: 'getAllowTvmIstanbul', value: 1 },
        { key: 'getAllowShieldedTRC20Transaction', value: 1 },
        { key: 'getForbidTransferToContract', value: params.forbidTransferToContract },
        { key: 'getAdaptiveResourceLimitTargetRatio', value: 10 },
        { key: 'getAdaptiveResourceLimitMultiplier', value: 1000 },
        { key: 'getChangeDelegation', value: params.allowChangeDelegation },
        { key: 'getWitness127PayPerBlock', value: params.witness127PayPerBlock },
        { key: 'getAllowMarketTransaction', value: 0 },
        { key: 'getMarketSellFee', value: 0 },
        { key: 'getMarketCancelFee', value: 0 },
        { key: 'getAllowPBFT', value: 0 },
        { key: 'getAllowTransactionFeePool', value: 0 },
        { key: 'getMaxFeeLimit', value: params.maxFeeLimit },
        { key: 'getAllowOptimizeBlackHole', value: 1 },
        { key: 'getAllowNewResourceModel', value: params.allowNewResourceModel },
        { key: 'getAllowTvmFreeze', value: 0 },
        { key: 'getAllowTvmVote', value: 0 },
        { key: 'getAllowTvmLondon', value: 1 },
        { key: 'getAllowTvmCompatibleEvm', value: 0 },
        { key: 'getAllowAccountAssetOptimization', value: 0 },
        { key: 'getFreeNetLimit', value: params.freeNetLimit },
        { key: 'getTotalNetLimit', value: params.totalNetLimit },
        {
          key: 'getAllowHigherLimitForMaxCpuTimeOfOneTx',
          value: node.runtime.common.activatedProposals.includes(65) ? 1 : 0,
        },
        { key: 'getAllowAssetOptimization', value: 1 },
        { key: 'getAllowNewReward', value: 1 },
        { key: 'getMemoFee', value: params.memoFee },
        { key: 'getAllowDelegateOptimization', value: 1 },
        { key: 'getUnfreezeDelayDays', value: params.unfreezeDelayDays },
        { key: 'getAllowOptimizedReturnValueOfChainId', value: 1 },
        { key: 'getAllowDynamicEnergy', value: 0 },
        { key: 'getDynamicEnergyThreshold', value: 5_000_000_000 },
        { key: 'getDynamicEnergyIncreaseFactor', value: 2000 },
        { key: 'getDynamicEnergyMaxFactor', value: 34_000 },
        { key: 'getAllowTvmShangHai', value: 1 },
        { key: 'getAllowCancelAllUnfreezeV2', value: params.allowCancelAllUnfreezeV2 },
        { key: 'getMaxDelegateLockPeriod', value: params.maxDelegateLockPeriod },
        { key: 'getAllowOldRewardOpt', value: 1 },
        { key: 'getAllowEnergyAdjustment', value: 0 },
        { key: 'getMaxCreateAccountTxSize', value: params.maxCreateAccountTxSize },
        { key: 'getAllowStrictMath', value: 1 },
        { key: 'getConsensusLogicOptimization', value: 1 },
        { key: 'getAllowTvmCancun', value: 1 },
        { key: 'getAllowTvmBlob', value: 1 },
        { key: 'getAllowTvmSelfdestructRestriction', value: 1 },
        { key: 'getProposalExpireTime', value: 259_200_000 },
        {
          key: 'getAllowTvmOsaka',
          value: node.runtime.common.activatedProposals.includes(96) ? 1 : 0,
        },
        { key: 'getAllowTvmPrague', value: 0 },
        { key: 'getAllowHardenResourceCalculation', value: 0 },
        { key: 'getAllowHardenExchangeCalculation', value: 0 },
      ],
    }
  })

  registry.register('wallet/getnextmaintenancetime', (node) => ({
    num: nextMaintenanceTime(node),
  }))

  // This node has no proposal-history state. Its price endpoints therefore
  // report the single genesis price that also drives fee charging.
  registry.register(
    'wallet/getenergyprices',
    (node) => ({ prices: `0:${node.config.chainParameters.energyFee}` }),
    { solidity: true },
  )

  registry.register(
    'wallet/getbandwidthprices',
    (node) => ({ prices: `0:${node.config.chainParameters.transactionFee}` }),
    { solidity: true },
  )

  registry.register('wallet/getmemofee', (node) => ({
    prices: `0:${node.config.chainParameters.memoFee}`,
  }))
}
