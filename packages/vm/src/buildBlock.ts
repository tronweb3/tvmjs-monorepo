import { sha256 } from '@noble/hashes/sha2.js'
import {
  createBlock,
  createSealedCliqueBlock,
  genRequestsRoot,
  genTransactionsTrieRoot,
  genWithdrawalsTrieRoot,
} from '@tvmjs/block'
import { ConsensusType } from '@tvmjs/common'
import { MerklePatriciaTrie } from '@tvmjs/mpt'
import { RLP } from '@tvmjs/rlp'
import {
  Address,
  BIGINT_0,
  BIGINT_1,
  EthereumJSErrorWithoutCode,
  GWEI_TO_WEI,
  KECCAK256_RLP,
  TypeOutput,
  createWithdrawal,
  createZeroAddress,
  toBytes,
  toType,
} from '@tvmjs/util'

import { validateBlockContext } from './blockContext.ts'
import { Bloom } from './bloom/index.ts'
import { accumulateRequests } from './requests.ts'
import {
  accumulateParentBlockHash,
  calculateMinerReward,
  encodeReceipt,
  rewardAccount,
} from './runBlock.ts'
import { runTx } from './runTx.ts'
import { validateTransactionContext } from './transactionContext.ts'
import { validateTronTransactionIdPolicy } from './tronTransactionId.ts'

import type { Block, HeaderData } from '@tvmjs/block'
import type { TypedTransaction } from '@tvmjs/tx'
import type { Withdrawal } from '@tvmjs/util'
import type {
  BuildBlockOpts,
  BuilderOpts,
  RunTxResult,
  SealBlockOpts,
  TronTransactionIdPolicy,
} from './types.ts'
import type { VM } from './vm.ts'

export type BuildStatus = (typeof BuildStatus)[keyof typeof BuildStatus]
export const BuildStatus = {
  Reverted: 'reverted',
  Build: 'build',
  Pending: 'pending',
} as const

type BlockStatus =
  | { status: typeof BuildStatus.Pending | typeof BuildStatus.Reverted }
  | { status: typeof BuildStatus.Build; block: Block }

export class BlockBuilder {
  /**
   * The cumulative gas used by the transactions added to the block.
   */
  gasUsed = BIGINT_0
  /**
   * Value of the block, represented by the final transaction fees
   * accruing to the miner.
   */
  private _minerValue = BIGINT_0

  private readonly vm: VM
  private blockOpts: BuilderOpts
  private headerData: HeaderData
  private transactions: TypedTransaction[] = []
  private transactionResults: RunTxResult[] = []
  private withdrawals?: Withdrawal[]
  private checkpointed = false
  private blockStatus: BlockStatus = { status: BuildStatus.Pending }

  get transactionReceipts() {
    return this.transactionResults.map((result) => result.receipt)
  }

  get minerValue() {
    return this._minerValue
  }

  constructor(vm: VM, opts: BuildBlockOpts) {
    validateBlockContext(opts.parentBlock.header)
    if (opts.headerData) {
      for (const field of ['blobGasUsed', 'excessBlobGas', 'blob_gas_used', 'excess_blob_gas']) {
        if (field in opts.headerData) {
          throw EthereumJSErrorWithoutCode('Blob header fields are no longer supported')
        }
      }
      for (const field of ['parentBeaconBlockRoot', 'parent_beacon_block_root']) {
        if (field in opts.headerData) {
          throw EthereumJSErrorWithoutCode(
            `Beacon root header field ${field} is no longer supported`,
          )
        }
      }
    }
    this.vm = vm
    this.blockOpts = { putBlockIntoBlockchain: true, ...opts.blockOpts, common: this.vm.common }

    this.headerData = {
      ...opts.headerData,
      parentHash: opts.headerData?.parentHash ?? opts.parentBlock.hash(),
      number: opts.headerData?.number ?? opts.parentBlock.header.number + BIGINT_1,
      gasLimit: opts.headerData?.gasLimit ?? opts.parentBlock.header.gasLimit,
      timestamp: opts.headerData?.timestamp ?? Math.round(Date.now() / 1000),
    }
    this.withdrawals = opts.withdrawals?.map(createWithdrawal)

    if (
      this.vm.common.isActivatedEIP(1559) &&
      typeof this.headerData.baseFeePerGas === 'undefined'
    ) {
      this.headerData.baseFeePerGas = opts.parentBlock.header.calcNextBaseFee()
    }
  }

  /**
   * Throws if the block has already been built or reverted.
   */
  private checkStatus() {
    if (this.blockStatus.status === BuildStatus.Build) {
      throw EthereumJSErrorWithoutCode('Block has already been built')
    }
    if (this.blockStatus.status === BuildStatus.Reverted) {
      throw EthereumJSErrorWithoutCode('State has already been reverted')
    }
  }

