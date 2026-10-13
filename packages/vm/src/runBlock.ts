import { sha256 } from '@noble/hashes/sha2.js'
import { createBlock, genRequestsRoot } from '@tvmjs/block'
import { ConsensusType } from '@tvmjs/common'
import { MerklePatriciaTrie } from '@tvmjs/mpt'
import { RLP } from '@tvmjs/rlp'
import { type TVM, type TVMInterface } from '@tvmjs/tvm'
import { TransactionType } from '@tvmjs/tx'
import {
  Account,
  Address,
  BIGINT_0,
  BIGINT_1,
  BIGINT_8,
  EthereumJSErrorWithoutCode,
  GWEI_TO_WEI,
  KECCAK256_RLP,
  bigIntToAddressBytes,
  bigIntToBytes,
  bytesToHex,
  concatBytes,
  createBlockLevelAccessList,
  equalsBytes,
  hexToBytes,
  intToBytes,
  setLengthLeft,
  short,
} from '@tvmjs/util'
import debugDefault from 'debug'

import { validateBlockContext } from './blockContext.ts'
import { Bloom } from './bloom/index.ts'
import { emitTVMProfile } from './emitTVMProfile.ts'
import { accumulateRequests } from './requests.ts'
import { runTx } from './runTx.ts'
import { validateTransactionContext } from './transactionContext.ts'
import { validateTronTransactionIdPolicy } from './tronTransactionId.ts'

import type { Block } from '@tvmjs/block'
import type { Common } from '@tvmjs/common'
import type { CLRequest, CLRequestType, PrefixedHexString } from '@tvmjs/util'
import type {
  AfterBlockEvent,
  ApplyBlockResult,
  PostByzantiumTxReceipt,
  PreByzantiumTxReceipt,
  RunBlockOpts,
  RunBlockResult,
  RunTxResult,
  TxReceipt,
} from './types.ts'
import type { VM } from './vm.ts'

const debug = debugDefault('vm:block')

let enableProfiler = false
const stateRootCPLabel = 'New state root, checkpoints, block validation'
const processTxsLabel = 'Tx processing [ use per-tx profiler for more details ]'
const withdrawalsRewardsCommitLabel = 'Withdrawals, Rewards, TVM journal commit'
const entireBlockLabel = 'Entire block'

/**
 * Processes the `block` running all of the transactions it contains and updating the miner's account
 *
 * vm method modifies the state if successfully executed and header fields are valid.
 * state modifications will be reverted if an exception is raised during execution or validation.
 *
 * @param {VM} vm
 * @param {RunBlockOpts} opts - Default values for options:
 *  - `generate`: false
 */
