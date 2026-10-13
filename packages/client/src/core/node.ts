import { AsyncLocalStorage } from 'node:async_hooks'

import { createBlock, paramsBlock } from '@tvmjs/block'
import { Common, Hardfork, TronMainnet, createCustomCommon } from '@tvmjs/common'
import { MerkleStateManager } from '@tvmjs/statemanager'
import { paramsTVM } from '@tvmjs/tvm'
import {
  Account,
  EthereumJSErrorWithoutCode,
  bytesToBigInt,
  bytesToHex,
  createAddressFromString,
  hexToBytes,
  setLengthLeft,
} from '@tvmjs/util'
import { createVM, paramsVM } from '@tvmjs/vm'
import { TronWeb } from 'tronweb'

import { TRON_VM_GAS_PRICE } from '../chainParameters.ts'
import { HD_PATH } from '../hdWallet.ts'
import { INT64_MAX } from '../intBounds.ts'
import { NodeLog } from '../logging.ts'
import { AssetRegistry } from './assets.ts'
import { BlockStore, BlockStoreBlockchain, rawHeaderOf } from './blockStore.ts'
import { Clock } from './clock.ts'
import { executeTransaction } from './execution.ts'
import {
  BlockTimeChangeError,
  DuplicateTransactionError,
  TransactionRejectedError,
} from './mining.ts'
import { rawHeaderHash, transactionMerkleRoot } from './tronBlock.ts'
import { MAX_BLOCK_TIME_SECONDS, MAX_MINE_BLOCKS, requireInteger } from './validation.ts'
import {
  WITNESS_ADDRESS,
  WITNESS_BROKERAGE,
  WITNESS_INITIAL_BALANCE_SUN,
  WITNESS_URL,
  WITNESS_VOTE_COUNT,
  brokerageShareSun,
} from './witness.ts'

import type { ParamsDict } from '@tvmjs/common'
import type { ExecResult, InterpreterStep, Message } from '@tvmjs/tvm'
import type { Address } from '@tvmjs/util'

import type { VM } from '@tvmjs/vm'

import { accountsFromMnemonic, resolveConfig } from '../config.ts'

import type { NodeAccounts } from '../accounts.ts'
import type {
  AccountConfig,
  ClientConfig,
  GenesisConfig,
  NodeRuntimeOptions,
  ResolvedConfig,
} from '../config.ts'
import type { AssetInput, AssetMeta } from './assets.ts'
import type { BlockRecord, TronTxRecord } from './blockStore.ts'
import type { TransactionExecution } from './execution.ts'
import type { PendingTransaction } from './mining.ts'

const BLOCK_GAS_LIMIT = 1_000_000_000_000n
/** the low 160 bits an address word carries */
const ADDRESS_MASK = (1n << 160n) - 1n

function balanceFault(balance: bigint): string | undefined {
  if (balance < 0n) return 'the balance is below zero'
  if (balance > INT64_MAX) {
    return `the balance is past ${INT64_MAX}, the widest an account holds`
  }
  return undefined
}

/** Apply configured values over each library's default parameter groups. */
function mergedParams(defaults: ParamsDict, overrides: ParamsDict): ParamsDict {
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(overrides).map(([group, values]) => [
        group,
        { ...defaults[group], ...values },
      ]),
    ),
  }
}

const GENESIS_TIMESTAMP_MS = 0
const BLACKHOLE_ADDRESS = '0x77944d19c052b73ee2286823aa83f8138cb7032f'

/** the one place block headers are shaped, shared by genesis and every seal */
function buildBlock(
  common: Common,
  number: bigint,
  parentHash: Uint8Array,
  stateRoot: Uint8Array,
  timestampMs: number,
  params: ParamsDict,
) {
  return createBlock(
    {
      header: {
        number,
        parentHash,
        stateRoot,
        // header timestamps are in seconds (TIMESTAMP opcode); the REST
        // layer serves timestampMs from the block record instead
        timestamp: BigInt(Math.floor(timestampMs / 1000)),
        gasLimit: BLOCK_GAS_LIMIT,
        ...(number === 0n ? {} : { coinbase: tronHexToAddress(WITNESS_ADDRESS) }),
      },
    },
    { common, params: mergedParams(paramsBlock, params), skipConsensusFormatValidation: true },
  )
}
/** free-bandwidth recovery window (chain constant, 24h) */
const BANDWIDTH_WINDOW_MS = 86_400_000
/** block cadence: the slot usage bookkeeping counts in, and what converts lock periods stated in blocks to time */
const BLOCK_INTERVAL_MS = 3_000
/** the window counted in block slots, the unit usage bookkeeping runs in */
const USAGE_WINDOW_SLOTS = BANDWIDTH_WINDOW_MS / BLOCK_INTERVAL_MS
/** fixed-point scale of the per-slot average a ledger is kept as */
const USAGE_PRECISION = 1_000_000

/**
 * A usage ledger read or charged at `nowMs`. The ledger is kept as a per-slot
 * average at fixed precision: the held usage becomes `ceil(held × precision /
 * window)`, decays by `round(average × (window − Δslots) / window)` — nothing
 * is left once a whole window has passed — and the new bytes join it as their
 * own average; the sum converts back through `floor(average × window /
 * precision)`. The ceil/round/floor steps are what the chain's arithmetic
 * does, so the integers that come out match it exactly.
 */
export function windowedUsage(held: number, lastMs: number, nowMs: number, bytes: number): number {
  const window = USAGE_WINDOW_SLOTS
  const slotOf = (ms: number): number => Math.floor(ms / BLOCK_INTERVAL_MS)
  let average = Math.ceil((held * USAGE_PRECISION) / window)
  const delta = slotOf(nowMs) - slotOf(lastMs)
  if (delta > 0) {
    average = delta < window ? Math.round((average * (window - delta)) / window) : 0
  }
  average += Math.ceil((bytes * USAGE_PRECISION) / window)
  return Math.floor((average * window) / USAGE_PRECISION)
}

export interface ContractMeta {
  /** ABI entries as stored on-chain (abi.entrys); absent where none was ever set */
  abi?: unknown[]
  /** whether a code write has put a hash on this record */
  codeHashed?: boolean
  name: string
  /** 41-prefixed hex of the creator; absent where no deployment is on record */
  originAddress?: string
  /** creation bytecode hex, no 0x (getcontract.bytecode) */
  bytecode: string
  /** share of the energy bill the caller pays, 0..100 */
  consumeUserResourcePercent: number
  /** energy the contract account is willing to cover per call */
  originEnergyLimit: number
  /** root transaction id, carried only by contracts a salted create made */
  trxHash?: string
  /** source contract-version field; version one has a transfer restriction under its proposal */
  version?: number
}

export interface CallParams {
  caller: Address
  /** canonical transaction id; TRON CREATE addresses derive from it at every depth */
  rootTransactionId?: Uint8Array
  /** absent for a create frame, where the data is the init code */
  to?: Address
  data: Uint8Array
  value?: bigint
  energyLimit?: bigint
  tokenId?: bigint
  tokenValue?: bigint
  /** Run creation code at the transaction-derived TRON address. */
  deployAddress?: Address
}

export interface CallResult {
  execResult: ExecResult
  energyUsed: bigint
  returnValue: Uint8Array
  reverted: boolean
  /** internal messages (depth > 0) in execution order */
  internalTxs: InternalCall[]
}

export interface WriteParams extends CallParams {
  /** deploy: set create=true + deployAddress; `data` is the init code */
  create?: boolean
  /**
   * A TransferContract: value moves to `to` and no code runs, whatever `to`
   * holds — the transfer actuator never enters the VM.
   */
  plainTransfer?: boolean
}

/** one internal message frame (depth > 0) captured during execution */
export interface InternalCall {
  caller: Address
  /** undefined while a create frame is in flight; filled from createdAddress */
  to?: Address
  /** the frame that made this one, or -1 when the transaction itself did */
  parentIndex: number
  valueSun: bigint
  /** call data of the frame (empty for plain transfers and create frames) */
  data: Uint8Array
  tokenId?: bigint
  tokenValue?: bigint
  create: boolean
  /** the create carried a salt, which also decides its address formula */
  create2?: boolean
  /** the frame was made by a contract destroying itself */
  suicide?: boolean
  /** TRC-10 amounts the frame carries beside its TRX value, by asset id */
  tokens?: [bigint, bigint][]
  rejected: boolean
}

export interface WriteResult {
  /** Captured VM inputs for historical replay; absent for state-only operations. */
  execution?: TransactionExecution
  execResult: ExecResult
  energyUsed: bigint
  /** energy fee deducted from the sender, in sun */
  energyFeeSun: bigint
  /** energy drawn from the caller's stake before any sun was burned */
  energyFromStake?: bigint
  /** energy the contract's origin covered from its own stake */
  originEnergyUsage?: bigint
  returnValue: Uint8Array
  reverted: boolean
  createdAddress?: Address
  deployAddress?: Address
  /** internal messages (depth > 0) in execution order */
  internalTxs: InternalCall[]
  /** bandwidth accounting, filled by the broadcast path */
  netUsage?: number
  netFeeSun?: bigint
  /** extra chain fees (e.g. new-account creation), filled by the broadcast path */
  extraFeeSun?: bigint
  /** memo fee, charged when raw_data carries a memo */
  memoFeeSun?: bigint
  /** multi-signature fee, charged when the transaction carries more than one */
  multiSignFeeSun?: bigint
}

/** the account-record permission shape, as the state manager round-trips it */
export interface StoredPermissionLike {
  type: number
  id: number
  permissionName: string
  threshold: bigint
  parentId: number
  operations: Uint8Array
  keys: { address: Uint8Array; weight: bigint }[]
}

/** durable witness-store fields, apart from production counters derived from blocks */
export interface WitnessRecord {
  /** UTF-8 form of Witness.url */
  url: string
  /** votes finalized for this candidate, in whole TRX */
  voteCount: bigint
}

/** one tranche of an issuance's own supply, locked until its window passes */
export interface FrozenSupply {
  frozenBalance: bigint
  /** head-block time at which the tranche becomes spendable */
  expireTime: bigint
}

export type StakeResource = 'BANDWIDTH' | 'ENERGY' | 'TRON_POWER'
export type DelegatableResource = Exclude<StakeResource, 'TRON_POWER'>

/** one pending Stake 2.0 unstake, withdrawable once its window passes */
export interface UnfrozenV2Entry {
  type: StakeResource
  amount: bigint
  /** head-block time the amount becomes withdrawable */
  expireMs: number
}

/** sun per resource, the shape every stake balance travels in */
export interface StakePair {
  bandwidth: bigint
  energy: bigint
}

/** Stake 2.0 stores the independent voting-power resource alongside quotas. */
export interface FrozenStakePair extends StakePair {
  tronPower: bigint
}

/** A Stake 1.0 balance and the block time at which it may be released. */
export interface LegacyFrozenBalance {
  amount: bigint
  expireMs: number
}

/**
 * Stake 1.0 keeps one independent freeze for each resource. Bandwidth is a
 * repeated field on the wire, but the transaction rules admit at most one entry.
 */
export interface LegacyFrozenPair {
  bandwidth?: LegacyFrozenBalance
  energy?: LegacyFrozenBalance
  tronPower?: LegacyFrozenBalance
}

/** One Stake 1.0 delegation; its two resources share the same pair key. */
export interface LegacyDelegationEntry {
  fromKey: string
  toKey: string
  bandwidth: bigint
  energy: bigint
  expireBandwidthMs: number
  expireEnergyMs: number
}

/**
 * Sun one account delegated to another. Locked and unlocked amounts live in
 * separate entries of the same pair — an expired lock merges into the
 * unlocked entry the next time the pair is written.
 */
export interface DelegationEntry {
  fromKey: string
  toKey: string
  locked: boolean
  bandwidth: bigint
  energy: bigint
  /** head-block time each locked amount unlocks; 0 on unlocked entries */
  expireBandwidthMs: number
  expireEnergyMs: number
}

const TRX_SUN = 1_000_000n
/** lock period applied when a locked delegation states none, in blocks */
const DEFAULT_DELEGATE_LOCK_BLOCKS = 86_400

/**
 * What this node keeps for one account beside the state trie. Every field is
 * something the `protocol.Account` message itself carries.
 */
interface AccountRecord {
  /** free-bandwidth usage and the point it was last charged */
  bandwidth?: { usedBytes: number; lastMs: number }
  /** per-asset free-bandwidth usage this holder has drawn, by asset id */
  assetNet?: Record<number, { usedBytes: number; lastMs: number }>
  /** head-block time the resource layer last billed this account */
  operationAt?: number
  /** the block whose flush first wrote this account to the root store */
  createdIn?: bigint
  /** head-block time this address first held state */
  createdAt?: number
  /** declared at creation (AccountType); absent means Normal */
  accountType?: 'AssetIssue' | 'Contract'
  /** protobuf account-name bytes, encoded as lowercase hex */
  name?: string
  /** unwithdrawn block rewards, in sun */
  allowance?: bigint
  /** the reshaped permission set, absent while the defaults stand */
  permissions?: StoredPermissionLike[]
  /** head-block time of the last committed energy preparation or billing */
  energyConsumedAt?: number
  /** locked issuance supply, for an issuer */
  frozenSupply?: FrozenSupply[]
  /** Stake 2.0: sun this account froze, per resource */
  frozenV2?: FrozenStakePair
  /**
   * The resource entries present in frozenV2, in
   * protobuf-list order. A full account read pads a response-only copy, while
   * an id lookup returns this stored list unchanged.
   */
  frozenV2Order?: StakeResource[]
  /** Stake 1.0: each resource's balance and release time */
  frozenLegacy?: LegacyFrozenPair
  /** migration snapshot used while the independent voting-power resource is active */
  oldTronPower?: bigint
  /** Stake 2.0: pending unstakes, oldest first */
  unfrozenV2?: UnfrozenV2Entry[]
  /** sun delegated away to other accounts, per resource */
  delegatedOut?: StakePair
  /** sun other accounts delegated here, per resource */
  acquired?: StakePair
  /** Stake 1.0: sun this account delegated to other accounts */
  delegatedLegacyOut?: StakePair
  /** Stake 1.0: sun other accounts delegated here */
  acquiredLegacy?: StakePair
  /** staked-bandwidth usage and the point it was last charged */
  stakedNet?: { usedBytes: number; lastMs: number }
  /** staked-energy usage and the point it was last charged */
  energyLedger?: { used: number; lastMs: number }
}