  public getStatus(): BlockStatus {
    return this.blockStatus
  }

  /**
   * Calculates and returns the transactionsTrie for the block.
   */
  public async transactionsTrie() {
    return genTransactionsTrieRoot(
      this.transactions,
      new MerklePatriciaTrie({ common: this.vm.common }),
    )
  }

  /**
   * Calculates and returns the logs bloom for the block.
   */
  public logsBloom() {
    const bloom = new Bloom(undefined, this.vm.common)
    for (const txResult of this.transactionResults) {
      // Combine blooms via bitwise OR
      bloom.or(txResult.bloom)
    }
    return bloom.bitvector
  }

  /**
   * Calculates and returns the receiptTrie for the block.
   */
  public async receiptTrie() {
    if (this.transactionResults.length === 0) {
      return KECCAK256_RLP
    }
    const receiptTrie = new MerklePatriciaTrie({ common: this.vm.common })
    for (const [i, txResult] of this.transactionResults.entries()) {
      const tx = this.transactions[i]
      const encodedReceipt = encodeReceipt(txResult.receipt, tx.type)
      await receiptTrie.put(RLP.encode(i), encodedReceipt)
    }
    return receiptTrie.root()
  }

  /**
   * Adds the block miner reward to the coinbase account.
   */
  private async rewardMiner() {
    const minerReward = this.vm.common.param('minerReward')
    const reward = calculateMinerReward(minerReward, 0)
    const coinbase =
      this.headerData.coinbase !== undefined
        ? new Address(toBytes(this.headerData.coinbase))
        : createZeroAddress()
    await rewardAccount(this.vm.tvm, coinbase, reward, this.vm.common)
  }

  /**
   * Adds the withdrawal amount to the withdrawal address
   */
  private async processWithdrawals() {
    for (const withdrawal of this.withdrawals ?? []) {
      const { address, amount } = withdrawal
      // If there is no amount to add, skip touching the account
      // as per the implementation of other clients geth/nethermind
      // although this should never happen as no withdrawals with 0
      // amount should ever land up here.
      if (amount === BIGINT_0) continue
      // Withdrawal amount is represented in Gwei so needs to be
      // converted to wei
      await rewardAccount(this.vm.tvm, address, amount * GWEI_TO_WEI, this.vm.common)
    }
  }

  /**
   * Run and add a transaction to the block being built.
   * Please note that this modifies the state of the VM.
   * Throws if the transaction's gasLimit is greater than
   * the remaining gas in the block.
   */
  async addTransaction(
    tx: TypedTransaction,
    opts: {
      skipHardForkValidation?: boolean
      rootTransactionId?: Uint8Array
      tronTransactionIdPolicy?: TronTransactionIdPolicy
    } = {},
  ) {
    validateTransactionContext(tx)
    if ('allowNoBlobs' in opts) {
      throw EthereumJSErrorWithoutCode('allowNoBlobs is no longer supported')
    }
    const { skipHardForkValidation, rootTransactionId, tronTransactionIdPolicy } = opts
    this.checkStatus()
    validateTronTransactionIdPolicy(tronTransactionIdPolicy)

    if (!this.checkpointed) {
      await this.vm.tvm.journal.checkpoint()
      this.checkpointed = true
    }

    // According to the Yellow Paper, a transaction's gas limit
    // cannot be greater than the remaining gas in the block
    const blockGasLimit = toType(this.headerData.gasLimit, TypeOutput.BigInt)

    const blockGasRemaining = blockGasLimit - this.gasUsed
    if (tx.gasLimit > blockGasRemaining) {
      throw EthereumJSErrorWithoutCode(
        'tx has a higher gas limit than the remaining gas in the block',
      )
    }
    const header = {
      ...this.headerData,
      gasUsed: this.gasUsed,
    }

    const blockData = { header, transactions: this.transactions }
    const block = createBlock(blockData, this.blockOpts)

    const result = await runTx(this.vm, {
      tx,
      block,
      skipHardForkValidation,
      rootTransactionId,
      tronTransactionIdPolicy,
    })
    this.transactions.push(tx)
    this.transactionResults.push(result)
    this.gasUsed += result.totalGasSpent
    this._minerValue += result.minerValue

    return result
  }

  /**
   * Reverts the checkpoint on the StateManager to reset the state from any transactions that have been run.
   */
  async revert() {
    if (this.checkpointed) {
      await this.vm.tvm.journal.revert()
      this.checkpointed = false
    }
    this.blockStatus = { status: BuildStatus.Reverted }
  }