export async function runBlock(vm: VM, opts: RunBlockOpts): Promise<RunBlockResult> {
  validateBlockContext(opts.block.header)
  for (const tx of opts.block.transactions) validateTransactionContext(tx)
  validateTronTransactionIdPolicy(opts.tronTransactionIdPolicy)

  if (vm['_opts'].profilerOpts?.reportAfterBlock === true) {
    enableProfiler = true
    // eslint-disable-next-line no-console
    console.time(entireBlockLabel)
  }
  const stateManager = vm.stateManager

  const { root } = opts
  const clearCache = opts.clearCache ?? true
  let { block } = opts
  const generateFields = opts.generate === true

  if (enableProfiler) {
    const title = `Profiler run - Block ${block.header.number} (${bytesToHex(block.hash())} with ${
      block.transactions.length
    } txs`
    // eslint-disable-next-line no-console
    console.log(title)
    // eslint-disable-next-line no-console
    console.time(stateRootCPLabel)
  }

  /**
   * The `beforeBlock` event.
   *
   * @event Event: beforeBlock
   * @type {Object}
   * @property {Block} block emits the block that is about to be processed
   */
  await vm._emit('beforeBlock', block)

  const setHardforkUsed = opts.setHardfork ?? vm['_setHardfork']
  if (setHardforkUsed === true) {
    vm.common.setHardforkBy({
      blockNumber: block.header.number,
      timestamp: block.header.timestamp,
    })
  }

  if (vm.common.isActivatedEIP(7928)) {
    vm.tvm.blockLevelAccessList = createBlockLevelAccessList()
  }

  if (vm.DEBUG) {
    debug('-'.repeat(100))
    debug(
      `Running block hash=${bytesToHex(block.hash())} number=${
        block.header.number
      } hardfork=${vm.common.hardfork()}`,
    )
  }

  // Set state root if provided
  if (root) {
    if (vm.DEBUG) {
      debug(`Set provided state root ${bytesToHex(root)} clearCache=${clearCache}`)
    }
    await stateManager.setStateRoot(root, clearCache)
  }

  if (vm.common.isActivatedEIP(7864)) {
    // Initialize the access witness

    if (vm.DEBUG) {
      debug(`Initializing executionWitness`)
    }
    if (clearCache) {
      stateManager.clearCaches()
    }
  }

  // Checkpoint state
  await vm.tvm.journal.checkpoint()
  if (vm.DEBUG) {
    debug(`block checkpoint`)
  }

  let result: ApplyBlockResult
  let requestsHash: Uint8Array | undefined
  let requests: CLRequest<CLRequestType>[] | undefined
  let stateRoot: Uint8Array

  try {
    result = await applyBlock(vm, block, opts)
    if (vm.DEBUG) {
      debug(
        `Received block results gasUsed=${result.gasUsed} bloom=${short(result.bloom.bitvector)} (${
          result.bloom.bitvector.length
        } bytes) receiptsRoot=${bytesToHex(result.receiptsRoot)} receipts=${
          result.receipts.length
        } txResults=${result.results.length}`,
      )
    }

    if (block.common.isActivatedEIP(7685)) {
      const sha256Function = vm.common.customCrypto.sha256 ?? sha256
      requests = await accumulateRequests(vm, result.results)
      requestsHash = genRequestsRoot(requests, sha256Function)
    }

    stateRoot = await stateManager.getStateRoot()

    // Given the generate option, either set resulting header
    // values to the current block, or validate the resulting
    // header values against the current block.
    if (generateFields) {
      const logsBloom = result.bloom.bitvector
      const gasUsed = result.gasUsed
      const receiptTrie = result.receiptsRoot
      const transactionsTrie = await _genTxTrie(block)
      const generatedFields = {
        stateRoot,
        logsBloom,
        gasUsed,
        receiptTrie,
        transactionsTrie,
        requestsHash,
      }
      const blockData = {
        ...block,
        header: { ...block.header, ...generatedFields },
      }
      block = createBlock(blockData, { common: vm.common })
    } else {
      if (vm.common.isActivatedEIP(7685)) {
        if (!equalsBytes(block.header.requestsHash!, requestsHash!)) {
          if (vm.DEBUG)
            debug(
              `Invalid requestsHash received=${bytesToHex(
                block.header.requestsHash!,
              )} expected=${bytesToHex(requestsHash!)}`,
            )
          const msg = _errorMsg('invalid requestsHash', vm, block)
          throw EthereumJSErrorWithoutCode(msg)
        }
      }

      // Only validate the following headers if Stateless isn't activated
      if (equalsBytes(result.receiptsRoot, block.header.receiptTrie) === false) {
        if (vm.DEBUG) {
          debug(
            `Invalid receiptTrie received=${bytesToHex(result.receiptsRoot)} expected=${bytesToHex(
              block.header.receiptTrie,
            )}`,
          )
        }
        const msg = _errorMsg('invalid receiptTrie', vm, block)
        throw EthereumJSErrorWithoutCode(msg)
      }
      if (!(equalsBytes(result.bloom.bitvector, block.header.logsBloom) === true)) {
        if (vm.DEBUG) {
          debug(
            `Invalid bloom received=${bytesToHex(result.bloom.bitvector)} expected=${bytesToHex(
              block.header.logsBloom,
            )}`,
          )
        }
        const msg = _errorMsg('invalid bloom', vm, block)
        throw EthereumJSErrorWithoutCode(msg)
      }
      if (result.gasUsed !== block.header.gasUsed) {
        if (vm.DEBUG) {
          debug(`Invalid gasUsed received=${result.gasUsed} expected=${block.header.gasUsed}`)
        }
        const msg = _errorMsg('invalid gasUsed', vm, block)
        throw EthereumJSErrorWithoutCode(msg)
      }
      if (!(equalsBytes(stateRoot, block.header.stateRoot) === true)) {
        if (vm.DEBUG) {
          debug(
            `Invalid stateRoot received=${bytesToHex(stateRoot)} expected=${bytesToHex(
              block.header.stateRoot,
            )}`,
          )
        }
        const msg = _errorMsg(
          `invalid block stateRoot, got: ${bytesToHex(stateRoot)}, want: ${bytesToHex(
            block.header.stateRoot,
          )}`,
          vm,
          block,
        )
        throw EthereumJSErrorWithoutCode(msg)
      }

      if (vm.common.isActivatedEIP(7864)) {
        if (vm.tvm.binaryTreeAccessWitness === undefined) {
          throw Error(`binaryTreeAccessWitness required if binary tree (EIP-7864) is activated`)
        }
        // If binary tree is activated and executing statelessly, only validate the post-state
        if (
          (await vm['_opts'].stateManager!.verifyBinaryTreePostState!(
            vm.tvm.binaryTreeAccessWitness,
          )) === false
        ) {
          throw EthereumJSErrorWithoutCode(
            `Binary tree post state verification failed on block ${block.header.number}`,
          )
        }
        debug(`Binary tree post state verification succeeded`)
      }
    }
  } catch (err) {
    await vm.tvm.journal.revert()
    if (vm.DEBUG) {
      debug(`block checkpoint reverted`)
    }
    if (enableProfiler) {
      // eslint-disable-next-line no-console
      console.timeEnd(withdrawalsRewardsCommitLabel)
    }
    throw err
  }

  // Persist state. Deliberately outside the rollback catch above: the StateManager pops the
  // underlying trie checkpoint before it can fail on a DB write or flush, so reverting a failed
  // commit would target a checkpoint that no longer exists and mask the original error with
  // 'trying to revert when not checkpointed'. Only pre-commit failures are rolled back.
  await vm.tvm.journal.commit()
  if (vm.DEBUG) {
    debug(`block checkpoint committed`)
  }

  if (enableProfiler) {
    // eslint-disable-next-line no-console
    console.timeEnd(withdrawalsRewardsCommitLabel)
  }

  const results: RunBlockResult = {
    receipts: result.receipts,
    logsBloom: result.bloom.bitvector,
    results: result.results,
    stateRoot,
    gasUsed: result.gasUsed,
    receiptsRoot: result.receiptsRoot,
    preimages: result.preimages,
    requestsHash,
    requests,
    blockLevelAccessList: vm.tvm.blockLevelAccessList,
  }

  const afterBlockEvent: AfterBlockEvent = { ...results, block }

  /**
   * The `afterBlock` event
   *
   * @event Event: afterBlock
   * @type {AfterBlockEvent}
   * @property {AfterBlockEvent} result emits the results of processing a block
   */
  await vm._emit('afterBlock', afterBlockEvent)
  if (vm.DEBUG) {
    debug(
      `Running block finished hash=${bytesToHex(block.hash())} number=${
        block.header.number
      } hardfork=${vm.common.hardfork()}`,
    )
  }

  if (enableProfiler) {
    // eslint-disable-next-line no-console
    console.timeEnd(entireBlockLabel)
    const logs = (vm.tvm as TVM).getPerformanceLogs()
    if (logs.precompiles.length === 0 && logs.opcodes.length === 0) {
      // eslint-disable-next-line no-console
      console.log('No block txs with precompile or opcode execution.')
    }

    emitTVMProfile(logs.precompiles, 'Precompile performance')
    emitTVMProfile(logs.opcodes, 'Opcodes performance')
    ;(vm.tvm as TVM).clearPerformanceLogs()
  }

  return results
}