export type BandwidthOutcome =
  | { source: 'staked' }
  | { source: 'free' }
  | { source: 'asset' }
  | { source: 'burn'; feeSun: bigint }
  | { source: 'insufficient'; feeSun: bigint }

function copyRuntime(runtime: NodeRuntimeOptions): NodeRuntimeOptions {
  return {
    ...runtime,
    common: {
      eips: [...runtime.common.eips],
      activatedProposals: [...runtime.common.activatedProposals],
      params: Object.fromEntries(
        Object.entries(runtime.common.params).map(([group, params]) => [group, { ...params }]),
      ),
    },
    ...(runtime.logger === undefined ? {} : { logger: { ...runtime.logger } }),
  }
}

function copyGenesis(config: GenesisConfig): GenesisConfig {
  return {
    mnemonic: { ...config.mnemonic },
    accounts: config.accounts.map((account) => ({ ...account })),
    chainParameters: { ...config.chainParameters },
  }
}

/**
 * Passive, protocol-agnostic dev-node core: state only advances
 * when a method is called — there is no background sync or gossip loop.
 * TRON wire semantics (base58, protobuf, response shapes) live in the dialect
 * layer, not here.
 */
export class NodeCore {
  /** The node's owned startup configuration; never returned by reference. */
  private readonly configState: ResolvedConfig
  readonly common: Common
  readonly vm: VM
  readonly stateManager: MerkleStateManager
  readonly blocks: BlockStore
  readonly clock: Clock
  /** contract metadata registry, keyed by lowercase unprefixed 40-char hex */
  readonly contracts: Map<string, ContractMeta>
  /**
   * Every storage slot this node has written, by account. A trie is keyed by
   * the hash of a slot, so the slots themselves are only knowable to whoever
   * wrote them; the storage range reports slots, and reads them back from here.
   *
   * It stands outside the transaction boundary: an entry says only that the
   * slot was written at some point, and a read checks the state for what it
   * holds now — so a rolled-back write leaves a slot that reads as empty.
   */
  readonly storageSlots: Map<string, Map<string, Uint8Array>>
  /** txid (64 hex, no 0x) → record; populated by the write path */
  readonly txs: Map<string, TronTxRecord>
  /** base58 addresses whose broadcasts skip signature checks (tre_unlockedAccounts) */
  readonly unlockedAccounts: Set<string>
  /** TRC-10 issuance metadata; balances live on accounts */
  readonly assets: AssetRegistry
  /**
   * Per-account bookkeeping, by address key: the account-record fields the
   * state trie's account model has no room for.
   */
  private readonly accounts: Map<string, AccountRecord>
  /** account batches minted through the dev generation endpoint, in order */
  readonly generatedAccounts: { mnemonic: string; accounts: AccountConfig[] }[]
  /** chain-wide account name registry: lower-cased name → owner (41-hex) */
  readonly accountNames: Map<string, string>
  /** chain-wide account id registry: lower-cased id → owner (41-hex) */
  readonly accountIds: Map<string, string>
  /** witness address key → its persistent candidate record */
  private readonly witnesses: Map<string, WitnessRecord>
  /** whether the head block is the maintenance block for its interval */
  private maintenanceInProgress: boolean
  /** total TRX burned by fees, reported by getburntrx */
  burnedSun: bigint
  /** Stake 2.0 delegations, keyed (from, to, locked) */
  readonly delegations: Map<string, DelegationEntry>
  /** (from, to) pairs with their latest delegation time, feeding the account index */
  private readonly delegationPairs: Map<
    string,
    { fromKey: string; toKey: string; timestampMs: number }
  >
  /** Stake 1.0 delegations, keyed by (from, to) */
  private readonly legacyDelegations: Map<string, LegacyDelegationEntry>
  /** Stake 1.0 account-index pairs with their latest delegation time */
  private readonly legacyDelegationPairs: Map<
    string,
    { fromKey: string; toKey: string; timestampMs: number }
  >
  /** chain-wide staked weights in TRX, the denominators of every quota */
  totalNetWeightTrx: bigint
  totalEnergyWeightTrx: bigint
  totalTronPowerWeightTrx: bigint
  private writeQueue: Promise<unknown>
  private readonly lockHolder: AsyncLocalStorage<{ active: boolean }>
  private blockTimer: ReturnType<typeof setInterval> | undefined
  private blockTimeSeconds = 0
  private readonly pendingTransactions = new Map<
    string,
    PendingTransaction & { record: TronTxRecord }
  >()
  private pendingState: NodeCore | undefined
  private readonly isPendingState: boolean
  private readonly blockListeners = new Set<(block: BlockRecord) => void>()
  readonly log: NodeLog
  /** Shared by every transaction and the header of the block being produced. */
  private blockTimestampMs: number | undefined
  /** how to put back what the write in flight has changed, newest last */
  private journal: (() => void)[] | undefined

  protected constructor(
    config: ResolvedConfig,
    common: Common,
    vm: VM,
    stateManager: MerkleStateManager,
    clock: Clock,
    blocks: BlockStore,
    source?: NodeCore,
  ) {
    this.configState = config
    this.lockHolder = new AsyncLocalStorage()
    this.log = new NodeLog(config.runtime.logger, (callback) => this.lockHolder.exit(callback))
    this.common = common
    this.vm = vm
    this.stateManager = stateManager
    this.clock = clock
    // Pending execution owns mutable chain state; committed history and signer
    // policy remain shared reads. Only the canonical node seals and indexes.
    this.isPendingState = source !== undefined
    this.blocks = blocks
    this.txs = source?.txs ?? new Map()
    this.unlockedAccounts = source?.unlockedAccounts ?? new Set()
    this.contracts = structuredClone(source?.contracts ?? new Map())
    this.storageSlots = structuredClone(source?.storageSlots ?? new Map())
    this.assets = source?.assets.copy() ?? new AssetRegistry()
    this.accounts = structuredClone(source?.accounts ?? new Map())
    this.accountNames = new Map(source?.accountNames)
    this.accountIds = new Map(source?.accountIds)
    this.witnesses = structuredClone(
      source?.witnesses ??
        new Map([
          [
            addressKey(tronHexToAddress(WITNESS_ADDRESS)),
            { url: WITNESS_URL, voteCount: BigInt(WITNESS_VOTE_COUNT) },
          ],
        ]),
    )
    this.maintenanceInProgress = source?.maintenanceInProgress ?? false
    this.generatedAccounts = structuredClone(source?.generatedAccounts ?? [])
    this.burnedSun = source?.burnedSun ?? 0n
    this.delegations = structuredClone(source?.delegations ?? new Map())
    this.delegationPairs = structuredClone(source?.delegationPairs ?? new Map())
    this.legacyDelegations = structuredClone(source?.legacyDelegations ?? new Map())
    this.legacyDelegationPairs = structuredClone(source?.legacyDelegationPairs ?? new Map())
    this.totalNetWeightTrx = source?.totalNetWeightTrx ?? 0n
    this.totalEnergyWeightTrx = source?.totalEnergyWeightTrx ?? 0n
    this.totalTronPowerWeightTrx = source?.totalTronPowerWeightTrx ?? 0n
    this.writeQueue = Promise.resolve()
    this.journal = undefined
  }

  /** A disposable chain-birth snapshot for callers to inspect. */
  get config(): GenesisConfig {
    return copyGenesis(this.configState)
  }

  /** A disposable snapshot of process-local execution controls. */
  get runtime(): NodeRuntimeOptions {
    return copyRuntime(this.configState.runtime)
  }

  /** A fresh credential snapshot, shared by the public node and account endpoint. */
  getAccounts(): NodeAccounts {
    const config = this.configState
    const mnemonicAccounts = accountsFromMnemonic(config.mnemonic)
    return {
      mnemonic: config.mnemonic.phrase,
      hdPath: HD_PATH,
      privateKeys: mnemonicAccounts.map((account) => account.privateKey),
      more: [
        ...(config.accounts.length === 0
          ? []
          : [
              {
                privateKeys: config.accounts.map((account) => account.privateKey),
                more: [],
              },
            ]),
        ...this.generatedAccounts.map((batch) => ({
          mnemonic: batch.mnemonic,
          hdPath: HD_PATH,
          privateKeys: batch.accounts.map((account) => account.privateKey),
          more: [],
        })),
      ],
    }
  }

  static async create(config: ClientConfig = {}, clock = new Clock()): Promise<NodeCore> {
    const configState = resolveConfig(config)
    const commonOptions = { ...configState.runtime.common, hardfork: Hardfork.Tron }
    const base = new Common({ chain: TronMainnet, ...commonOptions })
    const stateManager = new MerkleStateManager({ common: base })

    const blackhole = createAddressFromString(BLACKHOLE_ADDRESS)
    await stateManager.modifyAccountFields(blackhole, { balance: 0n })
    await stateManager.modifyAccountFields(tronHexToAddress(WITNESS_ADDRESS), {
      balance: WITNESS_INITIAL_BALANCE_SUN,
    })

    // Configured balances override system defaults, including explicit zero.
    // All genesis accounts contribute to the state root and chain ID.
    const mnemonicAccounts = accountsFromMnemonic(configState.mnemonic)
    const genesisAccounts = [...mnemonicAccounts, ...configState.accounts]
    for (const account of genesisAccounts) {
      const base58 = TronWeb.address.fromPrivateKey(account.privateKey) as string
      const address = tronHexToAddress(TronWeb.address.toHex(base58))
      await stateManager.modifyAccountFields(address, { balance: account.balance })
    }

    // genesis (block 0) snapshots the prefunded state, and CHAINID is the tail
    // of its block ID — so it is built before the chain config that carries it.
    // Its timestamp is 0: the block ID, and with it
    // the chain ID, is then a property of the account set rather than of when
    // the node happened to boot.
    const genesis = buildBlock(
      base,
      0n,
      new Uint8Array(32),
      await stateManager.getStateRoot(),
      GENESIS_TIMESTAMP_MS,
      commonOptions.params,
    )
    const chainId = Number(
      bytesToBigInt(
        rawHeaderHash(
          rawHeaderOf({
            number: 0n,
            timestampMs: GENESIS_TIMESTAMP_MS,
            parentBlockID: '0'.repeat(64),
            accountStateRoot: bytesToHex(genesis.header.stateRoot).slice(2),
          }),
        ).subarray(-4),
      ),
    )

    const common = createCustomCommon({ chainId }, TronMainnet, commonOptions)
    const blocks = new BlockStore()
    const vm = await createVM({
      common,
      stateManager,
      blockchain: new BlockStoreBlockchain(blocks),
      params: mergedParams(paramsVM, commonOptions.params),
      tvmOpts: { params: mergedParams(paramsTVM, commonOptions.params) },
    })
    const node = new NodeCore(configState, common, vm, stateManager, clock, blocks)
    node.setAccountName(blackhole, bytesToHex(new TextEncoder().encode('Blackhole')).slice(2))
    node.setAccountName(
      tronHexToAddress(WITNESS_ADDRESS),
      bytesToHex(new TextEncoder().encode('Zion')).slice(2),
    )
    await node.setPermissions(blackhole, [
      {
        type: 0,
        id: 0,
        permissionName: 'owner',
        threshold: 1n,
        parentId: 0,
        operations: new Uint8Array(),
        keys: [{ address: new Uint8Array(20), weight: 1n }],
      },
    ])
    node.blocks.put(genesis, [], GENESIS_TIMESTAMP_MS)
    // block production starts at once: a head sitting at
    // genesis would print no number at all (0 is a proto3 default), and
    // ref-block derivation reads that number
    const firstBlock = await node.sealBlock([])
    node.log.committed(firstBlock)
    return node
  }