  /**
   * This method constructs the finalized block, including withdrawals and any CLRequests.
   * It also:
   *  - Assigns the reward for miner (PoW)
   *  - Commits the checkpoint on the StateManager
   *  - Sets the tip of the VM's blockchain to this block
   * For PoW, optionally seals the block with params `nonce` and `mixHash`,
   * which is validated along with the block number and difficulty by ethash.
   * For PoA, please pass `blockOption.cliqueSigner` into the buildBlock constructor,
   * as the signer will be awarded the txs amount spent on gas as they are added.
   *
   * Note: we add CLRequests here because they can be generated at any time during the
   * lifecycle of a pending block so need to be provided only when the block is finalized.
   */
  async build(sealOpts?: SealBlockOpts) {
    this.checkStatus()
    const blockOpts = this.blockOpts
    const consensusType = this.vm.common.hasConsensus() ? this.vm.common.consensusType() : undefined

    if (consensusType === ConsensusType.ProofOfWork) {
      await this.rewardMiner()
    }
    await this.processWithdrawals()

    const transactionsTrie = await this.transactionsTrie()
    const withdrawalsRoot = this.withdrawals
      ? await genWithdrawalsTrieRoot(
          this.withdrawals,
          new MerklePatriciaTrie({ common: this.vm.common }),
        )
      : undefined
    const receiptTrie = await this.receiptTrie()
    const logsBloom = this.logsBloom()
    const gasUsed = this.gasUsed
    // timestamp should already be set in constructor
    const timestamp = this.headerData.timestamp ?? BIGINT_0

    let requests
    let requestsHash
    if (this.vm.common.isActivatedEIP(7685)) {
      const sha256Function = this.vm.common.customCrypto.sha256 ?? sha256
      requests = await accumulateRequests(this.vm, this.transactionResults)
      requestsHash = genRequestsRoot(requests, sha256Function)
    }

    // get stateRoot after all the accumulateRequests etc have been done
    const stateRoot = await this.vm.stateManager.getStateRoot()
    const headerData = {
      ...this.headerData,
      stateRoot,
      transactionsTrie,
      withdrawalsRoot,
      receiptTrie,
      logsBloom,
      gasUsed,
      timestamp,
      requestsHash,
    }

    if (consensusType === ConsensusType.ProofOfWork) {
      headerData.nonce = sealOpts?.nonce ?? headerData.nonce
      headerData.mixHash = sealOpts?.mixHash ?? headerData.mixHash
    }

    const blockData = {
      header: headerData,
      transactions: this.transactions,
      withdrawals: this.withdrawals,
    }

    let block
    const cs = this.blockOpts.cliqueSigner
    if (cs !== undefined) {
      block = createSealedCliqueBlock(blockData, cs, this.blockOpts)
    } else {
      block = createBlock(blockData, blockOpts)
    }

    if (this.blockOpts.putBlockIntoBlockchain === true) {
      await this.vm.blockchain.putBlock(block)
    }

    this.blockStatus = { status: BuildStatus.Build, block }
    if (this.checkpointed) {
      await this.vm.tvm.journal.commit()
      this.checkpointed = false
    }

    return { block, requests }
  }

  async initState() {
    if (this.vm.common.isActivatedEIP(2935)) {
      if (!this.checkpointed) {
        await this.vm.tvm.journal.checkpoint()
        this.checkpointed = true
      }

      const { parentHash, number } = this.headerData
      // timestamp should already be set in constructor
      const numberBigInt = toType(number ?? 0, TypeOutput.BigInt)
      const parentHashSanitized = toType(parentHash, TypeOutput.Uint8Array) ?? new Uint8Array(32)

      await accumulateParentBlockHash(this.vm, numberBigInt, parentHashSanitized)
    }
  }
}

/**
 * Build a block on top of the current state
 * by adding one transaction at a time.
 *
 * Creates a checkpoint on the StateManager and modifies the state
 * as transactions are run. The checkpoint is committed on {@link BlockBuilder.build}
 * or discarded with {@link BlockBuilder.revert}.
 *
 * @param {VM} vm
 * @param {BuildBlockOpts} opts
 * @returns An instance of {@link BlockBuilder} with methods:
 * - {@link BlockBuilder.addTransaction}
 * - {@link BlockBuilder.build}
 * - {@link BlockBuilder.revert}
 */
export async function buildBlock(vm: VM, opts: BuildBlockOpts): Promise<BlockBuilder> {
  const blockBuilder = new BlockBuilder(vm, opts)
  await blockBuilder.initState()
  return blockBuilder
}