/**
 * Validates and applies a block, computing the results of
 * applying its transactions. vm method doesn't modify the
 * block itself. It computes the block rewards and puts
 * them on state (but doesn't persist the changes).
 * @param {Block} block
 * @param {RunBlockOpts} opts
 */
async function applyBlock(vm: VM, block: Block, opts: RunBlockOpts): Promise<ApplyBlockResult> {
  // Validate block
  if (opts.skipBlockValidation !== true) {
    if (block.header.gasLimit >= BigInt('0x8000000000000000')) {
      const msg = _errorMsg('Invalid block with gas limit greater than (2^63 - 1)', vm, block)
      throw EthereumJSErrorWithoutCode(msg)
    } else {
      if (vm.DEBUG) {
        debug(`Validate block`)
      }
      // TODO: decide what block validation method is appropriate here
      if (opts.skipHeaderValidation !== true) {
        if (typeof (vm.blockchain as any).validateHeader === 'function') {
          await (vm.blockchain as any).validateHeader(block.header)
        } else {
          throw EthereumJSErrorWithoutCode(
            'cannot validate header: blockchain has no `validateHeader` method',
          )
        }
      }
      await block.validateData(false, true, opts.validateBlockSize ?? false)
    }
  }
  if (vm.common.isActivatedEIP(2935)) {
    if (vm.DEBUG) {
      debug(`accumulate parentBlockHash `)
    }

    await accumulateParentBlockHash(vm, block.header.number, block.header.parentHash)
  }

  if (enableProfiler) {
    // eslint-disable-next-line no-console
    console.timeEnd(stateRootCPLabel)
  }

  // Apply transactions
  if (vm.DEBUG) {
    debug(`Apply transactions`)
  }

  const blockResults = await applyTransactions(vm, block, opts)

  if (enableProfiler) {
    // eslint-disable-next-line no-console
    console.time(withdrawalsRewardsCommitLabel)
  }

  // Add txResult preimages to the blockResults preimages
  // Also add the coinbase preimage

  if (opts.reportPreimages === true) {
    if (vm.tvm.stateManager.getAppliedKey === undefined) {
      throw EthereumJSErrorWithoutCode(
        'applyBlock: tvm.stateManager.getAppliedKey can not be undefined if reportPreimages is true',
      )
    }
    blockResults.preimages.set(
      bytesToHex(vm.tvm.stateManager.getAppliedKey(block.header.coinbase.toBytes())),
      block.header.coinbase.toBytes(),
    )
    for (const txResult of blockResults.results) {
      if (txResult.preimages !== undefined) {
        for (const [key, preimage] of txResult.preimages) {
          blockResults.preimages.set(key, preimage)
        }
      }
    }
  }

  if (vm.common.isActivatedEIP(4895)) {
    if (opts.reportPreimages === true) vm.tvm.journal.startReportingPreimages!()
    await assignWithdrawals(vm, block)
    if (opts.reportPreimages === true && vm.tvm.journal.preimages !== undefined) {
      for (const [key, preimage] of vm.tvm.journal.preimages) {
        blockResults.preimages.set(key, preimage)
      }
    }
    await vm.tvm.journal.cleanup()
  }
  // Pay ommers and miners
  if (block.common.hasConsensus() && block.common.consensusType() === ConsensusType.ProofOfWork) {
    await assignBlockRewards(vm, block)
  }

  if (vm.common.isActivatedEIP(7864) && vm.tvm.systemBinaryTreeAccessWitness !== undefined) {
    vm.tvm.systemBinaryTreeAccessWitness?.commit()
    if (vm.DEBUG) {
      debug('Binary tree access witness aggregate costs:')
      vm.tvm.binaryTreeAccessWitness?.debugWitnessCost()
      debug('System binary tree access witness aggregate costs:')
      vm.tvm.systemBinaryTreeAccessWitness?.debugWitnessCost()
    }
    vm.tvm.binaryTreeAccessWitness?.merge(vm.tvm.systemBinaryTreeAccessWitness)
  }

  return blockResults
}