  /**
   * Serialize state access. Every request enters here — writers so execute +
   * seal cannot interleave at await points, readers so they observe the chain
   * before a write or after it, never the middle of one. Reentrant: a task
   * already holding the lock runs nested acquisitions inline.
   */
  withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    if (this.lockHolder.getStore()?.active === true) return task()
    const run = this.writeQueue.then(() => {
      const owner = { active: true }
      return this.lockHolder.run(owner, async () => {
        try {
          return await task()
        } finally {
          owner.active = false
        }
      })
    })
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * One write, all or nothing. Everything the chain is made of takes part: the
   * trie through its own checkpoint, every table beside it through the entries
   * `recordUndo` collects, and the scalars through the values read here. A
   * fault anywhere inside leaves the chain exactly as it was found — no block,
   * no receipt, no moved balance, and the transaction free to be sent again.
   *
   * A returned value commits.
   * Every throw unwinds — a machinery fault and a chain-rule rejection alike.
   */
  async transact<T>(work: () => Promise<T>): Promise<T> {
    // Each transaction in a block has a savepoint. Successful inner writes
    // remain in the outer journal so a later block failure can undo them too.
    const parentJournal = this.journal
    const undo = parentJournal ?? []
    const start = undo.length
    // The trie unwinds by its root: the nodes it is made of are keyed by their
    // own hash, so an earlier root stays readable and pointing back at it
    // restores the whole of it.
    const root = await this.stateManager.getStateRoot()
    const burnedSun = this.burnedSun
    this.journal = undo
    let committed = false
    try {
      const result = await work()
      committed = true
      if (parentJournal === undefined) this.pendingState = undefined
      return result
    } finally {
      try {
        if (!committed) {
          await this.stateManager.setStateRoot(root)
          for (let i = undo.length - 1; i >= start; i -= 1) undo[i]?.()
          undo.length = start
          this.burnedSun = burnedSun
        }
      } finally {
        this.journal = parentJournal
      }
    }
  }

  /**
   * State a table change to the write in flight, as the call that puts it back.
   * Outside a write this is nothing — the change is already permanent.
   */
  recordUndo(undo: () => void): void {
    this.journal?.push(undo)
  }

  head(): BlockRecord {
    return this.blocks.head()
  }

  /** Observe committed blocks; the returned function removes the listener. */
  onBlock(listener: (block: BlockRecord) => void): () => void {
    this.blockListeners.add(listener)
    return () => {
      this.blockListeners.delete(listener)
    }
  }

  private currentTimeMs(): number {
    return this.blockTimestampMs ?? this.clock.nowMs()
  }

  /** seal the current state into the next block (empty blocks are fine) */
  async sealBlock(txs: TronTxRecord[], txTrieRoot?: string): Promise<BlockRecord> {
    const timestampMs = this.currentTimeMs()
    const parent = this.blocks.height() < 0n ? undefined : this.blocks.head()
    // A maintenance block is externally visible until the next block arrives.
    // The current-witness full-node query uses this to avoid publishing the
    // witness store while its vote totals are being refreshed.
    const maintenanceBlock =
      parent !== undefined &&
      // A boundary is crossed between two produced headers. Genesis is a state
      // snapshot stamped at zero, so the first block after it crosses none.
      parent.number !== 0n &&
      this.maintenanceBucket(parent.timestampMs) !== this.maintenanceBucket(timestampMs)
    const priorMaintenance = this.maintenanceInProgress
    this.recordUndo(() => {
      this.maintenanceInProgress = priorMaintenance
    })
    this.maintenanceInProgress = maintenanceBlock
    const stateRoot = await this.stateManager.getStateRoot() // flushes internally
    const block = buildBlock(
      this.common,
      parent === undefined ? 0n : parent.number + 1n,
      parent?.block.hash() ?? new Uint8Array(32),
      stateRoot,
      timestampMs,
      this.configState.runtime.common.params,
    )
    // drop() of a block that never landed is a no-op
    const number = block.header.number
    this.recordUndo(() => this.blocks.drop(number))
    const record = this.blocks.put(block, txs, timestampMs, txTrieRoot)
    this.pendingState = undefined
    this.accrueBlockReward()
    return record
  }

  /** settle the block and standby payments into the producer allowance ledger */
  private accrueBlockReward(): void {
    const witness = tronHexToAddress(WITNESS_ADDRESS)
    if (this.configState.chainParameters.allowChangeDelegation !== 1) {
      this.creditAllowance(witness, BigInt(this.configState.chainParameters.witnessPayPerBlock))
      return
    }
    this.payWitnessReward(witness, BigInt(this.configState.chainParameters.witnessPayPerBlock))
    const standbys = this.standbyWitnesses()
    const voteSum = standbys.reduce((sum, [, record]) => sum + record.voteCount, 0n)
    if (voteSum <= 0n) return
    const eachVotePay = this.configState.chainParameters.witness127PayPerBlock / Number(voteSum)
    for (const [key, record] of standbys) {
      const pay = BigInt(Math.trunc(Number(record.voteCount) * eachVotePay))
      this.payWitnessReward(tronHexToAddress(`41${key}`), pay)
    }
  }

  /** the standby slice is ordered by vote weight, then canonical address, and excludes zeros */
  private standbyWitnesses(): [string, WitnessRecord][] {
    return [...this.witnesses]
      .filter(([, record]) => record.voteCount > 0n)
      .sort(([leftKey, left], [rightKey, right]) => {
        if (left.voteCount !== right.voteCount) return left.voteCount > right.voteCount ? -1 : 1
        return leftKey < rightKey ? 1 : leftKey > rightKey ? -1 : 0
      })
      .slice(0, 127)
  }

  /** credit the witness's configured share; voting is not enabled on this node. */
  private payWitnessReward(witness: Address, value: bigint): void {
    if (value <= 0n) return
    const brokerage = this.brokerageOf(witness)
    const witnessCut = brokerageShareSun(value, brokerage)
    this.creditAllowance(witness, witnessCut)
  }

  /** the sole configured witness has the protocol-default brokerage. */
  brokerageOf(_address: Address): number {
    return WITNESS_BROKERAGE
  }

  /** the absolute maintenance bucket a timestamp falls into */
  private maintenanceBucket(timestampMs: number): number {
    return Math.floor(timestampMs / this.configState.chainParameters.maintenanceTimeIntervalMs)
  }

  /** whether this address has a record in the witness store */
  isWitness(address: Address): boolean {
    return this.witnesses.has(addressKey(address))
  }