/**
 * vm method runs the logic of EIP 2935 (save blockhashes to state)
 * It will put the `parentHash` of the block to the storage slot of `block.number - 1` of the history storage contract.
 * vm contract is used to retrieve BLOCKHASHes in TVM if EIP 2935 is activated.
 * In case that the previous block of `block` is pre-EIP-2935 (so we are on the EIP 2935 fork block), additionally
 * also add the currently available past blockhashes which are available by BLOCKHASH (so, the past 256 block hashes)
 * @param vm The VM to run on
 * @param block The current block to save the parent block hash of
 */
export async function accumulateParentBlockHash(
  vm: VM,
  currentBlockNumber: bigint,
  parentHash: Uint8Array,
) {
  if (!vm.common.isActivatedEIP(2935)) {
    throw EthereumJSErrorWithoutCode(
      'Cannot call `accumulateParentBlockHash`: EIP 2935 is not active',
    )
  }
  const historyAddress = new Address(bigIntToAddressBytes(vm.common.param('historyStorageAddress')))
  const historyServeWindow = vm.common.param('historyServeWindow')

  // getAccount with historyAddress will throw error as witnesses are not bundled
  // but we need to put account so as to query later for slot
  const code = await vm.stateManager.getCode(historyAddress)

  if (code.length === 0) {
    // Exit early, system contract has no code so no storage is written
    return
  }

  async function putBlockHash(vm: VM, hash: Uint8Array, number: bigint) {
    // ringKey is the key the hash is actually put in (it is a ring buffer)
    const ringKey = number % historyServeWindow

    if (vm.common.isActivatedEIP(7864)) {
      if (vm.tvm.systemBinaryTreeAccessWitness === undefined) {
        throw Error(`systemBinaryTreeAccessWitness required if binary tree (EIP-7864) is activated`)
      }
      // Add to system binary tree access witness so that it doesn't warm up tx accesses
      vm.tvm.systemBinaryTreeAccessWitness.writeAccountStorage(historyAddress, ringKey)
    }
    const key = setLengthLeft(bigIntToBytes(ringKey), 32)
    if (vm.common.isActivatedEIP(7928)) {
      vm.tvm.blockLevelAccessList!.addStorageWrite(
        historyAddress.toString(),
        key,
        hash,
        vm.tvm.blockLevelAccessList!.blockAccessIndex,
      )
    }
    await vm.stateManager.putStorage(historyAddress, key, hash)
  }
  await putBlockHash(vm, parentHash, currentBlockNumber - BIGINT_1)

  // do cleanup if the code was not deployed
  await vm.tvm.journal.cleanup()
}

/**
 * Applies the transactions in a block, computing the receipts
 * as well as gas usage and some relevant data. vm method is
 * side-effect free (it doesn't modify the block nor the state).
 * @param {Block} block
 * @param {RunBlockOpts} opts
 */
async function applyTransactions(vm: VM, block: Block, opts: RunBlockOpts) {
  if (enableProfiler) {
    // eslint-disable-next-line no-console
    console.time(processTxsLabel)
  }

  const bloom = new Bloom(undefined, vm.common)
  // Block header gas accounting (EIP-7778: no refund subtraction)
  let gasUsed = BIGINT_0
  // Receipt cumulative gas accounting (keeps tx refund subtraction semantics)
  let receiptGasUsed = BIGINT_0

  let receiptTrie: MerklePatriciaTrie | undefined = undefined
  if (block.transactions.length !== 0) {
    receiptTrie = new MerklePatriciaTrie({ common: vm.common })
  }

  const receipts: TxReceipt[] = []
  const txResults: RunTxResult[] = []

  /*
   * Process transactions
   */
  for (let txIdx = 0; txIdx < block.transactions.length; txIdx++) {
    if (vm.common.isActivatedEIP(7928)) {
      vm.tvm.blockLevelAccessList!.blockAccessIndex = txIdx + 1
    }
    const tx = block.transactions[txIdx]

    if (vm.DEBUG) {
      debug(
        `Run tx ${txIdx + 1}/${block.transactions.length} gasLimit=${tx.gasLimit} type=${tx.type} (block gas used so far: ${gasUsed}/${block.header.gasLimit})`,
      )
    }

    const gasLimitIsHigherThanBlock = block.header.gasLimit < tx.gasLimit + gasUsed
    if (gasLimitIsHigherThanBlock) {
      const msg = _errorMsg('tx has a higher gas limit than the block', vm, block)
      throw EthereumJSErrorWithoutCode(msg)
    }

    // Run the tx through the VM
    const { skipBalance, skipNonce, skipHardForkValidation, reportPreimages } = opts

    const txRes = await runTx(vm, {
      tx,
      block,
      rootTransactionId: opts.rootTransactionIds?.[txIdx],
      tronTransactionIdPolicy: opts.tronTransactionIdPolicy,
      skipBalance,
      skipNonce,
      skipHardForkValidation,
      blockGasUsed: receiptGasUsed,
      reportPreimages,
    })
    txResults.push(txRes)
    if (vm.DEBUG) {
      debug('-'.repeat(100))
    }

    // Add to total block gas usage
    gasUsed += txRes.blockGasSpent
    receiptGasUsed += txRes.totalGasSpent
    if (vm.DEBUG) {
      debug(`Add tx gas used (${txRes.blockGasSpent}) to total block gas usage (-> ${gasUsed})`)
    }

    // Combine blooms via bitwise OR
    bloom.or(txRes.bloom)

    // Add receipt to trie to later calculate receipt root
    receipts.push(txRes.receipt)
    const encodedReceipt = encodeReceipt(txRes.receipt, tx.type)
    await receiptTrie!.put(RLP.encode(txIdx), encodedReceipt)
  }

  if (enableProfiler) {
    // eslint-disable-next-line no-console
    console.timeEnd(processTxsLabel)
  }

  const receiptsRoot = receiptTrie !== undefined ? receiptTrie.root() : KECCAK256_RLP

  return {
    bloom,
    gasUsed,
    preimages: new Map<PrefixedHexString, Uint8Array>(),
    receiptsRoot,
    receipts,
    results: txResults,
  }
}