  /** a snapshot of witness-store rows, in deterministic address-key order */
  witnessEntries(): { address: string; record: WitnessRecord }[] {
    return [...this.witnesses]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, record]) => ({ address: `41${key}`, record: { ...record } }))
  }

  /** the fixed witness store has no pending vote overlay on this node */
  currentWitnessEntries(): { address: string; record: WitnessRecord }[] {
    return this.witnessEntries()
  }

  /** whether the latest block is the one that applied a maintenance transition */
  isMaintenanceInProgress(): boolean {
    return this.maintenanceInProgress
  }

  /** allowance already settled onto this account */
  allowanceOf(address: Address): bigint {
    return this.accounts.get(addressKey(address))?.allowance ?? 0n
  }

  /** add an accrued reward to the account allowance ledger */
  creditAllowance(address: Address, amountSun: bigint): void {
    if (amountSun < 0n) throw new RangeError('allowance credit must not be negative')
    const record = this.recordFor(address)
    record.allowance = (record.allowance ?? 0n) + amountSun
  }

  /** No public vote-write path exists, so rewards are fully settled allowance. */
  rewardOf(address: Address): bigint {
    return this.allowanceOf(address)
  }

  async mine(count = 1): Promise<BlockRecord> {
    requireInteger(count, 'blocks', 1, MAX_MINE_BLOCKS)
    return this.withWriteLock(async () => {
      let record = this.blocks.head()
      for (let i = 0; i < count; i++) {
        const pending = [...this.pendingTransactions.values()]
        record = await this.produceBlock(
          this.blockTimeSeconds === 0 ? pending.slice(0, 1) : pending,
        )
      }
      return record
    })
  }

  pendingSize(): number {
    return this.pendingTransactions.size
  }

  pendingIds(): string[] {
    return [...this.pendingTransactions.keys()]
  }

  pendingTransaction(txid: string): unknown {
    return this.pendingTransactions.get(txid)?.record.transaction
  }

  /** Preview the reply, admit against pending state, then mine in instant mode. */
  submitTransaction<T>(
    transaction: PendingTransaction,
    preview: (node: NodeCore) => Promise<T>,
  ): Promise<T> {
    return this.withWriteLock(async () => {
      if (this.txs.has(transaction.txid) || this.pendingTransactions.has(transaction.txid)) {
        throw new DuplicateTransactionError('Dup transaction.')
      }
      if (this.blockTimeSeconds > 0) {
        const pending = await this.getPendingState()
        const reply = await preview(pending)
        const { record } = await pending.transact(() => transaction.execute(pending))
        this.pendingTransactions.set(transaction.txid, { ...transaction, record })
        return reply
      }
      await this.minePendingIndividually()
      const reply = await preview(this)
      await this.produceBlock([transaction], { skipRejected: false })
      return reply
    })
  }

  /** Advance one isolated state per queue; rebuild only after canonical writes. */
  private async getPendingState(): Promise<NodeCore> {
    if (this.pendingState !== undefined) return this.pendingState
    const root = await this.stateManager.getStateRoot()
    const vm = await this.vm.shallowCopy()
    await vm.stateManager.setStateRoot(root)
    const pending = new NodeCore(
      this.configState,
      vm.common,
      vm,
      vm.stateManager as MerkleStateManager,
      this.clock,
      this.blocks,
      this,
    )
    pending.blockTimestampMs = this.head().timestampMs
    for (const transaction of this.pendingTransactions.values()) {
      try {
        await pending.transact(() => transaction.execute(pending))
      } catch (error) {
        if (!(error instanceof TransactionRejectedError)) throw error
      }
    }
    this.pendingState = pending
    return pending
  }

  private async minePendingIndividually(): Promise<void> {
    for (const transaction of this.pendingTransactions.values()) {
      await this.produceBlock([transaction], { allowEmpty: false, intervalSeconds: 0 })
    }
  }

  private async produceBlock(
    transactions: PendingTransaction[],
    { skipRejected = true, allowEmpty = true, intervalSeconds = this.blockTimeSeconds } = {},
  ): Promise<BlockRecord> {
    const parent = this.head()
    const timestampMs = Math.max(this.clock.nowMs(), parent.timestampMs + intervalSeconds * 1000)
    requireInteger(timestampMs, 'block time')
    this.blockTimestampMs = timestampMs
    const rejected: { txid: string; error: unknown }[] = []
    try {
      const block = await this.transact(async () => {
        const executed: Awaited<ReturnType<PendingTransaction['execute']>>[] = []
        for (const transaction of transactions) {
          try {
            executed.push(await this.transact(() => transaction.execute(this)))
          } catch (error) {
            if (!skipRejected || !(error instanceof TransactionRejectedError)) throw error
            rejected.push({ txid: transaction.txid, error })
          }
        }
        if (!allowEmpty && executed.length === 0) return this.head()
        const record = await this.sealBlock(
          executed.map((tx) => tx.record),
          transactionMerkleRoot(executed.map((tx) => tx.merkleLeaf)),
        )
        for (const tx of executed) {
          tx.record.blockNumber = record.number
          tx.finalize(record)
          this.recordUndo(() => this.txs.delete(tx.record.txid))
          this.txs.set(tx.record.txid, tx.record)
        }
        // Manual interval mining may advance beyond wall time. Keep subsequent
        // resource readings and development time jumps on that same clock.
        const now = this.clock.nowMs()
        if (timestampMs > now) this.clock.advanceMs(timestampMs - now)
        return record
      })
      // Remove accepted and rejected candidates only after the block commits.
      // An unexpected failure leaves the queue intact for a retry.
      for (const transaction of transactions) this.pendingTransactions.delete(transaction.txid)
      for (const { txid, error } of rejected) this.log.dropped(txid, error)
      if (block.number > parent.number) {
        this.log.committed(block)
        for (const listener of this.blockListeners) {
          try {
            listener(block)
          } catch {
            // Observer failures leave the committed block and its result intact.
          }
        }
      }
      return block
    } finally {
      this.blockTimestampMs = undefined
    }
  }

  /**
   * Move the clock forward and seal a block. Time is read from two places:
   * recovery windows read the clock, while expiry and lock-up windows read the
   * head block's time — the block is what carries the jump to the second kind.
   * The increase is a non-negative whole number of seconds.
   */
  async increaseTime(seconds: number): Promise<BlockRecord> {
    requireInteger(seconds, 'seconds')
    return this.withWriteLock(async () => {
      const clock = this.clock.snapshot()
      try {
        this.clock.advanceMs(seconds * 1000)
        return await this.mine(1)
      } catch (error) {
        this.clock.restore(clock)
        throw error
      }
    })
  }

  /**
   * Zero mines each transaction immediately. A positive interval queues
   * transactions for the next block. Switching back drains the existing queue
   * one transaction per block before changing the mode or cancelling its timer.
   * A failed drain preserves committed blocks and the previous mining mode.
   */
  async setBlockTime(seconds: number): Promise<void> {
    requireInteger(seconds, 'block time', 0, MAX_BLOCK_TIME_SECONDS)
    return this.withWriteLock(async () => {
      if (seconds === 0) {
        const pendingIds = this.pendingIds()
        try {
          await this.minePendingIndividually()
        } catch (cause) {
          throw new BlockTimeChangeError(
            {
              requestedBlockTime: 0,
              activeBlockTime: this.blockTimeSeconds,
              committedTransactionIds: pendingIds.filter((txid) => this.txs.has(txid)),
              pendingTransactionIds: this.pendingIds(),
            },
            cause,
          )
        }
      }
      // Interval ticks wait on this lock. Keep their timer valid until the drain
      // succeeds, so a failure preserves both the mode and the next scheduled tick.
      if (this.blockTimer !== undefined) {
        clearInterval(this.blockTimer)
        this.blockTimer = undefined
      }
      this.blockTimeSeconds = seconds
      if (seconds > 0) {
        const timer = this.lockHolder.exit(() =>
          setInterval(() => {
            void this.withWriteLock(async () => {
              // A tick queued behind a mode change must not mine an extra block.
              if (this.blockTimer === timer) await this.mine(1)
            }).catch(() => this.log.intervalFailure())
          }, seconds * 1000),
        )
        this.blockTimer = timer
        timer.unref?.()
      }
    })
  }

  /**
   * Admission uses the empty block context of Manager.processTransaction(tx, null).
   * Packing uses the block being produced; constant previews use the current head.
   */
  private executionEnvBlock() {
    const head = this.blocks.head()
    return createBlock(
      {
        header: {
          number: this.isPendingState ? 0n : head.number + 1n,
          parentHash: this.isPendingState ? new Uint8Array(32) : head.block.hash(),
          timestamp: this.isPendingState ? 0n : BigInt(Math.floor(this.currentTimeMs() / 1000)),
          gasLimit: BLOCK_GAS_LIMIT,
          ...(this.isPendingState ? {} : { coinbase: tronHexToAddress(WITNESS_ADDRESS) }),
        },
      },
      {
        common: this.common,
        params: mergedParams(paramsBlock, this.configState.runtime.common.params),
        skipConsensusFormatValidation: true,
      },
    )
  }

  /**
   * State-changing execution on the live VM (broadcast path). No locking here —
   * callers wrap execute + sealBlock in one withWriteLock section. Charges the
   * TRON energy fee (energy_used * energyFee sun) even when the call reverts.
   */
  async execute(params: WriteParams): Promise<WriteResult> {
    const energyFee = BigInt(this.configState.chainParameters.energyFee)
    // the budget is bounded by what the sender can pay: staked energy first,
    // then the balance left after the call value buys the rest, and the fee
    // limit caps the whole
    const senderBalance = (await this.stateManager.getAccount(params.caller))?.balance ?? 0n
    const callValue = params.value ?? 0n
    const spendable = senderBalance > callValue ? senderBalance - callValue : 0n
    const requested = params.energyLimit ?? this.configState.runtime.maxEnergyLimitForConstant
    const stakeEnergyLeft = this.stakedEnergyLeftOf(params.caller)
    const affordable = stakeEnergyLeft + spendable / energyFee
    const callerLimit = requested < affordable ? requested : affordable

    // when the caller is not the contract's origin, the origin subsidises the
    // budget from its staked energy: everything at percent 0, a
    // (100−p)/p share of the caller's limit below 100, nothing at 100 — each
    // leg capped by the origin's stake and its stated per-call limit
    const meta =
      params.create === true || params.to === undefined
        ? undefined
        : this.getContractMeta(params.to)
    const origin =
      meta?.originAddress === undefined ? undefined : tronHexToAddress(meta.originAddress)
    const percent = meta?.consumeUserResourcePercent ?? 100
    const originShares =
      origin !== undefined && addressKey(origin) !== addressKey(params.caller) && percent < 100
    let creatorLimit = 0n
    if (originShares && origin !== undefined) {
      const originLeft = this.stakedEnergyLeftOf(origin)
      const originCap = BigInt(meta?.originEnergyLimit ?? 0)
      const bounded = originLeft < originCap ? originLeft : originCap
      if (percent <= 0) {
        creatorLimit = bounded
      } else {
        const proportional = (callerLimit * BigInt(100 - percent)) / BigInt(percent)
        creatorLimit = proportional < bounded ? proportional : bounded
      }
    }
    const gasLimit = callerLimit + creatorLimit
    const execution: TransactionExecution = {
      params,
      stateRoot: await this.stateManager.getStateRoot(),
      block: this.executionEnvBlock(),
      gasLimit,
    }

    // A deploy runs on a copy of the live state. `flush()` empties the
    // current checkpoint's diff layer, which is what `revert()` needs to undo
    // it, so a live checkpoint cannot survive a concurrent flush; the copy
    // shares the underlying store, so adopting its root publishes the deploy
    // and dropping the copy discards it.
    const deploying = params.create === true
    const trial = deploying ? await this.vm.shallowCopy() : this.vm
    if (deploying) {
      await trial.stateManager.setStateRoot(execution.stateRoot)
    }
    const capture = this.captureInternalCalls(trial.tvm, (address, slot) =>
      this.noteStorageSlot(address, slot),
    )
    let execResult: ExecResult
    let createdAddress: Address | undefined
    try {
      ;({ execResult, createdAddress } = await executeTransaction(trial, execution))
      if (deploying && execResult.exceptionError === undefined) {
        await this.stateManager.setStateRoot(await trial.stateManager.getStateRoot())
      }
    } finally {
      capture.detach()
    }

    // Stake V2 commits the budget preparation timestamps on success, even
    // when execution consumes no energy. Preparation does not stamp operations.
    if (
      params.plainTransfer !== true &&
      execResult.exceptionError === undefined &&
      this.configState.chainParameters.unfreezeDelayDays > 0
    ) {
      this.noteEnergyTime(params.caller)
      if (
        origin !== undefined &&
        !origin.equals(params.caller) &&
        (await this.getAccount(origin)) !== undefined
      ) {
        this.noteEnergyTime(origin)
      }
    }

    const energyUsed = execResult.executionGasUsed
    // the origin's share settles first, from its staked energy alone — a
    // (100−p)/100 cut of the total, capped by its stake and per-call limit
    let originEnergyUsage = 0n
    if (origin !== undefined && !origin.equals(params.caller) && energyUsed > 0n) {
      const share = (energyUsed * BigInt(100 - percent)) / 100n
      const originLeft = this.stakedEnergyLeftOf(origin)
      const originCap = BigInt(meta?.originEnergyLimit ?? 0)
      originEnergyUsage = share
      if (originLeft < originEnergyUsage) originEnergyUsage = originLeft
      if (originCap < originEnergyUsage) originEnergyUsage = originCap
      this.chargeStakedEnergy(origin, originEnergyUsage)
    }
    const callerUsed = energyUsed - originEnergyUsage
    // staked energy covers the caller's part first; only the remainder burns
    // TRX. The budget was capped by stake plus balance up front, so the fee
    // part is payable in full
    const energyFromStake = callerUsed < stakeEnergyLeft ? callerUsed : stakeEnergyLeft
    if (energyUsed > 0n) {
      this.chargeStakedEnergy(params.caller, energyFromStake)
    }
    let energyFeeSun = (callerUsed - energyFromStake) * energyFee
    const sender = await this.stateManager.getAccount(params.caller)
    if (sender === undefined) {
      energyFeeSun = 0n
    } else if (energyFeeSun > 0n) {
      sender.balance -= energyFeeSun
      // the energy fee leaves circulation the same way a burned bandwidth fee
      // does, so the chain-wide destroyed total counts it
      this.burnedSun += energyFeeSun
      await this.stateManager.putAccount(params.caller, sender)
    }
    // TRON settles energy before deleting contracts created and destroyed in this transaction.
    const { selfdestruct, createdAddresses } = execResult
    if (
      execResult.exceptionError === undefined &&
      selfdestruct !== undefined &&
      selfdestruct.size > 0
    ) {
      if (createdAddresses === undefined) {
        throw EthereumJSErrorWithoutCode('Missing transaction creation records')
      }
      for (const key of selfdestruct.keys()) {
        if (!createdAddresses.has(key)) continue
        const address = createAddressFromString(key)
        await this.vm.tvm.journal.deleteAccount(address)
        this.deleteAccountRecords(address)
      }
    }
    await this.vm.tvm.journal.cleanup()
    await this.stateManager.flush()

    return {
      execution,
      execResult,
      energyUsed,
      energyFeeSun,
      energyFromStake,
      originEnergyUsage,
      returnValue: execResult.returnValue,
      reverted: execResult.exceptionError !== undefined,
      createdAddress,
      // the address a create claimed, whether or not the code was stored: it
      // is stamped on the result before the init code runs
      deployAddress: params.create === true ? params.deployAddress : undefined,
      internalTxs: capture.internalTxs,
    }
  }

  /**
   * Record internal message frames (depth > 0) while a runCall is in flight.
   * Frames pair before/after events LIFO; -1 marks the top-level frame.
   * `noteSlot` takes every slot an SSTORE names, so a run whose state is thrown
   * away passes a sink that keeps nothing.
   */
  private captureInternalCalls(
    tvm: NodeCore['vm']['tvm'],
    noteSlot: (address: Address, slot: Uint8Array) => void,
  ): {
    internalTxs: InternalCall[]
    detach: () => void
  } {
    const internalTxs: InternalCall[] = []
    const frames: number[] = []
    const onBeforeMessage = (message: Message): void => {
      if (message.depth === 0) {
        frames.push(-1)
        return
      }
      // the enclosing frame is whatever this one was opened from
      const parentIndex = frames.length === 0 ? -1 : (frames[frames.length - 1] ?? -1)
      frames.push(internalTxs.length)
      internalTxs.push({
        // Delegate messages inherit msg.sender/value without initiating a transfer.
        caller: message.delegatecall ? message.to! : message.caller,
        to: message.to,
        parentIndex,
        valueSun: message.delegatecall ? 0n : message.value,
        data: message.data === undefined ? new Uint8Array() : Uint8Array.from(message.data),
        ...(message.tokenId !== undefined && message.tokenId > 0n
          ? { tokenId: message.tokenId, tokenValue: message.tokenValue ?? 0n }
          : {}),
        create: message.to === undefined,
        ...(message.salt === undefined ? {} : { create2: true }),
        rejected: false,
      })
    }
    const onAfterMessage = (frameResult: {
      execResult: { exceptionError?: unknown }
      createdAddress?: Address
    }): void => {
      const index = frames.pop()
      if (index === undefined || index < 0) return
      const call = internalTxs[index]
      if (frameResult.execResult.exceptionError !== undefined) {
        call.rejected = true
      }
      if (call.create && frameResult.createdAddress !== undefined) {
        call.to = frameResult.createdAddress
      }
    }
    /**
     * A contract destroying itself states a frame of its own, carrying the
     * whole balance and every token it still holds to the beneficiary. The
     * step is read before the opcode runs, which is while those holdings are
     * still the contract's.
     */
    const onStep = (step: InterpreterStep): void => {
      if (step.opcode.name === 'SSTORE' && step.stack.length > 0) {
        const slot = step.stack[step.stack.length - 1] ?? 0n
        noteSlot(step.address, hexToBytes(`0x${slot.toString(16).padStart(64, '0')}`))
        return
      }
      if (step.opcode.name !== 'SELFDESTRUCT' || step.stack.length === 0) return
      const top = step.stack[step.stack.length - 1] ?? 0n
      const tokens = Object.entries(step.account.asset ?? {})
        .map(([id, amount]): [bigint, bigint] => [BigInt(id), amount])
        .filter(([, amount]) => amount > 0n)
        .sort(([a], [b]) => (a < b ? -1 : 1))
      internalTxs.push({
        caller: step.address,
        to: createAddressFromString(`0x${(top & ADDRESS_MASK).toString(16).padStart(40, '0')}`),
        parentIndex: frames.length === 0 ? -1 : (frames[frames.length - 1] ?? -1),
        valueSun: step.account.balance,
        data: new Uint8Array(),
        create: false,
        suicide: true,
        ...(tokens.length === 0 ? {} : { tokens }),
        rejected: false,
      })
    }
    tvm.events?.on('beforeMessage', onBeforeMessage)
    tvm.events?.on('afterMessage', onAfterMessage)
    tvm.events?.on('step', onStep)
    return {
      internalTxs,
      detach: () => {
        tvm.events?.off('beforeMessage', onBeforeMessage)
        tvm.events?.off('afterMessage', onAfterMessage)
        tvm.events?.off('step', onStep)
      },
    }
  }

  /**
   * Read-only contract execution against the current state (≈ eth_call):
   * shallow VM copy pinned to the latest state root, so cheats and future
   * write-path commits are visible immediately without re-sealing.
   */
  async call(params: CallParams): Promise<CallResult> {
    const stateRoot = await this.stateManager.getStateRoot()
    const vmCopy = await this.vm.shallowCopy()
    await vmCopy.stateManager.setStateRoot(stateRoot)
    const tokenOpts =
      params.tokenId !== undefined && params.tokenId > 0n
        ? { tokenId: params.tokenId, tokenValue: params.tokenValue ?? 0n }
        : {}
    const capture = this.captureInternalCalls(vmCopy.tvm, () => {})
    let execResult: ExecResult
    try {
      const result = await vmCopy.tvm.runCall({
        rootTransactionId: params.rootTransactionId,
        block: this.blocks.head().block,
        caller: params.caller,
        origin: params.caller,
        ...(params.deployAddress === undefined
          ? { ...(params.to === undefined ? {} : { to: params.to }), data: params.data }
          : { data: params.data }),
        value: params.value ?? 0n,
        gasLimit: params.energyLimit ?? this.configState.runtime.maxEnergyLimitForConstant,
        gasPrice: TRON_VM_GAS_PRICE,
        skipBalance: true,
        ...tokenOpts,
      })
      execResult = result.execResult
    } finally {
      capture.detach()
    }

    return {
      execResult,
      energyUsed: execResult.executionGasUsed,
      returnValue: execResult.returnValue,
      reverted: execResult.exceptionError !== undefined,
      internalTxs: capture.internalTxs,
    }
  }

  async getAccount(address: Address) {
    return this.stateManager.getAccount(address)
  }

  async getBalance(address: Address): Promise<bigint> {
    return (await this.getAccount(address))?.balance ?? 0n
  }

  async getCode(address: Address): Promise<Uint8Array> {
    return this.stateManager.getCode(address)
  }

  // ---- cheat methods (tre_* / debug_* handlers become thin wrappers over these) ----

  // The three writers below take the write lock for the same reason the
  // broadcast path does: they are a second route into the live state, reachable
  // over HTTP while a transaction is executing.
  async setBalance(address: Address, balanceSun: bigint): Promise<void> {
    const fault = balanceFault(balanceSun)
    if (fault !== undefined) throw new RangeError(fault)
    await this.withWriteLock(() =>
      this.transact(async () => {
        await this.noteCheatCreation(address)
        await this.stateManager.modifyAccountFields(address, { balance: balanceSun })
        await this.stateManager.flush()
      }),
    )
  }

  /** this account's record, created empty on first write */
  private recordFor(address: Address): AccountRecord {
    const key = addressKey(address)
    const existing = this.accounts.get(key)
    if (existing !== undefined) {
      // the caller writes fields on the record it gets back, so the way back is
      // the record as it reads right now
      const before = { ...existing }
      this.recordUndo(() => {
        this.accounts.set(key, before)
      })
      return existing
    }
    const created: AccountRecord = {}
    this.recordUndo(() => {
      this.accounts.delete(key)
    })
    this.accounts.set(key, created)
    return created
  }

  /**
   * The account and the record a cheat write plants: a contract account with
   * no permissions, and a contract record carrying its address and the
   * percentage. An account the write finds already there keeps its name.
   */
  private async plantContractAccount(address: Address): Promise<void> {
    const fresh = (await this.getAccount(address)) === undefined
    await this.noteCheatCreation(address)
    await this.stateManager.modifyAccountFields(address, {})
    if (fresh) {
      this.recordFor(address).name = bytesToHex(new TextEncoder().encode('CreatedByTre')).slice(2)
    }
    this.noteAccountType(address, 'Contract')
    if (!this.contracts.has(addressKey(address))) {
      this.registerContract(address, {
        name: '',
        bytecode: '',
        consumeUserResourcePercent: 100,
        originEnergyLimit: 0,
      })
    }
  }

  /**
   * Install runtime code. A contract planted this way also gets a contract
   * record, so it is indistinguishable from a deployed one across getaccount,
   * getcontract and getcontractinfo.
   */
  async setCode(address: Address, code: Uint8Array): Promise<void> {
    await this.withWriteLock(() =>
      this.transact(async () => {
        await this.plantContractAccount(address)
        const planted = this.contracts.get(addressKey(address))
        if (planted !== undefined) this.registerContract(address, { ...planted, codeHashed: true })
        await this.stateManager.putCode(address, code)
        await this.stateManager.flush()
      }),
    )
  }

  async setStorage(address: Address, slot: Uint8Array, value: Uint8Array): Promise<void> {
    await this.withWriteLock(() =>
      this.transact(async () => {
        await this.plantContractAccount(address)
        const key = setLengthLeft(slot, 32)
        this.noteStorageSlot(address, key)
        await this.stateManager.putStorage(address, key, value)
        await this.stateManager.flush()
      }),
    )
  }

  /**
   * The slots an address has been written at. A rollback leaves its entries
   * behind; `storageEntries` reads each one back through the trie and keeps
   * the ones still holding a value.
   */
  noteStorageSlot(address: Address, slot: Uint8Array): void {
    const key = addressKey(address)
    let slots = this.storageSlots.get(key)
    if (slots === undefined) {
      slots = new Map()
      this.storageSlots.set(key, slots)
    }
    slots.set(bytesToHex(slot), slot)
  }

  /**
   * What this account's storage holds now, slot by slot. A slot that was
   * written and then cleared reads as empty, and is left out.
   */
  async storageEntries(address: Address): Promise<{ slot: Uint8Array; value: Uint8Array }[]> {
    const slots = this.storageSlots.get(addressKey(address))
    if (slots === undefined) return []
    const entries: { slot: Uint8Array; value: Uint8Array }[] = []
    for (const slot of slots.values()) {
      const value = await this.stateManager.getStorage(address, slot)
      if (value.length > 0) entries.push({ slot, value })
    }
    return entries
  }

  // ---- direct state ops: TRC-10 issuance/transfers and plain TRX moves.
  // These are actuator families — no VM frame; issuance is plain state —
  // a token exists once an account holds it ----

  /** true once this account holds a TRC-10 issuance; the chain allows one */
  hasIssuedAsset(owner: Address): boolean {
    return this.assets.byOwner(addressKey(owner)) !== undefined
  }

  assetIssuedBy(owner: Address): AssetMeta | undefined {
    return this.assets.byOwner(addressKey(owner))
  }

  /**
   * Issue a TRC-10 asset. The issuer receives the supply that is not locked in
   * frozen tranches; the locked part only becomes spendable once its window
   * has passed.
   */
  async issueAsset(
    owner: Address,
    input: Omit<AssetInput, 'ownerKey'>,
    creditedSupply?: bigint,
    frozen: FrozenSupply[] = [],
  ): Promise<AssetMeta | 'owner-already-issued' | 'asset-name-already-issued'> {
    const ownerKey = addressKey(owner)
    if (
      this.configState.chainParameters.allowSameTokenName === 0 &&
      this.assets.byName(input.name).length > 0
    ) {
      return 'asset-name-already-issued'
    }
    const meta = this.assets.create({ ...input, ownerKey })
    if (meta === 'owner-already-issued') return meta
    this.recordUndo(() => this.assets.drop(meta.id, ownerKey))
    const account = (await this.stateManager.getAccount(owner)) ?? new Account()
    account.asset = { ...account.asset, [meta.id]: creditedSupply ?? meta.totalSupply }
    await this.stateManager.putAccount(owner, account)
    await this.stateManager.flush()
    if (frozen.length > 0) {
      this.recordFor(owner).frozenSupply = frozen
    }
    return meta
  }

  /** the raw bandwidth ledger entry, decay basis included */
  bandwidthLedgerOf(address: Address): { usedBytes: number; lastMs: number } | undefined {
    const entry = this.accounts.get(addressKey(address))?.bandwidth
    return entry === undefined ? undefined : { ...entry }
  }

  /** every per-account record beside the trie, sorted by address key */
  accountRecordEntries(): [string, Record<string, unknown>][] {
    return [...this.accounts]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, record]) => [key, { ...record }])
  }

  /**
   * Replace an account's permission set, ids as given. The set lives on the
   * side record: thresholds and weights are int64, and the account encoding
   * would narrow them through a number on the way back out.
   */
  async setPermissions(owner: Address, permissions: StoredPermissionLike[]): Promise<void> {
    this.recordFor(owner).permissions = permissions
  }

  /** the stored permission set, absent while the account keeps its defaults */
  storedPermissionsOf(owner: Address): StoredPermissionLike[] | undefined {
    return this.accounts.get(addressKey(owner))?.permissions
  }

  /**
   * The account's name: the one it registered, or for a contract account the
   * name its deployment carried — the deploy writes that name onto the
   * account it creates for the contract.
   */
  accountNameOf(owner: Address): string | undefined {
    const name = this.accounts.get(addressKey(owner))?.name
    if (name !== undefined) return name
    const contractName = this.contracts.get(addressKey(owner))?.name
    if (contractName === undefined || contractName === '') return undefined
    // names are held the way the wire carries them: the bytes' hex, lowercase
    return bytesToHex(new TextEncoder().encode(contractName)).slice(2).toLowerCase()
  }

  /** Store the account's name and update the chain-wide name index. */
  setAccountName(owner: Address, name: string): void {
    const nameKey = name.toLowerCase()
    this.recordFor(owner).name = nameKey
    const previous = this.accountNames.get(nameKey)
    this.recordUndo(() => {
      if (previous === undefined) this.accountNames.delete(nameKey)
      else this.accountNames.set(nameKey, previous)
    })
    this.accountNames.set(nameKey, toTronHexOf(owner))
  }

  /**
   * Stamp an address with the head block time the first time it is written.
   * Addresses already carrying state keep whatever stamp they arrived with,
   * which for the genesis allocation is no stamp at all.
   */
  async noteCreation(address: Address): Promise<void> {
    const record = this.recordFor(address)
    if (record.createdAt !== undefined) return
    if ((await this.stateManager.getAccount(address)) !== undefined) return
    record.createdAt = this.blocks.height() < 0n ? 0 : this.blocks.head().timestampMs
    record.createdIn = this.blocks.height() < 0n ? 0n : this.blocks.height() + 1n
  }

  /**
   * Creation stamp for a cheat write. The write goes straight into the store
   * with no block layer above it, so the record is root-stored the moment it
   * exists; only the creation time is taken from the head block.
   */
  private async noteCheatCreation(address: Address): Promise<void> {
    await this.noteCreation(address)
    this.recordFor(address).createdIn = undefined
  }

  /**
   * Whether this account's record has reached the root account store. Records
   * are written there when the snapshot below the head merges, so an account
   * is still only in the pending layer during the block that created it.
   */
  isRootStored(address: Address): boolean {
    const created = this.accounts.get(addressKey(address))?.createdIn
    return created === undefined || created < this.blocks.height()
  }

  /**
   * Stamp the head block time on an account the resource layer just billed.
   * Every billing path stamps it: free bandwidth, bandwidth burned as a fee,
   * the new-account fee and energy alike.
   */
  noteOperation(address: Address): void {
    this.recordFor(address).operationAt =
      this.blocks.height() < 0n ? 0 : this.blocks.head().timestampMs
  }

  /** head block time this address was last billed at */
  operationTime(address: Address): number | undefined {
    return this.accounts.get(addressKey(address))?.operationAt
  }

  private noteEnergyTime(address: Address): void {
    this.recordFor(address).energyConsumedAt =
      this.blocks.height() < 0n ? 0 : this.blocks.head().timestampMs
  }

  /** head block time of the last committed energy preparation or billing */
  energyUsedAt(address: Address): number | undefined {
    return this.accounts.get(addressKey(address))?.energyConsumedAt
  }

  /** head block time this address was first written, absent for genesis holders */
  accountCreatedAt(address: Address): number | undefined {
    return this.accounts.get(addressKey(address))?.createdAt
  }

  /** Deployed contracts and explicitly typed accounts share the same classification. */
  accountTypeOf(address: Address): 'AssetIssue' | 'Contract' | undefined {
    const key = addressKey(address)
    return this.contracts.has(key) ? 'Contract' : this.accounts.get(key)?.accountType
  }

  /** remember a non-Normal AccountType declared at creation */
  noteAccountType(address: Address, type: 'AssetIssue' | 'Contract'): void {
    this.recordFor(address).accountType = type
  }

  /** the account id this address has claimed, if any */
  accountIdOf(owner: Address): string | undefined {
    const key = toTronHexOf(owner)
    for (const [id, holder] of this.accountIds) {
      if (holder === key) return id
    }
    return undefined
  }

  /**
   * Balance write from inside a transaction's execution: the caller already
   * holds the write lock, and the account it creates belongs to the block
   * being built.
   */
  async setBalanceUnlocked(address: Address, balanceSun: bigint): Promise<void> {
    await this.noteCreation(address)
    await this.stateManager.modifyAccountFields(address, { balance: balanceSun })
    await this.stateManager.flush()
  }

  /** locked tranches this account still holds */
  frozenSupplyOf(owner: Address): FrozenSupply[] {
    return this.accounts.get(addressKey(owner))?.frozenSupply ?? []
  }

  /**
   * Release every tranche whose window has passed, crediting the issuer.
   * Returns the amount released, or undefined when nothing has matured.
   */
  async unfreezeAsset(owner: Address, tokenId: number): Promise<bigint | undefined> {
    const record = this.recordFor(owner)
    const tranches = record.frozenSupply ?? []
    const now = BigInt(this.head().timestampMs)
    const matured = tranches.filter((t) => t.expireTime <= now)
    if (matured.length === 0) return undefined
    const released = matured.reduce((sum, t) => sum + t.frozenBalance, 0n)
    const remaining = tranches.filter((t) => t.expireTime > now)
    record.frozenSupply = remaining.length > 0 ? remaining : undefined
    await this.creditAsset(owner, tokenId, released)
    return released
  }

  /** add to an account's holding of a TRC-10 */
  async creditAsset(address: Address, tokenId: number, amount: bigint): Promise<void> {
    const account = (await this.stateManager.getAccount(address)) ?? new Account()
    const held = await this.getAssetBalance(address, tokenId)
    account.asset = { ...account.asset, [tokenId]: held + amount }
    await this.stateManager.putAccount(address, account)
    await this.stateManager.flush()
  }

  async getAssetBalance(address: Address, tokenId: number): Promise<bigint> {
    const account = await this.getAccount(address)
    return account?.asset?.[tokenId] ?? 0n
  }

  /** move TRC-10 balance between accounts; false when insufficient */
  async transferAsset(
    from: Address,
    to: Address,
    tokenId: number,
    amount: bigint,
  ): Promise<boolean> {
    const fromAccount = await this.stateManager.getAccount(from)
    const held = await this.getAssetBalance(from, tokenId)
    if (fromAccount === undefined || held < amount || amount < 0n) return false
    fromAccount.asset = { ...fromAccount.asset, [tokenId]: held - amount }
    await this.stateManager.putAccount(from, fromAccount)
    await this.noteCreation(to)
    await this.stateManager.modifyAccountFields(to, {}) // ensure recipient exists
    const toAccount = (await this.stateManager.getAccount(to))!
    const received = (await this.getAssetBalance(to, tokenId)) + amount
    toAccount.asset = { ...toAccount.asset, [tokenId]: received }
    await this.stateManager.putAccount(to, toAccount)
    await this.stateManager.flush()
    return true
  }

  // ---- Frozen balances, delegation and the quotas they buy. The dialect
  // owns validation; this layer owns the state arithmetic. ----

  private static pairField(resource: DelegatableResource): 'bandwidth' | 'energy'
  private static pairField(resource: StakeResource): 'bandwidth' | 'energy' | 'tronPower'
  private static pairField(resource: StakeResource): 'bandwidth' | 'energy' | 'tronPower' {
    if (resource === 'BANDWIDTH') return 'bandwidth'
    if (resource === 'ENERGY') return 'energy'
    return 'tronPower'
  }

  /** sun this account froze, per resource */
  frozenV2Of(address: Address): FrozenStakePair {
    const held = this.accounts.get(addressKey(address))?.frozenV2
    return {
      bandwidth: held?.bandwidth ?? 0n,
      energy: held?.energy ?? 0n,
      tronPower: held?.tronPower ?? 0n,
    }
  }

  /** resource entries physically present in this account's stored V2 list */
  frozenV2OrderOf(address: Address): StakeResource[] {
    return [...(this.accounts.get(addressKey(address))?.frozenV2Order ?? [])]
  }

  /** Stake 1.0 balances, including their independent release times. */
  legacyFrozenOf(address: Address): LegacyFrozenPair {
    const held = this.accounts.get(addressKey(address))?.frozenLegacy
    return {
      ...(held?.bandwidth === undefined ? {} : { bandwidth: { ...held.bandwidth } }),
      ...(held?.energy === undefined ? {} : { energy: { ...held.energy } }),
      ...(held?.tronPower === undefined ? {} : { tronPower: { ...held.tronPower } }),
    }
  }

  /** sun other accounts delegated here, per resource */
  acquiredDelegatedOf(address: Address): StakePair {
    const held = this.accounts.get(addressKey(address))?.acquired
    return { bandwidth: held?.bandwidth ?? 0n, energy: held?.energy ?? 0n }
  }

  /** Stake 1.0 sun other accounts delegated here, per resource. */
  legacyAcquiredDelegatedOf(address: Address): StakePair {
    const held = this.accounts.get(addressKey(address))?.acquiredLegacy
    return { bandwidth: held?.bandwidth ?? 0n, energy: held?.energy ?? 0n }
  }

  /** sun this account delegated away, per resource */
  delegatedOutOf(address: Address): StakePair {
    const held = this.accounts.get(addressKey(address))?.delegatedOut
    return { bandwidth: held?.bandwidth ?? 0n, energy: held?.energy ?? 0n }
  }

  /** Stake 1.0 sun this account delegated away, per resource. */
  legacyDelegatedOutOf(address: Address): StakePair {
    const held = this.accounts.get(addressKey(address))?.delegatedLegacyOut
    return { bandwidth: held?.bandwidth ?? 0n, energy: held?.energy ?? 0n }
  }

  /** pending unstakes, oldest first */
  unfrozenV2Of(address: Address): UnfrozenV2Entry[] {
    return [...(this.accounts.get(addressKey(address))?.unfrozenV2 ?? [])]
  }

  /** the raw staked-bandwidth ledger entry, decay basis included */
  stakedNetLedgerOf(address: Address): { usedBytes: number; lastMs: number } | undefined {
    const entry = this.accounts.get(addressKey(address))?.stakedNet
    return entry === undefined ? undefined : { ...entry }
  }

  /** pending unstakes whose window is still open at `nowMs` */
  unfreezingCountAt(address: Address, nowMs: number): number {
    return this.unfrozenV2Of(address).filter((entry) => entry.expireMs > nowMs).length
  }

  /** sun withdrawable at `atMs` from matured unstakes */
  withdrawableAt(address: Address, atMs: number): bigint {
    return this.unfrozenV2Of(address)
      .filter((entry) => entry.expireMs <= atMs)
      .reduce((sum, entry) => sum + entry.amount, 0n)
  }

  /** voting power this account holds, in sun */
  tronPowerSunOf(address: Address): bigint {
    const record = this.accounts.get(addressKey(address))
    const explicit =
      (record?.frozenV2?.tronPower ?? 0n) + (record?.frozenLegacy?.tronPower?.amount ?? 0n)
    const old = record?.oldTronPower ?? 0n
    const total =
      old === -1n
        ? explicit
        : old === 0n
          ? this.quotaTronPowerSun(record) + explicit
          : old + explicit
    return total
  }

  /** votes this account's whole stake carries, in TRX */
  tronPowerTrxOf(address: Address): bigint {
    return this.tronPowerSunOf(address) / TRX_SUN
  }

  /** the frozen quota balances that counted as voting power before migration */
  private quotaTronPowerSun(record: AccountRecord | undefined): bigint {
    return (
      (record?.frozenV2?.bandwidth ?? 0n) +
      (record?.frozenV2?.energy ?? 0n) +
      (record?.delegatedOut?.bandwidth ?? 0n) +
      (record?.delegatedOut?.energy ?? 0n) +
      (record?.frozenLegacy?.bandwidth?.amount ?? 0n) +
      (record?.frozenLegacy?.energy?.amount ?? 0n) +
      (record?.delegatedLegacyOut?.bandwidth ?? 0n) +
      (record?.delegatedLegacyOut?.energy ?? 0n)
    )
  }

  /** initialize the migration snapshot the first freeze/unfreeze operation observes */
  private initializeOldTronPower(record: AccountRecord): void {
    if (
      this.configState.chainParameters.allowNewResourceModel === 1 &&
      (record.oldTronPower ?? 0n) === 0n
    ) {
      const current = this.quotaTronPowerSun(record)
      record.oldTronPower = current === 0n ? -1n : current
    }
  }

  /** the stored migration marker, omitted by protobuf JSON when it is zero */
  oldTronPowerOf(address: Address): bigint {
    return this.accounts.get(addressKey(address))?.oldTronPower ?? 0n
  }

  /** the Stake 2.0 weight one account holds itself or has delegated away */
  private weightWithDelegated(record: AccountRecord | undefined, resource: StakeResource): bigint {
    if (resource === 'TRON_POWER') return record?.frozenV2?.tronPower ?? 0n
    const field = NodeCore.pairField(resource)
    const frozen = record?.frozenV2?.[field] ?? 0n
    return frozen + (record?.delegatedOut?.[field] ?? 0n)
  }

  /** move the chain-wide weight by the TRX-floor difference a stake op made */
  private shiftWeight(resource: StakeResource, beforeSun: bigint, afterSun: bigint): void {
    const delta = afterSun / TRX_SUN - beforeSun / TRX_SUN
    if (delta === 0n) return
    const net = this.totalNetWeightTrx
    const energy = this.totalEnergyWeightTrx
    const tronPower = this.totalTronPowerWeightTrx
    this.recordUndo(() => {
      this.totalNetWeightTrx = net
      this.totalEnergyWeightTrx = energy
      this.totalTronPowerWeightTrx = tronPower
    })
    if (resource === 'BANDWIDTH') this.totalNetWeightTrx += delta
    else if (resource === 'ENERGY') this.totalEnergyWeightTrx += delta
    else this.totalTronPowerWeightTrx += delta
  }

  /** move balance into a Stake 2.0 freeze; the dialect has validated it */
  async freezeV2(owner: Address, amountSun: bigint, resource: StakeResource): Promise<void> {
    const account = (await this.stateManager.getAccount(owner))!
    account.balance -= amountSun
    await this.stateManager.putAccount(owner, account)
    await this.stateManager.flush()
    const record = this.recordFor(owner)
    this.initializeOldTronPower(record)
    const field = NodeCore.pairField(resource)
    const before = this.weightWithDelegated(record, resource)
    const frozen = { bandwidth: 0n, energy: 0n, tronPower: 0n, ...record.frozenV2 }
    frozen[field] += amountSun
    record.frozenV2 = frozen
    if (!(record.frozenV2Order ?? []).includes(resource)) {
      record.frozenV2Order = [...(record.frozenV2Order ?? []), resource]
    }
    this.shiftWeight(resource, before, before + amountSun)
  }

  private static legacyDelegationKey(fromKey: string, toKey: string): string {
    return `${fromKey}>${toKey}`
  }

  /** write one Stake 1.0 delegation entry, absent meaning removal */
  private putLegacyDelegation(key: string, entry: LegacyDelegationEntry | undefined): void {
    const before = this.legacyDelegations.get(key)
    this.recordUndo(() => {
      if (before === undefined) this.legacyDelegations.delete(key)
      else this.legacyDelegations.set(key, before)
    })
    if (entry === undefined) this.legacyDelegations.delete(key)
    else this.legacyDelegations.set(key, entry)
  }

  /** Record the most recent delegation time for the legacy account index. */
  private noteLegacyPair(fromKey: string, toKey: string): void {
    const key = NodeCore.legacyDelegationKey(fromKey, toKey)
    const before = this.legacyDelegationPairs.get(key)
    this.recordUndo(() => {
      if (before === undefined) this.legacyDelegationPairs.delete(key)
      else this.legacyDelegationPairs.set(key, before)
    })
    this.legacyDelegationPairs.set(key, { fromKey, toKey, timestampMs: this.head().timestampMs })
  }

  /** remove an old account-index pair after its last resource is released */
  private dropLegacyPairIfEmpty(fromKey: string, toKey: string): void {
    const key = NodeCore.legacyDelegationKey(fromKey, toKey)
    if (this.legacyDelegations.has(key)) return
    const before = this.legacyDelegationPairs.get(key)
    if (before === undefined) return
    this.recordUndo(() => {
      this.legacyDelegationPairs.set(key, before)
    })
    this.legacyDelegationPairs.delete(key)
  }

  /**
   * Move balance into a Stake 1.0 freeze. A receiver is meaningful only while
   * resource delegation is enabled; otherwise the contract freezes locally.
   */
  async freezeLegacy(
    owner: Address,
    amountSun: bigint,
    resource: StakeResource,
    durationDays: number,
    receiver?: Address,
  ): Promise<void> {
    const account = (await this.stateManager.getAccount(owner))!
    account.balance -= amountSun
    await this.stateManager.putAccount(owner, account)
    await this.stateManager.flush()

    const ownerRecord = this.recordFor(owner)
    this.initializeOldTronPower(ownerRecord)
    const expireMs = this.head().timestampMs + durationDays * 86_400_000
    let weightBefore: bigint
    if (
      receiver !== undefined &&
      this.configState.chainParameters.allowDelegateResource === 1 &&
      resource !== 'TRON_POWER'
    ) {
      const field = NodeCore.pairField(resource)
      const fromKey = addressKey(owner)
      const toKey = addressKey(receiver)
      const key = NodeCore.legacyDelegationKey(fromKey, toKey)
      const existing = this.legacyDelegations.get(key) ?? {
        fromKey,
        toKey,
        bandwidth: 0n,
        energy: 0n,
        expireBandwidthMs: 0,
        expireEnergyMs: 0,
      }
      const next: LegacyDelegationEntry = {
        ...existing,
        [field]: existing[field] + amountSun,
        ...(resource === 'BANDWIDTH'
          ? { expireBandwidthMs: expireMs }
          : { expireEnergyMs: expireMs }),
      }
      this.putLegacyDelegation(key, next)
      this.noteLegacyPair(fromKey, toKey)

      const out = { bandwidth: 0n, energy: 0n, ...ownerRecord.delegatedLegacyOut }
      out[field] += amountSun
      ownerRecord.delegatedLegacyOut = out
      const receiverRecord = this.recordFor(receiver)
      const acquired = { bandwidth: 0n, energy: 0n, ...receiverRecord.acquiredLegacy }
      weightBefore = acquired[field]
      acquired[field] += amountSun
      receiverRecord.acquiredLegacy = acquired
    } else {
      const field = NodeCore.pairField(resource)
      weightBefore = ownerRecord.frozenLegacy?.[field]?.amount ?? 0n
      ownerRecord.frozenLegacy = {
        ...ownerRecord.frozenLegacy,
        [field]: {
          amount: (ownerRecord.frozenLegacy?.[field]?.amount ?? 0n) + amountSun,
          expireMs,
        },
      }
    }
    this.shiftWeight(resource, weightBefore, weightBefore + amountSun)
  }

  /**
   * Release a matured Stake 1.0 freeze. The dialect has checked that the
   * requested local balance or delegated pair exists and has reached expiry.
   */
  async unfreezeLegacy(
    owner: Address,
    resource: StakeResource,
    receiver?: Address,
  ): Promise<bigint> {
    const ownerRecord = this.recordFor(owner)
    this.initializeOldTronPower(ownerRecord)
    let amount = 0n
    let weightBefore: bigint
    if (
      receiver !== undefined &&
      this.configState.chainParameters.allowDelegateResource === 1 &&
      resource !== 'TRON_POWER'
    ) {
      const field = NodeCore.pairField(resource)
      const fromKey = addressKey(owner)
      const toKey = addressKey(receiver)
      const key = NodeCore.legacyDelegationKey(fromKey, toKey)
      const existing = this.legacyDelegations.get(key)!
      amount = existing[field]
      const next: LegacyDelegationEntry = {
        ...existing,
        [field]: 0n,
        ...(resource === 'BANDWIDTH' ? { expireBandwidthMs: 0 } : { expireEnergyMs: 0 }),
      }
      this.putLegacyDelegation(key, next.bandwidth === 0n && next.energy === 0n ? undefined : next)
      this.dropLegacyPairIfEmpty(fromKey, toKey)

      const out = { bandwidth: 0n, energy: 0n, ...ownerRecord.delegatedLegacyOut }
      out[field] -= amount
      ownerRecord.delegatedLegacyOut = out
      const receiverAccount = await this.stateManager.getAccount(receiver)
      if (receiverAccount !== undefined && this.accountTypeOf(receiver) !== 'Contract') {
        const receiverRecord = this.recordFor(receiver)
        const acquired = { bandwidth: 0n, energy: 0n, ...receiverRecord.acquiredLegacy }
        // Legacy claims can outlive the receiver's original account record.
        weightBefore = acquired[field] < amount ? amount : acquired[field]
        acquired[field] = weightBefore - amount
        receiverRecord.acquiredLegacy = acquired
      } else {
        weightBefore = amount
      }
    } else {
      const field = NodeCore.pairField(resource)
      amount = ownerRecord.frozenLegacy?.[field]?.amount ?? 0n
      weightBefore = amount
      ownerRecord.frozenLegacy = { ...ownerRecord.frozenLegacy, [field]: undefined }
    }
    const account = (await this.stateManager.getAccount(owner))!
    account.balance += amount
    await this.stateManager.putAccount(owner, account)
    await this.stateManager.flush()
    this.shiftWeight(resource, weightBefore, weightBefore - amount)
    if (
      this.configState.chainParameters.allowNewResourceModel === 1 &&
      ownerRecord.oldTronPower !== -1n
    ) {
      ownerRecord.oldTronPower = -1n
    }
    return amount
  }

  /**
   * Matured pending unstakes go back to the balance. Returns the sun credited
   * — the amount the receipt reports as withdrawn alongside the operation.
   */
  private async claimExpiredUnfrozen(owner: Address, nowMs: number): Promise<bigint> {
    const record = this.recordFor(owner)
    const pending = record.unfrozenV2 ?? []
    const matured = pending.filter((entry) => entry.expireMs <= nowMs)
    if (matured.length === 0) return 0n
    record.unfrozenV2 = pending.filter((entry) => entry.expireMs > nowMs)
    const total = matured.reduce((sum, entry) => sum + entry.amount, 0n)
    const account = (await this.stateManager.getAccount(owner))!
    account.balance += total
    await this.stateManager.putAccount(owner, account)
    await this.stateManager.flush()
    return total
  }

  /** begin a Stake 2.0 unstake; matured ones settle on the way */
  async unfreezeV2(owner: Address, amountSun: bigint, resource: StakeResource): Promise<bigint> {
    const nowMs = this.head().timestampMs
    const withdrawn = await this.claimExpiredUnfrozen(owner, nowMs)
    const record = this.recordFor(owner)
    this.initializeOldTronPower(record)
    const field = NodeCore.pairField(resource)
    const before = this.weightWithDelegated(record, resource)
    const frozen = { bandwidth: 0n, energy: 0n, tronPower: 0n, ...record.frozenV2 }
    frozen[field] -= amountSun
    record.frozenV2 = frozen
    const expireMs = nowMs + this.configState.chainParameters.unfreezeDelayDays * 86_400_000
    record.unfrozenV2 = [
      ...(record.unfrozenV2 ?? []),
      { type: resource, amount: amountSun, expireMs },
    ]
    this.shiftWeight(resource, before, before - amountSun)
    if (
      this.configState.chainParameters.allowNewResourceModel === 1 &&
      record.oldTronPower !== -1n
    ) {
      record.oldTronPower = -1n
    }
    return withdrawn
  }

  /** settle every matured unstake into the balance */
  async withdrawExpiredUnfreeze(owner: Address): Promise<bigint> {
    return this.claimExpiredUnfrozen(owner, this.head().timestampMs)
  }

  /**
   * Take back every pending unstake: matured amounts settle into the balance,
   * the rest return to their freezes — weights included.
   */
  async cancelAllUnfreezeV2(owner: Address): Promise<{
    withdrawnSun: bigint
    canceled: Record<'BANDWIDTH' | 'ENERGY' | 'TRON_POWER', bigint>
  }> {
    const nowMs = this.head().timestampMs
    const withdrawnSun = await this.claimExpiredUnfrozen(owner, nowMs)
    const record = this.recordFor(owner)
    const canceled: Record<'BANDWIDTH' | 'ENERGY' | 'TRON_POWER', bigint> = {
      BANDWIDTH: 0n,
      ENERGY: 0n,
      TRON_POWER: 0n,
    }
    for (const entry of record.unfrozenV2 ?? []) {
      canceled[entry.type] += entry.amount
    }
    record.unfrozenV2 = []
    for (const resource of ['BANDWIDTH', 'ENERGY', 'TRON_POWER'] as const) {
      const back = canceled[resource]
      if (back === 0n) continue
      const field = NodeCore.pairField(resource)
      const before = this.weightWithDelegated(record, resource)
      const frozen = { bandwidth: 0n, energy: 0n, tronPower: 0n, ...record.frozenV2 }
      frozen[field] += back
      record.frozenV2 = frozen
      this.shiftWeight(resource, before, before + back)
    }
    return { withdrawnSun, canceled }
  }

  private static delegationKey(fromKey: string, toKey: string, locked: boolean): string {
    return `${fromKey}>${toKey}>${locked ? 'L' : 'U'}`
  }

  /** write one delegation entry, absent meaning removal */
  private putDelegation(key: string, entry: DelegationEntry | undefined): void {
    const before = this.delegations.get(key)
    this.recordUndo(() => {
      if (before === undefined) this.delegations.delete(key)
      else this.delegations.set(key, before)
    })
    if (entry === undefined) this.delegations.delete(key)
    else this.delegations.set(key, entry)
  }

  /** merge a pair's expired locked amounts into its unlocked entry */
  private unlockExpiredDelegation(fromKey: string, toKey: string, nowMs: number): void {
    const lockKey = NodeCore.delegationKey(fromKey, toKey, true)
    const locked = this.delegations.get(lockKey)
    if (locked === undefined) return
    const moveBandwidth = locked.expireBandwidthMs <= nowMs ? locked.bandwidth : 0n
    const moveEnergy = locked.expireEnergyMs <= nowMs ? locked.energy : 0n
    if (moveBandwidth === 0n && moveEnergy === 0n) return
    const remaining: DelegationEntry = {
      ...locked,
      bandwidth: locked.bandwidth - moveBandwidth,
      energy: locked.energy - moveEnergy,
      expireBandwidthMs: moveBandwidth > 0n ? 0 : locked.expireBandwidthMs,
      expireEnergyMs: moveEnergy > 0n ? 0 : locked.expireEnergyMs,
    }
    this.putDelegation(
      lockKey,
      remaining.bandwidth === 0n && remaining.energy === 0n ? undefined : remaining,
    )
    const unlockKey = NodeCore.delegationKey(fromKey, toKey, false)
    const unlocked = this.delegations.get(unlockKey) ?? {
      fromKey,
      toKey,
      locked: false,
      bandwidth: 0n,
      energy: 0n,
      expireBandwidthMs: 0,
      expireEnergyMs: 0,
    }
    this.putDelegation(unlockKey, {
      ...unlocked,
      bandwidth: unlocked.bandwidth + moveBandwidth,
      energy: unlocked.energy + moveEnergy,
    })
  }

  /** Record the most recent delegation time for the V2 account index. */
  private notePair(fromKey: string, toKey: string): void {
    const pairKey = `${fromKey}>${toKey}`
    const before = this.delegationPairs.get(pairKey)
    this.recordUndo(() => {
      if (before === undefined) this.delegationPairs.delete(pairKey)
      else this.delegationPairs.set(pairKey, before)
    })
    this.delegationPairs.set(pairKey, { fromKey, toKey, timestampMs: this.head().timestampMs })
  }

  /** the pair leaves the index once neither entry holds anything */
  private dropPairIfEmpty(fromKey: string, toKey: string): void {
    if (this.delegations.has(NodeCore.delegationKey(fromKey, toKey, false))) return
    if (this.delegations.has(NodeCore.delegationKey(fromKey, toKey, true))) return
    const pairKey = `${fromKey}>${toKey}`
    const before = this.delegationPairs.get(pairKey)
    if (before === undefined) return
    this.recordUndo(() => {
      this.delegationPairs.set(pairKey, before)
    })
    this.delegationPairs.delete(pairKey)
  }

  /** delegate frozen sun to another account; the dialect has validated it */
  async delegateResource(
    owner: Address,
    receiver: Address,
    amountSun: bigint,
    resource: DelegatableResource,
    lock: boolean,
    lockPeriodBlocks: number,
  ): Promise<void> {
    const nowMs = this.head().timestampMs
    const fromKey = addressKey(owner)
    const toKey = addressKey(receiver)
    this.unlockExpiredDelegation(fromKey, toKey, nowMs)
    const key = NodeCore.delegationKey(fromKey, toKey, lock)
    const held = this.delegations.get(key) ?? {
      fromKey,
      toKey,
      locked: lock,
      bandwidth: 0n,
      energy: 0n,
      expireBandwidthMs: 0,
      expireEnergyMs: 0,
    }
    const expireMs = lock
      ? nowMs +
        (lockPeriodBlocks === 0 ? DEFAULT_DELEGATE_LOCK_BLOCKS : lockPeriodBlocks) *
          BLOCK_INTERVAL_MS
      : 0
    const entry = { ...held }
    if (resource === 'BANDWIDTH') {
      entry.bandwidth += amountSun
      if (lock) entry.expireBandwidthMs = expireMs
    } else {
      entry.energy += amountSun
      if (lock) entry.expireEnergyMs = expireMs
    }
    this.putDelegation(key, entry)
    this.notePair(fromKey, toKey)

    // the owner's weight travels with the delegation, so the totals sit still
    const ownerRecord = this.recordFor(owner)
    const field = NodeCore.pairField(resource)
    const frozen = { bandwidth: 0n, energy: 0n, tronPower: 0n, ...ownerRecord.frozenV2 }
    frozen[field] -= amountSun
    ownerRecord.frozenV2 = frozen
    const out = { bandwidth: 0n, energy: 0n, ...ownerRecord.delegatedOut }
    out[field] += amountSun
    ownerRecord.delegatedOut = out

    const receiverRecord = this.recordFor(receiver)
    const acquired = { bandwidth: 0n, energy: 0n, ...receiverRecord.acquired }
    acquired[field] += amountSun
    receiverRecord.acquired = acquired
  }

  /**
   * Take a delegation back. The receiver's usage travels with it in
   * proportion, capped by what the returned weight could carry.
   */
  async undelegateResource(
    owner: Address,
    receiver: Address,
    amountSun: bigint,
    resource: DelegatableResource,
  ): Promise<void> {
    const nowMs = this.head().timestampMs
    const fromKey = addressKey(owner)
    const toKey = addressKey(receiver)
    const field = NodeCore.pairField(resource)

    const receiverRecord = this.recordFor(receiver)
    let transferUsage = 0
    const acquired = { bandwidth: 0n, energy: 0n, ...receiverRecord.acquired }
    if (acquired[field] < amountSun) {
      acquired[field] = 0n
    } else {
      const totals =
        resource === 'BANDWIDTH'
          ? {
              limit: this.configState.chainParameters.totalNetLimit,
              weight: this.totalNetWeightTrx,
            }
          : {
              limit: this.configState.chainParameters.totalEnergyCurrentLimit,
              weight: this.totalEnergyWeightTrx,
            }
      const maxUsage =
        totals.weight === 0n
          ? 0
          : Math.trunc((Number(amountSun) / 1e6) * (totals.limit / Number(totals.weight)))
      const allFrozen = this.frozenV2Of(receiver)[field] + acquired[field]
      const usageNow =
        resource === 'BANDWIDTH'
          ? this.stakedNetUsedOf(receiver)
          : this.stakedEnergyUsedOf(receiver)
      transferUsage =
        allFrozen === 0n ? 0 : Math.trunc(usageNow * (Number(amountSun) / Number(allFrozen)))
      transferUsage = Math.min(maxUsage, transferUsage)
      acquired[field] -= amountSun
    }
    receiverRecord.acquired = acquired
    const receiverUsage =
      resource === 'BANDWIDTH' ? this.stakedNetUsedOf(receiver) : this.stakedEnergyUsedOf(receiver)
    const receiverLeft = Math.max(0, receiverUsage - transferUsage)
    if (resource === 'BANDWIDTH') {
      receiverRecord.stakedNet = { usedBytes: receiverLeft, lastMs: this.currentTimeMs() }
    } else {
      receiverRecord.energyLedger = { used: receiverLeft, lastMs: this.currentTimeMs() }
    }

    this.unlockExpiredDelegation(fromKey, toKey, nowMs)
    const unlockKey = NodeCore.delegationKey(fromKey, toKey, false)
    const unlocked = this.delegations.get(unlockKey)
    if (unlocked !== undefined) {
      const entry = { ...unlocked }
      entry[field] -= amountSun
      this.putDelegation(
        unlockKey,
        entry.bandwidth === 0n &&
          entry.energy === 0n &&
          entry.expireBandwidthMs === 0 &&
          entry.expireEnergyMs === 0
          ? undefined
          : entry,
      )
    }
    this.dropPairIfEmpty(fromKey, toKey)

    const ownerRecord = this.recordFor(owner)
    const out = { bandwidth: 0n, energy: 0n, ...ownerRecord.delegatedOut }
    out[field] -= amountSun
    ownerRecord.delegatedOut = out
    const frozen = { bandwidth: 0n, energy: 0n, tronPower: 0n, ...ownerRecord.frozenV2 }
    frozen[field] += amountSun
    ownerRecord.frozenV2 = frozen
    if (transferUsage > 0) {
      const ownerUsage =
        resource === 'BANDWIDTH' ? this.stakedNetUsedOf(owner) : this.stakedEnergyUsedOf(owner)
      if (resource === 'BANDWIDTH') {
        ownerRecord.stakedNet = {
          usedBytes: ownerUsage + transferUsage,
          lastMs: this.currentTimeMs(),
        }
      } else {
        ownerRecord.energyLedger = {
          used: ownerUsage + transferUsage,
          lastMs: this.currentTimeMs(),
        }
      }
    }
  }

  /** both entries of one pair, unlocked first, empties filtered like the store */
  delegationEntriesOf(fromKey: string, toKey: string): DelegationEntry[] {
    const entries: DelegationEntry[] = []
    for (const locked of [false, true]) {
      const held = this.delegations.get(NodeCore.delegationKey(fromKey, toKey, locked))
      if (held === undefined) continue
      if (
        held.bandwidth === 0n &&
        held.energy === 0n &&
        held.expireBandwidthMs === 0 &&
        held.expireEnergyMs === 0
      ) {
        continue
      }
      entries.push({ ...held })
    }
    return entries
  }

  /** the one Stake 1.0 delegation store entry for this pair, if any */
  legacyDelegationOf(fromKey: string, toKey: string): LegacyDelegationEntry | undefined {
    const entry = this.legacyDelegations.get(NodeCore.legacyDelegationKey(fromKey, toKey))
    return entry === undefined ? undefined : { ...entry }
  }

  /** every Stake 1.0 delegation entry, in insertion order */
  legacyDelegationEntries(): LegacyDelegationEntry[] {
    return [...this.legacyDelegations.values()].map((entry) => ({ ...entry }))
  }

  /** every (from, to) pair the index currently holds, in index order */
  delegationPairKeys(): string[] {
    return [...this.delegationPairs.keys()]
  }

  /** every Stake 1.0 delegation pair currently in the account index */
  legacyDelegationPairKeys(): string[] {
    return [...this.legacyDelegationPairs.keys()]
  }

  /** the account index: who this key delegated to, and who delegated to it */
  delegationIndexOf(key: string): { to: string[]; from: string[] } {
    const to: string[] = []
    const from: string[] = []
    for (const pair of [...this.delegationPairs.values()].sort(
      (a, b) => a.timestampMs - b.timestampMs,
    )) {
      if (pair.fromKey === key) to.push(pair.toKey)
      if (pair.toKey === key) from.push(pair.fromKey)
    }
    return { to, from }
  }

  /** the Stake 1.0 account index: who this key delegated to and received from */
  legacyDelegationIndexOf(key: string): { to: string[]; from: string[] } {
    const to: string[] = []
    const from: string[] = []
    for (const pair of [...this.legacyDelegationPairs.values()].sort(
      (a, b) => a.timestampMs - b.timestampMs,
    )) {
      if (pair.fromKey === key) to.push(pair.toKey)
      if (pair.toKey === key) from.push(pair.fromKey)
    }
    return { to, from }
  }

  /** a ledger's usage as it reads right now, recovered over the window */
  private decayedUsage(
    entry: { usedBytes?: number; used?: number; lastMs: number } | undefined,
  ): number {
    if (entry === undefined) return 0
    return windowedUsage(entry.usedBytes ?? entry.used ?? 0, entry.lastMs, this.currentTimeMs(), 0)
  }

  /** grid share bought by this account's bandwidth weight, own and acquired */
  stakedNetLimitOf(address: Address): bigint {
    const record = this.accounts.get(addressKey(address))
    const weightSun =
      (record?.frozenV2?.bandwidth ?? 0n) +
      (record?.acquired?.bandwidth ?? 0n) +
      (record?.frozenLegacy?.bandwidth?.amount ?? 0n) +
      (record?.acquiredLegacy?.bandwidth ?? 0n)
    return this.gridShare(
      weightSun,
      this.configState.chainParameters.totalNetLimit,
      this.totalNetWeightTrx,
    )
  }

  /** grid share bought by this account's energy weight, own and acquired */
  stakedEnergyLimitOf(address: Address): bigint {
    const record = this.accounts.get(addressKey(address))
    const weightSun =
      (record?.frozenV2?.energy ?? 0n) +
      (record?.acquired?.energy ?? 0n) +
      (record?.frozenLegacy?.energy?.amount ?? 0n) +
      (record?.acquiredLegacy?.energy ?? 0n)
    return this.gridShare(
      weightSun,
      this.configState.chainParameters.totalEnergyCurrentLimit,
      this.totalEnergyWeightTrx,
    )
  }

  /** weight × grid/total, in the double arithmetic the quota is defined in */
  private gridShare(weightSun: bigint, totalLimit: number, totalWeightTrx: bigint): bigint {
    if (totalWeightTrx <= 0n) return 0n
    const weight = Number(weightSun) / 1e6
    return BigInt(Math.trunc(weight * (totalLimit / Number(totalWeightTrx))))
  }

  /** staked bandwidth used right now, decayed */
  stakedNetUsedOf(address: Address): number {
    return this.decayedUsage(this.accounts.get(addressKey(address))?.stakedNet)
  }

  /** free bandwidth of one asset this holder has drawn right now, decayed */
  assetNetUsedOf(address: Address, assetId: number): number {
    return this.decayedUsage(this.accounts.get(addressKey(address))?.assetNet?.[assetId])
  }

  /** the raw per-asset bandwidth ledger, decay basis included */
  assetNetLedgerOf(address: Address): Record<number, { usedBytes: number; lastMs: number }> {
    return { ...this.accounts.get(addressKey(address))?.assetNet }
  }

  /** the issuance's shared free-bandwidth pool spent right now, decayed */
  assetPublicNetUsedOf(meta: AssetMeta): number {
    return this.decayedUsage({
      usedBytes: meta.publicFreeAssetNetUsage,
      lastMs: meta.publicLatestFreeNetTime,
    })
  }

  /**
   * Bill an asset transfer against the issuance's free bandwidth. Three quotas
   * must each hold the bytes — the shared pool, this holder's per-asset
   * allowance, and the issuer's staked bandwidth — and all three are charged
   * together; any gate failing leaves everything untouched and the caller
   * falls back to the holder's own sources. The issuer pays from staked
   * bandwidth only, never from the free allowance.
   */
  consumeAssetNet(holder: Address, meta: AssetMeta, bytes: number): boolean {
    const publicUsed = this.assetPublicNetUsedOf(meta)
    if (publicUsed + bytes > meta.publicFreeAssetNetLimit) return false
    const holderUsed = this.assetNetUsedOf(holder, meta.id)
    if (holderUsed + bytes > meta.freeAssetNetLimit) return false
    const issuer = tronHexToAddress(`41${meta.ownerKey}`)
    if (!this.consumeStakedNet(issuer, bytes)) return false
    const now = this.currentTimeMs()
    const holderLedger = this.accounts.get(addressKey(holder))?.assetNet?.[meta.id]
    const record = this.recordFor(holder)
    record.assetNet = {
      ...record.assetNet,
      [meta.id]: {
        usedBytes: windowedUsage(
          holderLedger?.usedBytes ?? 0,
          holderLedger?.lastMs ?? now,
          now,
          bytes,
        ),
        lastMs: now,
      },
    }
    const priorUsage = meta.publicFreeAssetNetUsage
    const priorTime = meta.publicLatestFreeNetTime
    this.recordUndo(() => {
      meta.publicFreeAssetNetUsage = priorUsage
      meta.publicLatestFreeNetTime = priorTime
    })
    meta.publicFreeAssetNetUsage = publicUsed + bytes
    meta.publicLatestFreeNetTime = now
    return true
  }

  /** staked energy used right now, decayed */
  stakedEnergyUsedOf(address: Address): number {
    return this.decayedUsage(this.accounts.get(addressKey(address))?.energyLedger)
  }

  /** staked energy still available right now */
  stakedEnergyLeftOf(address: Address): bigint {
    const left = this.stakedEnergyLimitOf(address) - BigInt(this.stakedEnergyUsedOf(address))
    return left > 0n ? left : 0n
  }

  /** bill staked bandwidth; false when the quota cannot cover the bytes */
  consumeStakedNet(address: Address, bytes: number): boolean {
    const limit = this.stakedNetLimitOf(address)
    if (limit === 0n) return false
    const used = this.stakedNetUsedOf(address)
    if (BigInt(used + bytes) > limit) return false
    const ledger = this.accounts.get(addressKey(address))?.stakedNet
    const now = this.currentTimeMs()
    this.recordFor(address).stakedNet = {
      usedBytes: windowedUsage(ledger?.usedBytes ?? 0, ledger?.lastMs ?? now, now, bytes),
      lastMs: now,
    }
    return true
  }

  /** bill staked energy the execution already drew */
  chargeStakedEnergy(address: Address, units: bigint): void {
    const ledger = this.accounts.get(addressKey(address))?.energyLedger
    const now = this.currentTimeMs()
    this.recordFor(address).energyLedger = {
      used: windowedUsage(ledger?.used ?? 0, ledger?.lastMs ?? now, now, Number(units)),
      lastMs: now,
    }
    // Billing stamps both resource contributors, including a zero staked share.
    this.noteOperation(address)
    this.noteEnergyTime(address)
  }

  /** free bandwidth used right now, recovered over the window */
  getFreeBandwidthUsed(address: Address): number {
    return this.decayedUsage(this.accounts.get(addressKey(address))?.bandwidth)
  }

  /**
   * Bill bandwidth for a transaction of `bytes`, each source all or nothing
   * and in billing order: the staked quota, then the free
   * allowance, then burning bytes × transactionFee from the balance.
   */
  async consumeBandwidth(address: Address, bytes: number): Promise<BandwidthOutcome> {
    this.noteOperation(address)
    if (this.consumeStakedNet(address, bytes)) {
      return { source: 'staked' }
    }
    const used = this.getFreeBandwidthUsed(address)
    if (used + bytes <= this.configState.chainParameters.freeNetLimit) {
      const ledger = this.accounts.get(addressKey(address))?.bandwidth
      const now = this.currentTimeMs()
      this.recordFor(address).bandwidth = {
        usedBytes: windowedUsage(ledger?.usedBytes ?? 0, ledger?.lastMs ?? now, now, bytes),
        lastMs: now,
      }
      return { source: 'free' }
    }
    const feeSun = BigInt(bytes) * BigInt(this.configState.chainParameters.transactionFee)
    if (await this.deductBalance(address, feeSun)) {
      return { source: 'burn', feeSun }
    }
    return { source: 'insufficient', feeSun }
  }

  /** burn TRX from an account (issuance fees); false when insufficient */
  async deductBalance(address: Address, amountSun: bigint): Promise<boolean> {
    const account = await this.stateManager.getAccount(address)
    if (account === undefined || account.balance < amountSun) return false
    account.balance -= amountSun
    // every deduction here leaves circulation; refunds credit it back
    this.burnedSun += amountSun
    await this.stateManager.putAccount(address, account)
    await this.stateManager.flush()
    return true
  }

  /** give TRX back to an account */
  async creditBalance(address: Address, amountSun: bigint): Promise<void> {
    this.burnedSun -= amountSun
    await this.noteCreation(address)
    await this.stateManager.modifyAccountFields(address, {})
    const account = (await this.stateManager.getAccount(address))!
    account.balance += amountSun
    await this.stateManager.putAccount(address, account)
    await this.stateManager.flush()
  }

  /** move TRX between accounts; false when insufficient */
  async moveBalance(from: Address, to: Address, amountSun: bigint): Promise<boolean> {
    const fromAccount = await this.stateManager.getAccount(from)
    if (fromAccount === undefined || fromAccount.balance < amountSun || amountSun < 0n) return false
    fromAccount.balance -= amountSun
    await this.stateManager.putAccount(from, fromAccount)
    await this.stateManager.modifyAccountFields(to, {})
    const toAccount = (await this.stateManager.getAccount(to))!
    toAccount.balance += amountSun
    await this.stateManager.putAccount(to, toAccount)
    await this.stateManager.flush()
    return true
  }

  private deleteAccountRecords(address: Address): void {
    const key = addressKey(address)
    const remove = <T>(table: Map<string, T>, entry: string): void => {
      const before = table.get(entry)
      if (before === undefined) return
      this.recordUndo(() => {
        table.set(entry, before)
      })
      table.delete(entry)
    }
    remove(this.contracts, key)
    remove(this.accounts, key)
    remove(this.storageSlots, key)
    const tronAddress = toTronHexOf(address)
    for (const table of [this.accountNames, this.accountIds]) {
      for (const [name, owner] of table) {
        if (owner === tronAddress) remove(table, name)
      }
    }
  }

  registerContract(address: Address, meta: ContractMeta): void {
    const key = addressKey(address)
    const before = this.contracts.get(key)
    this.recordUndo(() => {
      if (before === undefined) this.contracts.delete(key)
      else this.contracts.set(key, before)
    })
    this.contracts.set(key, meta)
  }

  getContractMeta(address: Address): ContractMeta | undefined {
    return this.contracts.get(addressKey(address))
  }
}

/** '41' + 40 hex (TRON hex) → TVMJS 20-byte Address */
function tronHexToAddress(hex41: string): Address {
  return createAddressFromString(`0x${hex41.slice(2)}`)
}

/** 41-prefixed hex, the form the name and id registries key owners by */
function toTronHexOf(address: Address): string {
  return `41${bytesToHex(address.bytes).slice(2).toLowerCase()}`
}

function addressKey(address: Address): string {
  return bytesToHex(address.bytes).slice(2).toLowerCase()
}