async function assignWithdrawals(vm: VM, block: Block): Promise<void> {
  if (vm.common.isActivatedEIP(7928)) {
    vm.tvm.blockLevelAccessList!.blockAccessIndex = block.transactions.length + 1
  }
  const withdrawals = block.withdrawals!
  for (const withdrawal of withdrawals) {
    const { address, amount } = withdrawal
    // Withdrawal amount is represented in Gwei so needs to be
    // converted to wei
    // Note: event if amount is 0, still reward the account
    // such that the account is touched and marked for cleanup if it is empty
    await rewardAccount(vm.tvm, address, amount * GWEI_TO_WEI, vm.common)
  }
}

/**
 * Calculates block rewards for miner and ommers and puts
 * the updated balances of their accounts to state.
 */
async function assignBlockRewards(vm: VM, block: Block): Promise<void> {
  if (vm.DEBUG) {
    debug(`Assign block rewards`)
  }
  const minerReward = vm.common.param('minerReward')
  const ommers = block.uncleHeaders
  // Reward ommers
  for (const ommer of ommers) {
    const reward = calculateOmmerReward(ommer.number, block.header.number, minerReward)
    const account = await rewardAccount(vm.tvm, ommer.coinbase, reward, vm.common)
    if (vm.DEBUG) {
      debug(`Add uncle reward ${reward} to account ${ommer.coinbase} (-> ${account.balance})`)
    }
  }
  // Reward miner
  const reward = calculateMinerReward(minerReward, ommers.length)
  const account = await rewardAccount(vm.tvm, block.header.coinbase, reward, vm.common)
  if (vm.DEBUG) {
    debug(`Add miner reward ${reward} to account ${block.header.coinbase} (-> ${account.balance})`)
  }
}

function calculateOmmerReward(
  ommerBlockNumber: bigint,
  blockNumber: bigint,
  minerReward: bigint,
): bigint {
  const heightDiff = blockNumber - ommerBlockNumber
  let reward = ((BIGINT_8 - heightDiff) * minerReward) / BIGINT_8
  if (reward < BIGINT_0) {
    reward = BIGINT_0
  }
  return reward
}

export function calculateMinerReward(minerReward: bigint, ommersNum: number): bigint {
  // calculate nibling reward
  const niblingReward = minerReward / BigInt(32)
  const totalNiblingReward = niblingReward * BigInt(ommersNum)
  const reward = minerReward + totalNiblingReward
  return reward
}

export async function rewardAccount(
  tvm: TVMInterface,
  address: Address,
  reward: bigint,
  common: Common,
): Promise<Account> {
  let account = await tvm.stateManager.getAccount(address)
  if (account === undefined) {
    if (common.isActivatedEIP(7864) === true && reward !== BIGINT_0) {
      if (tvm.systemBinaryTreeAccessWitness === undefined) {
        throw Error(`systemBinaryTreeAccessWitness required if binary tree (EIP-7864) is activated`)
      }
      tvm.systemBinaryTreeAccessWitness.writeAccountHeader(address)
    }
    account = new Account()
  }
  const originalBalance = account.balance
  account.balance += reward
  if (common.isActivatedEIP(7928)) {
    if (reward === BIGINT_0) {
      tvm.blockLevelAccessList?.addAddress(address.toString())
    } else {
      tvm.blockLevelAccessList!.addBalanceChange(
        address.toString(),
        account.balance,
        tvm.blockLevelAccessList!.blockAccessIndex,
        originalBalance,
      )
    }
  }
  await tvm.journal.putAccount(address, account)

  if (common.isActivatedEIP(7864) === true && reward !== BIGINT_0) {
    if (tvm.systemBinaryTreeAccessWitness === undefined) {
      throw Error(`systemBinaryTreeAccessWitness required if binary tree (EIP-7864) is activated`)
    }
    tvm.systemBinaryTreeAccessWitness.writeAccountBasicData(address)
    tvm.systemBinaryTreeAccessWitness.readAccountCodeHash(address)
  }
  return account
}

/**
 * Returns the encoded tx receipt.
 */
export function encodeReceipt(
  receipt: TxReceipt,
  txType: (typeof TransactionType)[keyof typeof TransactionType],
) {
  const encoded = RLP.encode([
    (receipt as PreByzantiumTxReceipt).stateRoot ??
      ((receipt as PostByzantiumTxReceipt).status === 0 ? Uint8Array.from([]) : hexToBytes('0x01')),
    bigIntToBytes(receipt.cumulativeBlockGasUsed),
    receipt.bitvector,
    receipt.logs,
  ])

  if (txType === TransactionType.Legacy) {
    return encoded
  }

  // Serialize receipt according to EIP-2718:
  // `typed-receipt = tx-type || receipt-data`
  return concatBytes(intToBytes(txType), encoded)
}

async function _genTxTrie(block: Block) {
  if (block.transactions.length === 0) {
    return KECCAK256_RLP
  }
  const trie = new MerklePatriciaTrie({ common: block.common })
  for (const [i, tx] of block.transactions.entries()) {
    await trie.put(RLP.encode(i), tx.serialize())
  }
  return trie.root()
}

/**
 * Internal helper function to create an annotated error message
 *
 * @param msg Base error message
 * @hidden
 */
function _errorMsg(msg: string, vm: VM, block: Block) {
  const blockErrorStr = 'errorStr' in block ? block.errorStr() : 'block'

  const errorMsg = `${msg} (${vm.errorStr()} -> ${blockErrorStr})`
  return errorMsg
}
