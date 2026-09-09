import { Hardfork } from '@tvmjs/common'
import type { BlockLevelAccessList, PrefixedHexString } from '@tvmjs/util'
import {
  Account,
  Address,
  BIGINT_0,
  BIGINT_1,
  EthereumJSErrorWithoutCode,
  KECCAK256_NULL,
  KECCAK256_RLP,
  MAX_INTEGER,
  bigIntToBytes,
  bytesToUnprefixedHex,
  createBlockLevelAccessList,
  createZeroAddress,
  equalsBytes,
  generateAddress,
  generateAddress2,
  generateTronAddress2,
  generateTronContractAddress,
  generateTronCreateAddress,
  isDebugEnabled,
  short,
} from '@tvmjs/util'
import debugDefault from 'debug'
import { EventEmitter } from 'eventemitter3'

import { createEIP7708TransferLog } from './eip7708.ts'
import { FORMAT } from './eof/constants.ts'
import { isEOF } from './eof/util.ts'
import { TVMError } from './errors.ts'
import { Interpreter } from './interpreter.ts'
import { Journal } from './journal.ts'
import { TVMPerformanceLogger } from './logger.ts'
import { Message, createTronTransactionContext } from './message.ts'
import { getOpcodesForHF } from './opcodes/index.ts'
import { paramsTVM } from './params.ts'
import { NobleBLS, getActivePrecompiles, getPrecompileName } from './precompiles/index.ts'
import { TransientStorage } from './transientStorage.ts'
import {
  type Block,
  type CustomOpcode,
  DELEGATION_7702_FLAG,
  type ExecResult,
  type Log,
  type TVMBLSInterface,
  type TVMBN254Interface,
  type TVMEvent,
  type TVMInterface,
  type TVMMockBlockchainInterface,
  type TVMOpts,
  type TVMResult,
  type TVMRunCallOpts,
  type TVMRunCodeOpts,
} from './types.ts'

import type { Common, StateManagerInterface } from '@tvmjs/common'
import type { BinaryTreeAccessWitness } from './binaryTreeAccessWitness.ts'
import type { InterpreterOpts } from './interpreter.ts'
import type { Timer } from './logger.ts'
import type { MessageWithTo } from './message.ts'
import type { AsyncDynamicGasHandler, SyncDynamicGasHandler } from './opcodes/gas.ts'
import type { OpHandler, OpcodeList, OpcodeMap } from './opcodes/index.ts'
import type { CustomPrecompile, PrecompileFunc } from './precompiles/index.ts'

const debug = debugDefault('tvm:tvm')
const debugGas = debugDefault('tvm:gas')
const debugPrecompiles = debugDefault('tvm:precompiles')

type EventRegistration = {
  fn: (...args: any[]) => void
  context: any
  once: boolean
}

function getEventRegistrations(emitter: EventEmitter<any>, event: string): EventRegistration[] {
  // EventEmitter3's public listeners() API discards per-registration `once` and `context`
  // metadata. Snapshot the v5 registration records so async serial dispatch can match emit().
  const eventKey = EventEmitter.prefixed ? `${EventEmitter.prefixed}${event}` : event
  const registered = (
    emitter as EventEmitter<any> & {
      _events: Record<string, EventRegistration | EventRegistration[] | undefined>
    }
  )._events[eventKey]
  if (registered === undefined) {
    return []
  }
  return Array.isArray(registered) ? registered.slice() : [registered]
}

/**
 * Creates a standardized ExecResult for out-of-gas errors.
 * @param gasLimit - Gas limit consumed by the failing frame
 * @returns Execution result describing the OOG failure
 */
export function OOGResult(gasLimit: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasLimit,
    exceptionError: new TVMError(TVMError.errorMessages.OUT_OF_GAS),
  }
}
/**
 * Creates an ExecResult for code-deposit out-of-gas errors (EIP-3541).
 * @param gasUsedCreateCode - Gas consumed while attempting to store code
 */
export function COOGResult(gasUsedCreateCode: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasUsedCreateCode,
    exceptionError: new TVMError(TVMError.errorMessages.CODESTORE_OUT_OF_GAS),
  }
}

/**
 * Returns an ExecResult signalling invalid bytecode input.
 * @param gasLimit - Gas consumed up to the point of failure
 */
export function INVALID_BYTECODE_RESULT(gasLimit: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasLimit,
    exceptionError: new TVMError(TVMError.errorMessages.INVALID_BYTECODE_RESULT),
  }
}

/**
 * Returns an ExecResult signalling invalid EOF formatting.
 * @param gasLimit - Gas consumed up to the point of failure
 */
export function INVALID_EOF_RESULT(gasLimit: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasLimit,
    exceptionError: new TVMError(TVMError.errorMessages.INVALID_EOF_FORMAT),
  }
}

/**
 * Returns an ExecResult for code size violations.
 * @param gasUsed - Gas consumed before the violation was detected
 */
export function CodesizeExceedsMaximumError(gasUsed: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasUsed,
    exceptionError: new TVMError(TVMError.errorMessages.CODESIZE_EXCEEDS_MAXIMUM),
  }
}

/**
 * Wraps an {@link TVMError} in an ExecResult.
 * @param error - Error encountered during execution
 * @param gasUsed - Gas consumed up to the error
 */
export function TVMErrorResult(error: TVMError, gasUsed: bigint): ExecResult {
  return {
    returnValue: new Uint8Array(0),
    executionGasUsed: gasUsed,
    exceptionError: error,
  }
}

/**
 * Creates a default block header used by stand-alone executions.
 * @returns Block-like object with zeroed header fields
 */
export function defaultBlock(): Block {
  return {
    header: {
      number: BIGINT_0,
      coinbase: createZeroAddress(),
      timestamp: BIGINT_0,
      difficulty: BIGINT_0,
      prevRandao: new Uint8Array(32),
      gasLimit: BIGINT_0,
      baseFeePerGas: undefined,
      getBlobGasPrice: () => undefined,
    },
  }
}

/**
 * The TVM (Ethereum Virtual Machine) is responsible for executing TVM bytecode, processing transactions, and managing state changes. It handles both contract calls and contract creation operations.
 *
 * An TVM instance can be created with the constructor method:
 *
 * - {@link createTVM}
 */
export class TVM implements TVMInterface {
  protected static supportedHardforks = [
    Hardfork.Chainstart,
    Hardfork.Homestead,
    Hardfork.Dao,
    Hardfork.TangerineWhistle,
    Hardfork.SpuriousDragon,
    Hardfork.Byzantium,
    Hardfork.Constantinople,
    Hardfork.Petersburg,
    Hardfork.Istanbul,
    Hardfork.MuirGlacier,
    Hardfork.Berlin,
    Hardfork.London,
    Hardfork.ArrowGlacier,
    Hardfork.GrayGlacier,
    Hardfork.MergeNetsplitBlock,
    Hardfork.Paris,
    Hardfork.Shanghai,
    Hardfork.Cancun,
    Hardfork.Prague,
    Hardfork.Osaka,
    Hardfork.Bpo1,
    Hardfork.Bpo2,
    Hardfork.Bpo3,
    Hardfork.Bpo4,
    Hardfork.Bpo5,
    Hardfork.Amsterdam,
    Hardfork.Tron,
  ]
  protected _tx?: {
    gasPrice: bigint
    origin: Address
  }
  protected _block?: Block
  /** Number of active public execution entry points on this shared TVM instance. */
  protected _activeExecutions = 0

  public readonly common: Common
  public readonly events: EventEmitter<TVMEvent>

  public stateManager: StateManagerInterface
  public blockchain: TVMMockBlockchainInterface
  public journal: Journal
  public binaryAccessWitness?: BinaryTreeAccessWitness
  public systemBinaryAccessWitness?: BinaryTreeAccessWitness

  public readonly transientStorage: TransientStorage

  protected _opcodes!: OpcodeList

  public readonly allowUnlimitedContractSize: boolean
  public readonly allowUnlimitedInitCodeSize: boolean

  public readonly blockLevelAccessList?: BlockLevelAccessList

  protected readonly _customOpcodes?: CustomOpcode[]
  protected readonly _customPrecompiles?: CustomPrecompile[]

  protected _handlers!: Map<number, OpHandler>

  protected _dynamicGasHandlers!: Map<number, AsyncDynamicGasHandler | SyncDynamicGasHandler>

  protected _opcodeMap!: OpcodeMap

  protected _precompiles!: Map<string, PrecompileFunc>

  protected readonly _optsCached: TVMOpts

  protected performanceLogger: TVMPerformanceLogger

  public get precompiles() {
    return this._precompiles
  }

  public get opcodes() {
    return this._opcodes
  }

  protected readonly _bls?: TVMBLSInterface

  /**
   * TVM is run in DEBUG mode (default: false)
   * Taken from DEBUG environment variable
   *
   * Safeguards on debug() calls are added for
   * performance reasons to avoid string literal evaluation
   * @hidden
   */
  readonly DEBUG: boolean = false

  protected readonly _emit: (topic: string, data: any) => Promise<void>

  private _bn254: TVMBN254Interface

  /**
   *
   * Creates new TVM object
   *
   * @deprecated The direct usage of this constructor is replaced since
   * non-finalized async initialization lead to side effects. Please
   * use the async {@link createTVM} constructor instead (same API).
   *
   * @param opts The TVM options
   * @param bn128 Initialized bn128 WASM object for precompile usage (internal)
   */
  constructor(opts: TVMOpts) {
    this.common = opts.common!
    this.blockchain = opts.blockchain!
    this.stateManager = opts.stateManager!

    if (this.common.isActivatedEIP(7864)) {
      const mandatory = ['checkChunkWitnessPresent']
      for (const m of mandatory) {
        if (!(m in this.stateManager)) {
          throw EthereumJSErrorWithoutCode(
            `State manager used must implement ${m} if Binary Trees (EIP-7864) is activated`,
          )
        }
      }
    }

    if (this.common.isActivatedEIP(7928)) {
      this.blockLevelAccessList = opts.blockLevelAccessList ?? createBlockLevelAccessList()
    }

    this.events = new EventEmitter<TVMEvent>()
    this._optsCached = opts

    // Supported EIPs
    const supportedEIPs = [
      1153, 1559, 2537, 2565, 2718, 2929, 2930, 2935, 3198, 3529, 3540, 3541, 3607, 3651, 3670,
      3855, 3860, 4200, 4399, 4750, 4788, 4844, 4895, 5133, 5450, 5656, 6110, 6206, 6780, 7002,
      7069, 7251, /* 7480, */ 7516, 7594, 7620, 7685, 7691, 7692, 7698, 7702, 7709, 7823, 7825,
      7934, 7939, 7951, 8024,
    ]

    for (const eip of this.common.eips()) {
      if (!supportedEIPs.includes(eip)) {
        throw EthereumJSErrorWithoutCode(`EIP-${eip} is not supported by the TVM`)
      }
    }

    if (!TVM.supportedHardforks.includes(this.common.hardfork() as Hardfork)) {
      throw EthereumJSErrorWithoutCode(
        `Hardfork ${this.common.hardfork()} not set as supported in supportedHardforks`,
      )
    }

    this.common.updateParams(opts.params ?? paramsTVM)

    this.allowUnlimitedContractSize = opts.allowUnlimitedContractSize ?? false
    this.allowUnlimitedInitCodeSize = opts.allowUnlimitedInitCodeSize ?? false
    this._customOpcodes = opts.customOpcodes
    this._customPrecompiles = opts.customPrecompiles

    this.journal = new Journal(this.stateManager, this.common)
    this.transientStorage = new TransientStorage()

    this.common.events.on('hardforkChanged', () => {
      this.getActiveOpcodes()
      this._precompiles = getActivePrecompiles(this.common, this._customPrecompiles)
    })

    // Initialize the opcode data
    this.getActiveOpcodes()
    this._precompiles = getActivePrecompiles(this.common, this._customPrecompiles)

    // Precompile crypto libraries
    if (this.common.isActivatedEIP(2537)) {
      this._bls = opts.bls ?? new NobleBLS()
      this._bls.init?.()
    }

    this._bn254 = opts.bn254!

    this._emit = async (topic: string, data: any): Promise<void> => {
      const event = topic as keyof TVMEvent
      const registrations = getEventRegistrations(this.events, topic)
      for (const { fn, context, once } of registrations) {
        // `_emit` invokes listeners directly so callback-style listeners can be awaited in series.
        // Mirror EventEmitter.emit() by removing one-time registrations immediately before their
        // callback is invoked, including when it throws.
        if (once) {
          this.events.removeListener(event, fn, undefined, true)
        }
        if (fn.length === 2) {
          await new Promise<void>((resolve) => {
            fn.call(context, data, resolve)
          })
        } else {
          fn.call(context, data)
        }
      }
    }

    this.performanceLogger = new TVMPerformanceLogger()

    // Skip DEBUG calls unless 'tvmjs' included in environmental DEBUG variables
    this.DEBUG = isDebugEnabled('tvmjs')
  }

  /**
   * Returns a list with the currently activated opcodes
   * available for TVM execution
   */
  getActiveOpcodes(): OpcodeList {
    const data = getOpcodesForHF(this.common, this._customOpcodes)
    this._opcodes = data.opcodes
    this._dynamicGasHandlers = data.dynamicGasHandlers
    this._handlers = data.handlers
    this._opcodeMap = data.opcodeMap
    return data.opcodes
  }

  protected async _executeCall(message: MessageWithTo): Promise<TVMResult> {
    let gasLimit = message.gasLimit
    const fromAddress = message.caller

    if (this.common.isActivatedEIP(7864)) {
      if (message.accessWitness === undefined) {
        throw EthereumJSErrorWithoutCode('accessWitness is required for EIP-7864')
      }
      const sendsValue = message.value !== BIGINT_0
      if (message.depth === 0) {
        const originAccessGas = message.accessWitness.readAccountHeader(fromAddress)
        debugGas(`originAccessGas=${originAccessGas} waived off for origin at depth=0`)

        let destAccessGas = message.accessWitness.readAccountCodeHash(message.to)
        if (sendsValue) {
          destAccessGas += message.accessWitness.writeAccountBasicData(message.to)
        } else {
          destAccessGas += message.accessWitness.readAccountBasicData(message.to)
        }

        debugGas(`destAccessGas=${destAccessGas} waived off for target at depth=0`)
      }

      let callAccessGas = message.accessWitness.readAccountBasicData(message.to)
      if (sendsValue) {
        callAccessGas += message.accessWitness.writeAccountBasicData(message.to)
      }
      gasLimit -= callAccessGas
      if (gasLimit < BIGINT_0) {
        if (this.DEBUG) {
          debugGas(`callAccessGas charged(${callAccessGas}) caused OOG (-> ${gasLimit})`)
        }
        message.accessWitness.revert()
        return { execResult: OOGResult(message.gasLimit) }
      } else {
        if (this.DEBUG) {
          debugGas(`callAccessGas used (${callAccessGas} gas (-> ${gasLimit}))`)
        }
        message.accessWitness.commit()
      }
    }

    let account = await this.stateManager.getAccount(fromAddress)
    if (!account) {
      account = new Account()
    }
    let errorMessage
    // Reduce tx value from sender
    if (!message.delegatecall) {
      try {
        await this._reduceSenderBalance(account, message)
        await this._reduceSenderTokenBalance(account, message)
      } catch (e) {
        errorMessage = e
      }
    }

    // Load `to` account
    let toAccount = await this.stateManager.getAccount(message.to)
    if (!toAccount) {
      if (this.common.isActivatedEIP(6800) || this.common.isActivatedEIP(7864)) {
        const absenceProofAccessGas = message.accessWitness!.readAccountHeader(message.to)
        gasLimit -= absenceProofAccessGas
        if (gasLimit < BIGINT_0) {
          if (this.DEBUG) {
            debugGas(
              `Proof of absence access charged(${absenceProofAccessGas}) caused OOG (-> ${gasLimit})`,
            )
          }
          message.accessWitness?.revert()
          return { execResult: OOGResult(message.gasLimit) }
        } else {
          if (this.DEBUG) {
            debugGas(`Proof of absence access used (${absenceProofAccessGas} gas (-> ${gasLimit}))`)
          }
          message.accessWitness?.commit()
        }
      }
      toAccount = new Account()
    }
    // Add tx value to the `to` account
    if (!message.delegatecall) {
      try {
        await this._addToBalance(toAccount, message)
        await this._addToTokenBalance(toAccount, message)
      } catch (e: any) {
        errorMessage = e
      }
    }

    // EIP-7928: Add codeAddress to BAL for DELEGATECALL/CALLCODE
    // For these opcodes, `to` is the current contract but `codeAddress` is the target
    // whose code is being executed. The target MUST be included in the BAL.
    if (
      this.common.isActivatedEIP(7928) &&
      message.codeAddress !== undefined &&
      message.codeAddress.toString() !== message.to.toString()
    ) {
      this.blockLevelAccessList!.addAddress(message.codeAddress.toString())
    }

    // Load code
    await this._loadCode(message)
    let exit = false
    if (!message.code || (typeof message.code !== 'function' && message.code.length === 0)) {
      exit = true
      if (this.DEBUG) {
        debug(`Exit early on no code (CALL)`)
      }
    }
    if (errorMessage !== undefined) {
      exit = true
      if (this.DEBUG) {
        debug(`Exit early on value transfer overflowed (CALL)`)
      }
    }

    // EIP-7708: Create ETH transfer log for non-zero value transfers to a different account.
    // CALLCODE always executes in the caller's context (to == caller), so it is a self-transfer.
    // Self-transfers (caller == to) and DELEGATECALL do not emit a log.
    let eip7708Log: Log | undefined
    const isTransferToDifferentAccount = !equalsBytes(message.caller.bytes, message.to.bytes)
    if (
      this.common.isActivatedEIP(7708) &&
      !message.delegatecall &&
      message.value > BIGINT_0 &&
      isTransferToDifferentAccount &&
      errorMessage === undefined
    ) {
      eip7708Log = createEIP7708TransferLog(message.caller, message.to, message.value)
      if (this.DEBUG) {
        debug(
          `EIP-7708: Created ETH transfer log from ${message.caller} to ${message.to} value=${message.value}`,
        )
      }
    }

    if (exit) {
      // Even on early exit, we may need to return the EIP-7708 log if value was transferred
      return {
        execResult: {
          gasRefund: message.gasRefund,
          executionGasUsed: message.gasLimit - gasLimit,
          exceptionError: errorMessage, // Only defined if addToBalance failed
          returnValue: new Uint8Array(0),
          logs: eip7708Log ? [eip7708Log] : undefined,
        },
      }
    }

    let result: ExecResult
    if (message.isCompiled) {
      let timer: Timer
      let callTimer: Timer | undefined
      let target: string
      if (this._optsCached.profiler?.enabled === true) {
        // Using deprecated bytesToUnprefixedHex for performance: used for profiler string formatting.
        target = bytesToUnprefixedHex(message.codeAddress.bytes)
        // TODO: map target precompile not to address, but to a name
        target = getPrecompileName(target) ?? target.slice(20)
        if (this.performanceLogger.hasTimer()) {
          callTimer = this.performanceLogger.pauseTimer()
        }
        timer = this.performanceLogger.startTimer(target)
      }
      result = await this.runPrecompile(message.code as PrecompileFunc, message.data, gasLimit)

      if (eip7708Log !== undefined) {
        result.logs = result.logs !== undefined ? [eip7708Log, ...result.logs] : [eip7708Log]
      }

      if (this._optsCached.profiler?.enabled === true) {
        this.performanceLogger.stopTimer(timer!, Number(result.executionGasUsed), 'precompiles')
        if (callTimer !== undefined) {
          this.performanceLogger.unpauseTimer(callTimer)
        }
      }
      result.gasRefund = message.gasRefund
    } else {
      if (this.DEBUG) {
        debug(`Start bytecode processing...`)
      }
      result = await this.runInterpreter(
        {
          ...{ codeAddress: message.codeAddress },
          ...message,
          gasLimit,
        } as Message,
        { initialLogs: eip7708Log ? [eip7708Log] : undefined },
      )
    }

    if (message.depth === 0) {
      this.postMessageCleanup()
    }

    result.executionGasUsed += message.gasLimit - gasLimit

    return {
      execResult: result,
    }
  }

  protected async _executeCreate(message: Message): Promise<TVMResult> {
    if (this.common.isActivatedEIP(6780) && message.createdAddresses === undefined) {
      throw EthereumJSErrorWithoutCode(
        'createdAddresses must be initialized when EIP-6780 is active',
      )
    }

    let gasLimit = message.gasLimit
    const fromAddress = message.caller

    if (this.common.isActivatedEIP(6800) || this.common.isActivatedEIP(7864)) {
      if (message.depth === 0) {
        const originAccessGas = message.accessWitness!.readAccountHeader(fromAddress)
        debugGas(`originAccessGas=${originAccessGas} waived off for origin at depth=0`)
      }
    }

    let account = await this.stateManager.getAccount(message.caller)
    if (!account) {
      account = new Account()
    }
    // Reduce tx value from sender
    await this._reduceSenderBalance(account, message)
    await this._reduceSenderTokenBalance(account, message)

    if (this.common.isActivatedEIP(3860) && !this.common.isTron()) {
      if (
        message.data.length > Number(this.common.param('maxInitCodeSize')) &&
        !this.allowUnlimitedInitCodeSize
      ) {
        return {
          createdAddress: message.to,
          execResult: {
            returnValue: new Uint8Array(0),
            exceptionError: new TVMError(TVMError.errorMessages.INITCODE_SIZE_VIOLATION),
            executionGasUsed: message.gasLimit,
          },
        }
      }
    }

    // TODO at some point, figure out why we swapped out data to code in the first place
    message.code = message.data
    message.data = message.eofCallData ?? new Uint8Array()
    message.to = await this._generateAddress(message)

    if (this.common.isActivatedEIP(6780)) {
      message.createdAddresses!.add(message.to.toString())
    }

    if (this.DEBUG) {
      debug(`Generated CREATE contract address ${message.to}`)
    }
    let toAccount = await this.stateManager.getAccount(message.to)
    if (!toAccount) {
      toAccount = new Account()
    }

    if (this.common.isActivatedEIP(6800) || this.common.isActivatedEIP(7864)) {
      const contractCreateAccessGas =
        message.accessWitness!.writeAccountBasicData(message.to) +
        message.accessWitness!.readAccountCodeHash(message.to)
      gasLimit -= contractCreateAccessGas
      if (gasLimit < BIGINT_0) {
        if (this.DEBUG) {
          debugGas(
            `ContractCreateInit charge(${contractCreateAccessGas}) caused OOG (-> ${gasLimit})`,
          )
          message.accessWitness?.revert()
        }
        return { execResult: OOGResult(message.gasLimit) }
      } else {
        if (this.DEBUG) {
          debugGas(`ContractCreateInit charged (${contractCreateAccessGas} gas (-> ${gasLimit}))`)
        }
        message.accessWitness?.commit()
      }
    }

    // Check for collision
    if (
      (toAccount.nonce && toAccount.nonce > BIGINT_0) ||
      !(equalsBytes(toAccount.codeHash, KECCAK256_NULL) === true) ||
      // See EIP 7610 and the discussion `https://ethereum-magicians.org/t/eip-7610-revert-creation-in-case-of-non-empty-storage`
      !(equalsBytes(toAccount.storageRoot, KECCAK256_RLP) === true)
    ) {
      if (this.DEBUG) {
        debug(`Returning on address collision`)
      }
      if (this.common.isActivatedEIP(7928)) {
        this.blockLevelAccessList!.addAddress(message.to.toString())
      }
      // TRON: advance internal nonce even on collision, so the next CREATE uses nonce+1
      if (
        message.depth > 0 &&
        this.common.gteHardfork(Hardfork.Tron) &&
        message.tronTransactionContext !== undefined
      ) {
        message.tronTransactionContext.nonce += BIGINT_1
      }
      return {
        createdAddress: message.to,
        execResult: {
          returnValue: new Uint8Array(0),
          exceptionError: new TVMError(TVMError.errorMessages.CREATE_COLLISION),
          executionGasUsed: message.gasLimit,
        },
      }
    }

    if (
      message.depth > 0 &&
      this.common.gteHardfork(Hardfork.Tron) &&
      message.tronTransactionContext !== undefined
    ) {
      message.tronTransactionContext.nonce += BIGINT_1
    }

    await this.journal.putAccount(message.to, toAccount)
    await this.stateManager.clearStorage(message.to)

    const newContractEvent = {
      address: message.to,
      code: message.code,
    }

    await this._emit('newContract', newContractEvent)

    toAccount = await this.stateManager.getAccount(message.to)
    if (!toAccount) {
      toAccount = new Account()
    }
    // EIP-161 on account creation and CREATE execution
    if (this.common.gteHardfork(Hardfork.SpuriousDragon)) {
      toAccount.nonce += BIGINT_1
    }
    if (this.common.isActivatedEIP(7928)) {
      this.blockLevelAccessList!.addNonceChange(
        message.to.toString(),
        toAccount.nonce,
        this.blockLevelAccessList!.blockAccessIndex,
      )
    }
    // Add tx value to the `to` account
    let errorMessage
    try {
      await this._addToBalance(toAccount, message as MessageWithTo)
      await this._addToTokenBalance(toAccount, message as MessageWithTo)
    } catch (e: any) {
      errorMessage = e
    }

    let exit = false
    if (
      message.code === undefined ||
      (typeof message.code !== 'function' && message.code.length === 0)
    ) {
      exit = true
      if (this.DEBUG) {
        debug(`Exit early on no code (CREATE)`)
      }
    }
    if (errorMessage !== undefined) {
      exit = true
      if (this.DEBUG) {
        debug(`Exit early on value transfer overflowed (CREATE)`)
      }
    }

    // EIP-7708: Create ETH transfer log for contract creation with value
    let eip7708CreateLog: Log | undefined
    if (
      this.common.isActivatedEIP(7708) &&
      message.value > BIGINT_0 &&
      message.to !== undefined &&
      !equalsBytes(message.caller.bytes, message.to.bytes) &&
      errorMessage === undefined
    ) {
      eip7708CreateLog = createEIP7708TransferLog(message.caller, message.to, message.value)
      if (this.DEBUG) {
        debug(
          `EIP-7708: Created ETH transfer log for CREATE from ${message.caller} to ${message.to} value=${message.value}`,
        )
      }
    }

    if (exit) {
      if (this.common.isActivatedEIP(6800) || this.common.isActivatedEIP(7864)) {
        const createCompleteAccessGas = message.accessWitness!.writeAccountHeader(message.to)
        gasLimit -= createCompleteAccessGas
        if (gasLimit < BIGINT_0) {
          if (this.DEBUG) {
            debug(
              `ContractCreateComplete access gas (${createCompleteAccessGas}) caused OOG (-> ${gasLimit})`,
            )
          }
          message.accessWitness?.revert()
          return { execResult: OOGResult(message.gasLimit) }
        } else {
          if (this.DEBUG) {
            debug(
              `ContractCreateComplete access used (${createCompleteAccessGas}) gas (-> ${gasLimit})`,
            )
          }
          message.accessWitness?.commit()
        }
      }

      return {
        createdAddress: message.to,
        execResult: {
          executionGasUsed: message.gasLimit - gasLimit,
          gasRefund: message.gasRefund,
          exceptionError: errorMessage, // only defined if addToBalance failed
          returnValue: new Uint8Array(0),
          logs: eip7708CreateLog ? [eip7708CreateLog] : undefined,
        },
      }
    }

    if (this.DEBUG) {
      debug(`Start bytecode processing...`)
    }

    // run the message with the updated gas limit and add accessed gas used to the result
    let result = await this.runInterpreter({ ...message, gasLimit, isCreate: true } as Message, {
      initialLogs: eip7708CreateLog ? [eip7708CreateLog] : undefined,
    })
    result.executionGasUsed += message.gasLimit - gasLimit

    // fee for size of the return value
    let totalGas = result.executionGasUsed
    let returnFee = BIGINT_0
    if (!result.exceptionError && !this.common.isActivatedEIP(6800)) {
      returnFee = BigInt(result.returnValue.length) * BigInt(this.common.param('createDataGas'))
      totalGas = totalGas + returnFee
      if (this.DEBUG) {
        debugGas(`Add return value size fee (${returnFee} to gas used (-> ${totalGas}))`)
      }
    }

    // Check for SpuriousDragon EIP-170 code size limit
    let allowedCodeSize = true
    if (
      !result.exceptionError &&
      !this.common.isTron() &&
      this.common.gteHardfork(Hardfork.SpuriousDragon) &&
      result.returnValue.length > Number(this.common.param('maxCodeSize'))
    ) {
      allowedCodeSize = false
    }

    // If enough gas and allowed code size
    let CodestoreOOG = false
    if (totalGas <= message.gasLimit && (this.allowUnlimitedContractSize || allowedCodeSize)) {
      if (this.common.isActivatedEIP(3541) && result.returnValue[0] === FORMAT) {
        if (!this.common.isActivatedEIP(3540)) {
          result = { ...result, ...INVALID_BYTECODE_RESULT(message.gasLimit) }
        } else if (
          // TODO check if this is correct
          // Also likely cleanup this eofCallData stuff
          /*(message.depth > 0 && message.eofCallData === undefined) ||
          (message.depth === 0 && !isEOF(message.code))*/
          !isEOF(message.code)
        ) {
          // TODO the message.eof was flagged for this to work for this first
          // Running into Legacy mode: unable to deploy EOF contract
          result = { ...result, ...INVALID_BYTECODE_RESULT(message.gasLimit) }
        } else {
          // 3541 is active and current runtime mode is EOF
          result.executionGasUsed = totalGas
        }
      } else {
        result.executionGasUsed = totalGas
      }
    } else {
      if (this.common.gteHardfork(Hardfork.Homestead)) {
        if (!allowedCodeSize) {
          if (this.DEBUG) {
            debug(`Code size exceeds maximum code size (>= SpuriousDragon)`)
          }
          result = { ...result, ...CodesizeExceedsMaximumError(message.gasLimit) }
        } else {
          if (this.DEBUG) {
            debug(`Contract creation: out of gas`)
          }
          message.accessWitness?.revert()
          result = { ...result, ...OOGResult(message.gasLimit) }
        }
      } else {
        // we are in Frontier
        if (totalGas - returnFee <= message.gasLimit) {
          // we cannot pay the code deposit fee (but the deposit code actually did run)
          if (this.DEBUG) {
            debug(`Not enough gas to pay the code deposit fee (Frontier)`)
          }
          message.accessWitness?.revert()
          result = { ...result, ...COOGResult(totalGas - returnFee) }
          CodestoreOOG = true
        } else {
          if (this.DEBUG) {
            debug(`Contract creation: out of gas`)
          }
          message.accessWitness?.revert()
          result = { ...result, ...OOGResult(message.gasLimit) }
        }
      }
    }

    // get the fresh gas limit for the rest of the ops
    gasLimit = message.gasLimit - result.executionGasUsed
    if (
      !result.exceptionError &&
      (this.common.isActivatedEIP(6800) || this.common.isActivatedEIP(7864))
    ) {
      const createCompleteAccessGas = message.accessWitness!.writeAccountHeader(message.to)
      gasLimit -= createCompleteAccessGas
      if (gasLimit < BIGINT_0) {
        if (this.DEBUG) {
          debug(
            `ContractCreateComplete access gas (${createCompleteAccessGas}) caused OOG (-> ${gasLimit})`,
          )
        }
        message.accessWitness?.revert()
        result = { ...result, ...OOGResult(message.gasLimit) }
      } else {
        debug(
          `ContractCreateComplete access used (${createCompleteAccessGas}) gas (-> ${gasLimit})`,
        )
        result.executionGasUsed += createCompleteAccessGas
      }
    }

    // Save code if a new contract was created
    if (
      !result.exceptionError &&
      result.returnValue !== undefined &&
      result.returnValue.length !== 0
    ) {
      // Add access charges for writing this code to the state
      if (this.common.isActivatedEIP(6800) || this.common.isActivatedEIP(7864)) {
        const byteCodeWriteAccessfee = message.accessWitness!.writeAccountCodeChunks(
          message.to,
          0,
          result.returnValue.length - 1,
        )
        gasLimit -= byteCodeWriteAccessfee
        if (gasLimit < BIGINT_0) {
          if (this.DEBUG) {
            debug(
              `byteCodeWrite access gas (${byteCodeWriteAccessfee}) caused OOG (-> ${gasLimit})`,
            )
          }
          message.accessWitness?.revert()
          result = { ...result, ...OOGResult(message.gasLimit) }
        } else {
          debug(`byteCodeWrite access used (${byteCodeWriteAccessfee}) gas (-> ${gasLimit})`)
          message.accessWitness?.commit()
          result.executionGasUsed += byteCodeWriteAccessfee
        }
      }

      await this.stateManager.putCode(message.to, result.returnValue)

      if (this.common.isActivatedEIP(7928)) {
        this.blockLevelAccessList!.addCodeChange(
          message.to.toString(),
          result.returnValue,
          this.blockLevelAccessList!.blockAccessIndex,
        )
      }

      if (this.DEBUG) {
        debug(`Code saved on new contract creation`)
      }
    } else if (CodestoreOOG) {
      // This only happens at Frontier. But, let's do a sanity check;
      if (!this.common.gteHardfork(Hardfork.Homestead)) {
        // Pre-Homestead behavior; put an empty contract.
        // This contract would be considered "DEAD" in later hard forks.
        // It is thus an unnecessary default item, which we have to save to disk
        // It does change the state root, but it only wastes storage.
        const account = await this.stateManager.getAccount(message.to)
        await this.journal.putAccount(message.to, account ?? new Account())
      }
    }

    if (message.depth === 0) {
      this.postMessageCleanup()
    }

    return {
      createdAddress: message.to,
      execResult: result,
    }
  }

  /**
   * Starts the actual bytecode processing for a CALL or CREATE
   */
  protected async runInterpreter(
    message: Message,
    opts: InterpreterOpts = {},
  ): Promise<ExecResult> {
    if (this.common.isActivatedEIP(6780)) {
      message.createdAddresses ??= new Set()
    }

    let contract = await this.stateManager.getAccount(message.to ?? createZeroAddress())
    if (!contract) {
      contract = new Account()
    }

    const env = {
      address: message.to ?? createZeroAddress(),
      caller: message.caller ?? createZeroAddress(),
      callData: message.data ?? Uint8Array.from([0]),
      callValue: message.value ?? BIGINT_0,
      callTokenId: message.tokenId ?? BIGINT_0,
      callTokenValue: message.tokenValue ?? BIGINT_0,
      code: message.code as Uint8Array,
      isStatic: message.isStatic ?? false,
      isCreate: message.isCreate ?? false,
      depth: message.depth ?? 0,
      gasPrice: this._tx!.gasPrice,
      origin: this._tx!.origin ?? message.caller ?? createZeroAddress(),
      block: this._block ?? defaultBlock(),
      contract,
      codeAddress: message.codeAddress,
      gasRefund: message.gasRefund,
      chargeCodeAccesses: message.chargeCodeAccesses,
      blobVersionedHashes: message.blobVersionedHashes ?? [],
      accessWitness: message.accessWitness,
      createdAddresses: message.createdAddresses,
      initialLogs: opts.initialLogs,
      tronTransactionContext: message.tronTransactionContext,
    }

    const interpreter = new Interpreter(
      this,
      (nestedMessage) => this._runCallFromInterpreter(nestedMessage),
      this.stateManager,
      this.blockchain,
      env,
      message.gasLimit,
      this.journal,
      this.performanceLogger,
      this._optsCached.profiler,
    )
    if (message.selfdestruct) {
      interpreter._result.selfdestruct = message.selfdestruct
    }
    if (message.createdAddresses) {
      interpreter._result.createdAddresses = message.createdAddresses
    }

    const interpreterRes = await interpreter.run(message.code as Uint8Array, opts)

    let result = interpreter._result
    let gasUsed = message.gasLimit - interpreterRes.runState!.gasLeft
    if (interpreterRes.exceptionError) {
      if (
        interpreterRes.exceptionError.error !== TVMError.errorMessages.REVERT &&
        interpreterRes.exceptionError.error !== TVMError.errorMessages.INVALID_EOF_FORMAT
      ) {
        gasUsed = message.gasLimit
      }

      // Clear the result on error
      result = {
        ...result,
        logs: [],
        selfdestruct: new Map(),
        createdAddresses: new Set(),
      }
    }

    message.accessWitness?.commit()
    return {
      ...result,
      runState: {
        ...interpreterRes.runState!,
        ...result,
        ...interpreter._env,
      },
      exceptionError: interpreterRes.exceptionError,
      gas: interpreterRes.runState?.gasLeft,
      executionGasUsed: gasUsed,
      gasRefund: interpreterRes.runState!.gasRefund,
      returnValue: result.returnValue ?? new Uint8Array(0),
    }
  }

  /**
   * Executes an TVM message, determining whether it's a call or create
   * based on the `to` address. It checkpoints the state and reverts changes
   * if an exception happens during the message execution.
   *
   * When `opts.message` is supplied with `depth === 0`, the message is treated as a new top-level
   * transaction and is mutated in place: `selfdestruct`, `createdAddresses`, `gasRefund`, and
   * `tronTransactionContext` are reset so state from a previous run cannot leak into this one.
   * To seed those transaction-level values, pass `opts.selfdestruct`, `opts.createdAddresses`,
   * `opts.gasRefund`, and `opts.rootTransactionId` instead of pre-setting them on the message.
   *
   * `opts.skipBalance` applies to messages built by this method at any depth. When `opts.message`
   * is supplied it is only honored for top-level (`depth === 0`) messages.
   *
   * A TVM instance does not support concurrent standalone execution invocations because execution
   * context and journals are shared. Recursive calls made by the interpreter use a private entry
   * point; every overlapping public invocation is rejected regardless of its supplied depth.
   */
  async runCall(opts: TVMRunCallOpts): Promise<TVMResult> {
    const messageDepth = opts.message?.depth ?? opts.depth ?? 0
    this._acquireExecutionLock()
    try {
      return await this._runCall(opts, true, messageDepth)
    } catch (error) {
      if (this._optsCached.profiler?.enabled === true) {
        this.performanceLogger.cancelTimer()
      }
      throw error
    } finally {
      this._activeExecutions--
    }
  }

  private _acquireExecutionLock(): void {
    if (this._activeExecutions > 0) {
      throw EthereumJSErrorWithoutCode(
        'Concurrent public TVM execution invocations on the same TVM instance are not supported',
      )
    }
    this._activeExecutions++
  }

  private async _runCallFromInterpreter(message: Message): Promise<TVMResult> {
    return this._runCall({ message }, false, message.depth)
  }

  private async _runCall(
    opts: TVMRunCallOpts,
    isStandaloneCall: boolean,
    messageDepth: number,
  ): Promise<TVMResult> {
    // The effective depth must be resolved the same way here and at the stop site below, otherwise
    // the profiler starts a timer it never stops (or stops one it never started).
    const isTopLevelCall = messageDepth === 0
    const profilerEnabled = this._optsCached.profiler?.enabled === true
    let timer: Timer | undefined
    if (isTopLevelCall && profilerEnabled) {
      timer = this.performanceLogger.startTimer('Initialization')
    }
    let message = opts.message
    let callerAccount
    if (isStandaloneCall || isTopLevelCall) {
      const caller = message?.caller ?? opts.caller ?? createZeroAddress()
      this._block = opts.block ?? defaultBlock()
      this._tx = {
        gasPrice: opts.gasPrice ?? BIGINT_0,
        origin: opts.origin ?? caller,
      }
    }
    if (message !== undefined && isTopLevelCall) {
      message.selfdestruct = opts.selfdestruct ?? new Map()
      message.createdAddresses = opts.createdAddresses ?? new Set()
      message.gasRefund = opts.gasRefund ?? BIGINT_0
      message.tronTransactionContext =
        opts.rootTransactionId === undefined
          ? undefined
          : createTronTransactionContext(opts.rootTransactionId)
    }
    if (!message) {
      const caller = opts.caller ?? createZeroAddress()

      const value = opts.value ?? BIGINT_0
      message = new Message({
        caller,
        gasLimit: opts.gasLimit ?? BigInt(0xffffff),
        to: opts.to,
        value,
        tokenId: opts.tokenId,
        tokenValue: opts.tokenValue,
        data: opts.data,
        code: opts.code,
        depth: opts.depth,
        isCompiled: opts.isCompiled,
        isStatic: opts.isStatic,
        salt: opts.salt,
        selfdestruct: opts.selfdestruct ?? new Map(),
        createdAddresses: opts.createdAddresses ?? new Set(),
        delegatecall: opts.delegatecall,
        blobVersionedHashes: opts.blobVersionedHashes,
        tronTransactionContext:
          opts.rootTransactionId === undefined
            ? undefined
            : createTronTransactionContext(opts.rootTransactionId),
      })
    } else if (
      message.depth > 0 &&
      opts.rootTransactionId !== undefined &&
      message.tronTransactionContext === undefined
    ) {
      message.tronTransactionContext = createTronTransactionContext(opts.rootTransactionId)
    }
    if (
      isStandaloneCall &&
      this.common.isActivatedEIP(6780) &&
      message.createdAddresses === undefined
    ) {
      message.createdAddresses = opts.createdAddresses ?? new Set()
    }

    // Validate transaction-level TRON deployment context before skipBalance or the top-level nonce
    // can write the caller account. Internal CREATE is validated later inside its own checkpoint.
    if (
      message.depth === 0 &&
      message.to === undefined &&
      message.salt === undefined &&
      this.common.gteHardfork(Hardfork.Tron) &&
      message.tronTransactionContext === undefined
    ) {
      throw EthereumJSErrorWithoutCode(
        'rootTransactionId is required for TRON contract deployment address derivation',
      )
    }

    type CheckpointState = {
      journal: boolean
      transientStorage: boolean
      blockLevelAccessList: boolean
    }

    const outerCheckpoint: CheckpointState = {
      journal: false,
      transientStorage: false,
      blockLevelAccessList: false,
    }
    const executionCheckpoint: CheckpointState = {
      journal: false,
      transientStorage: false,
      blockLevelAccessList: false,
    }

    const checkpoint = async (state: CheckpointState) => {
      if (this.common.isActivatedEIP(7928)) {
        this.blockLevelAccessList?.checkpoint()
        state.blockLevelAccessList = true
      }
      await this.journal.checkpoint()
      state.journal = true
      if (this.common.isActivatedEIP(1153)) {
        this.transientStorage.checkpoint()
        state.transientStorage = true
      }
    }

    const commit = async (state: CheckpointState) => {
      if (state.journal) {
        await this.journal.commit()
        state.journal = false
      }
      if (state.transientStorage) {
        this.transientStorage.commit()
        state.transientStorage = false
      }
      if (state.blockLevelAccessList) {
        this.blockLevelAccessList?.commit()
        state.blockLevelAccessList = false
      }
    }

    const revert = async (state: CheckpointState, preserveBlockAccessReads: boolean = true) => {
      let revertError: unknown

      if (state.journal) {
        try {
          await this.journal.revert()
          state.journal = false
        } catch (error) {
          revertError = error
        }
      }
      if (state.transientStorage) {
        try {
          this.transientStorage.revert()
          state.transientStorage = false
        } catch (error) {
          revertError ??= error
        }
      }
      if (state.blockLevelAccessList) {
        try {
          const blockLevelAccessList = this.blockLevelAccessList as
            | (BlockLevelAccessList & { revert(preserveReads?: boolean): void })
            | undefined
          blockLevelAccessList?.revert(preserveBlockAccessReads)
          state.blockLevelAccessList = false
        } catch (error) {
          revertError ??= error
        }
      }

      if (revertError !== undefined) {
        throw revertError
      }
    }

    const isCheckpointActive = (state: CheckpointState) =>
      state.journal || state.transientStorage || state.blockLevelAccessList

    const revertForCleanup = async (
      state: CheckpointState,
      preserveBlockAccessReads: boolean,
    ): Promise<unknown> => {
      try {
        await revert(state, preserveBlockAccessReads)
        return undefined
      } catch (firstError) {
        if (!isCheckpointActive(state)) {
          return firstError
        }
        // Journal operations retain their bookkeeping when the StateManager rejects, so a
        // transient backend failure can be retried without pairing against the wrong checkpoint.
        try {
          await revert(state, preserveBlockAccessReads)
          return undefined
        } catch (retryError) {
          return retryError
        }
      }
    }

    let result: TVMResult
    try {
      // The outer checkpoint owns initialization and execution so a thrown event listener cannot
      // leave balance, nonce, access-list, or contract changes behind.
      await checkpoint(outerCheckpoint)
      if (this.DEBUG) {
        debug('-'.repeat(100))
        debug(`outer message checkpoint`)
      }

      // `skipBalance` is a caller-facing convenience for funding the sender, so it stays available to
      // messages this method builds itself (any depth, as before). For a caller-supplied `Message` it
      // is limited to top-level calls so it cannot relax balance checks for nested execution.
      if (opts.skipBalance === true && (opts.message === undefined || message.depth === 0)) {
        callerAccount = await this.stateManager.getAccount(message.caller)
        if (!callerAccount) {
          callerAccount = new Account()
        }
        const originalBalance = callerAccount.balance
        if (callerAccount.balance < message.value) {
          // Set the caller balance to `value` to ensure sufficient funds.
          callerAccount.balance = message.value
          await this.journal.putAccount(message.caller, callerAccount)
          if (this.common.isActivatedEIP(7928)) {
            this.blockLevelAccessList!.addBalanceChange(
              message.caller.toString(),
              callerAccount.balance,
              this.blockLevelAccessList!.blockAccessIndex,
              originalBalance,
            )
          }
        }
      }

      if (message.depth === 0) {
        if (!callerAccount) {
          callerAccount = await this.stateManager.getAccount(message.caller)
        }
        if (!callerAccount) {
          callerAccount = new Account()
        }
        callerAccount.nonce++
        await this.journal.putAccount(message.caller, callerAccount)
        if (this.common.isActivatedEIP(7928)) {
          this.blockLevelAccessList!.addNonceChange(
            message.caller.toString(),
            callerAccount.nonce,
            this.blockLevelAccessList!.blockAccessIndex,
          )
        }
        if (this.DEBUG) {
          debug(`Update fromAccount (caller) nonce (-> ${callerAccount.nonce}))`)
        }
      }

      await this._emit('beforeMessage', message)

      if (!message.to && this.common.isActivatedEIP(2929)) {
        message.code = message.data
        this.journal.addWarmedAddress((await this._generateAddress(message)).bytes)
      }

      // A nested execution checkpoint preserves the existing semantics for VM-level failures: the
      // call/create changes are reverted while the top-level nonce remains in the outer checkpoint.
      await checkpoint(executionCheckpoint)
      if (this.DEBUG) {
        debug('-'.repeat(100))
        debug(`execution checkpoint`)
        const { caller, gasLimit, to, value, delegatecall } = message
        debug(
          `New message caller=${caller} gasLimit=${gasLimit} to=${
            to?.toString() ?? 'none'
          } value=${value} delegatecall=${delegatecall ? 'yes' : 'no'}`,
        )
      }

      if (message.to) {
        if (this.DEBUG) {
          debug(`Message CALL execution (to: ${message.to})`)
        }
        result = await this._executeCall(message as MessageWithTo)
      } else {
        if (this.DEBUG) {
          debug(`Message CREATE execution (to: undefined)`)
        }
        result = await this._executeCreate(message)
      }

      if (this.DEBUG) {
        const { executionGasUsed, exceptionError, returnValue } = result.execResult
        debug(
          `Received message execResult: [ gasUsed=${executionGasUsed} exceptionError=${
            exceptionError ? `'${exceptionError.error}'` : 'none'
          } returnValue=${short(returnValue)} gasRefund=${result.execResult.gasRefund ?? 0} ]`,
        )
      }
      const err = result.execResult.exceptionError
      // This clause captures any error which happened during execution
      // If that is the case, then all refunds are forfeited
      // There is one exception: if the CODESTORE_OUT_OF_GAS error is thrown
      // (this only happens the Frontier/Chainstart fork)
      // then the error is dismissed
      if (err && err.error !== TVMError.errorMessages.CODESTORE_OUT_OF_GAS) {
        result.execResult.selfdestruct = new Map()
        result.execResult.createdAddresses = new Set()
        result.execResult.gasRefund = BIGINT_0
      }
      if (
        err &&
        !(
          this.common.hardfork() === Hardfork.Chainstart &&
          err.error === TVMError.errorMessages.CODESTORE_OUT_OF_GAS
        )
      ) {
        result.execResult.logs = []
        await revert(executionCheckpoint)
        if (this.DEBUG) {
          debug(`execution checkpoint reverted`)
        }
      } else {
        await commit(executionCheckpoint)
        if (this.DEBUG) {
          debug(`execution checkpoint committed`)
        }
      }

      // Event hooks remain inside the outer checkpoint. If one throws, every state mutation made by
      // this public call, including initialization and a successfully committed execution, reverts.
      await this._emit('afterMessage', result)
      await commit(outerCheckpoint)
      if (this.DEBUG) {
        debug(`outer message checkpoint committed`)
      }
    } catch (error) {
      let revertError = await revertForCleanup(executionCheckpoint, true)
      const executionCheckpointActive = isCheckpointActive(executionCheckpoint)
      // Reverting an outer layer while an inner layer is still active would pair it with the wrong
      // StateManager checkpoint. Preserve the aligned stack and surface the inner revert failure.
      if (!executionCheckpointActive) {
        // A host-level exception rejects the entire public invocation, so restore the exact BAL
        // snapshot instead of preserving reads as an ordinary EVM frame revert would.
        const outerError = await revertForCleanup(outerCheckpoint, false)
        revertError ??= outerError
      }

      // An interpreter or precompile timer can be active here instead of the outer call timer.
      // Only the standalone invocation owns the full profiling session.
      if (isStandaloneCall && profilerEnabled) {
        this.performanceLogger.cancelTimer()
      }
      if (revertError !== undefined) {
        throw revertError
      }
      throw error
    }

    // Mirror the start condition exactly: only stop a timer this invocation actually started.
    if (timer !== undefined) {
      this.performanceLogger.stopTimer(timer, 0)
    }

    message.accessWitness?.commit()
    return result
  }

  /**
   * Bound to the global VM and therefore
   * shouldn't be used directly from the tvm class.
   *
   * `runCode()` shares transaction and block context with `runCall()`; do not overlap either method
   * on the same TVM instance. Interpreter-driven recursive calls use a private entry point and are
   * not subject to this public execution lock.
   */
  async runCode(opts: TVMRunCodeOpts): Promise<ExecResult> {
    this._acquireExecutionLock()
    try {
      this._block = opts.block ?? defaultBlock()

      this._tx = {
        gasPrice: opts.gasPrice ?? BIGINT_0,
        origin: opts.origin ?? opts.caller ?? createZeroAddress(),
      }

      const message = new Message({
        code: opts.code,
        data: opts.data,
        gasLimit: opts.gasLimit ?? BigInt(0xffffff),
        to: opts.to ?? createZeroAddress(),
        caller: opts.caller,
        value: opts.value,
        tokenId: opts.tokenId,
        tokenValue: opts.tokenValue,
        depth: opts.depth,
        selfdestruct: opts.selfdestruct ?? new Map(),
        createdAddresses: opts.createdAddresses,
        isStatic: opts.isStatic,
        blobVersionedHashes: opts.blobVersionedHashes,
        tronTransactionContext:
          opts.rootTransactionId === undefined
            ? undefined
            : createTronTransactionContext(opts.rootTransactionId),
      })

      return await this.runInterpreter(message, { pc: opts.pc })
    } finally {
      this._activeExecutions--
    }
  }

  /**
   * Returns the precompile function registered at the given address,
   * or `undefined` if no precompile is active there.
   *
   * Accepts either an `Address` instance or a `0x`-prefixed hex string.
   *
   * ```ts
   * const tvm = await createTVM({
   *   customPrecompiles: [{ address: '0x000000000000000000000000000000000000ff01', function: myFn }],
   * })
   * const fn = tvm.getPrecompile('0x000000000000000000000000000000000000ff01')
   * ```
   */
  getPrecompile(address: Address | PrefixedHexString): PrecompileFunc | undefined {
    if (typeof address === 'string') {
      return this.precompiles.get(address.slice(2).padStart(40, '0').toLowerCase())
    }
    return this.precompiles.get(bytesToUnprefixedHex(address.bytes))
  }

  /**
   * Executes a precompiled contract with given data and gas limit.
   */
  protected runPrecompile(
    code: PrecompileFunc,
    data: Uint8Array,
    gasLimit: bigint,
  ): Promise<ExecResult> | ExecResult {
    if (typeof code !== 'function') {
      throw EthereumJSErrorWithoutCode('Invalid precompile')
    }

    const opts = {
      data,
      gasLimit,
      common: this.common,
      _TVM: this,
      _debug: this.DEBUG ? debugPrecompiles : undefined,
      stateManager: this.stateManager,
    }

    return code(opts)
  }

  protected async _loadCode(message: Message): Promise<void> {
    if (!message.code) {
      const precompile = this.getPrecompile(message.codeAddress)
      if (precompile) {
        message.code = precompile
        message.isCompiled = true
      } else {
        message.code = await this.stateManager.getCode(message.codeAddress)

        // EIP-7702 delegation check
        if (
          this.common.isActivatedEIP(7702) &&
          equalsBytes(message.code.slice(0, 3), DELEGATION_7702_FLAG)
        ) {
          const address = new Address(message.code.slice(3, 24))
          message.code = await this.stateManager.getCode(address)
          // EIP-7928: Track delegation target access in BAL
          if (this.common.isActivatedEIP(7928)) {
            this.blockLevelAccessList?.addAddress(address.toString())
          }
          if (message.depth === 0) {
            this.journal.addAlwaysWarmAddress(address.toString())
          }
        }

        message.isCompiled = false
        message.chargeCodeAccesses = true
      }
    }
  }

  protected async _generateAddress(message: Message): Promise<Address> {
    let addr
    if (message.salt) {
      const generateCreate2Address = this.common.gteHardfork(Hardfork.Tron)
        ? generateTronAddress2
        : generateAddress2
      addr = generateCreate2Address(message.caller.bytes, message.salt, message.code as Uint8Array)
    } else if (this.common.gteHardfork(Hardfork.Tron)) {
      const context = message.tronTransactionContext
      if (context === undefined) {
        throw EthereumJSErrorWithoutCode(
          `rootTransactionId is required for TRON ${
            message.depth === 0 ? 'contract deployment' : 'internal CREATE'
          } address derivation`,
        )
      }
      addr =
        message.depth === 0
          ? generateTronContractAddress(context.rootTransactionId, message.caller.bytes)
          : generateTronCreateAddress(context.rootTransactionId, context.nonce)
    } else {
      let acc = await this.stateManager.getAccount(message.caller)
      if (!acc) {
        acc = new Account()
      }
      const newNonce = acc.nonce - BIGINT_1
      addr = generateAddress(message.caller.bytes, bigIntToBytes(newNonce))
    }
    return new Address(addr)
  }

  protected async _reduceSenderBalance(account: Account, message: Message): Promise<void> {
    const originalBalance = account.balance
    account.balance -= message.value
    if (account.balance < BIGINT_0) {
      throw new TVMError(TVMError.errorMessages.INSUFFICIENT_BALANCE)
    }
    // EIP-7928: Record the sender's reduced balance in BAL
    // Per spec, CALL/CALLCODE senders must have their balance recorded
    if (this.common.isActivatedEIP(7928)) {
      this.blockLevelAccessList!.addBalanceChange(
        message.caller.toString(),
        account.balance,
        this.blockLevelAccessList!.blockAccessIndex,
        originalBalance,
      )
    }
    const result = this.journal.putAccount(message.caller, account)
    if (this.DEBUG) {
      debug(`Reduced sender (${message.caller}) balance (-> ${account.balance})`)
    }
    return result
  }

  _getTokenBalance(account: Account, tokenId: bigint): bigint {
    if (account.asset) {
      return account.asset[Number(tokenId)] || BIGINT_0
    }

    return BIGINT_0
  }

  protected async _reduceSenderTokenBalance(account: Account, message: Message): Promise<void> {
    const newBalance = this._getTokenBalance(account, message.tokenId) - message.tokenValue
    if (newBalance < BIGINT_0) {
      throw new TVMError(TVMError.errorMessages.INSUFFICIENT_TOKEN_BALANCE)
    }
    if (account.asset && message.tokenId !== BIGINT_0) {
      account.asset[Number(message.tokenId)] = newBalance
    }
    const result = this.journal.putAccount(message.caller, account)
    debug(
      `Reduced sender (${message.caller.toString()}) tokenId (-> ${message.tokenId.toString()}) tokenValue (-> ${newBalance.toString()})`,
    )
    return result
  }

  protected async _addToBalance(toAccount: Account, message: MessageWithTo): Promise<void> {
    const originalBalance = toAccount.balance
    const newBalance = toAccount.balance + message.value
    if (newBalance > MAX_INTEGER) {
      throw new TVMError(TVMError.errorMessages.VALUE_OVERFLOW)
    }
    toAccount.balance = newBalance
    if (this.common.isActivatedEIP(7928)) {
      this.blockLevelAccessList!.addAddress(message.to.toString())
      if (message.value !== BIGINT_0) {
        this.blockLevelAccessList!.addBalanceChange(
          message.to.toString(),
          newBalance,
          this.blockLevelAccessList!.blockAccessIndex,
          originalBalance,
        )
      }
    }
    // putAccount as the nonce may have changed for contract creation
    await this.journal.putAccount(message.to, toAccount)
    if (this.DEBUG) {
      debug(`Added toAccount (${message.to}) balance (-> ${toAccount.balance})`)
    }
  }

  protected async _addToTokenBalance(toAccount: Account, message: MessageWithTo): Promise<void> {
    const newBalance = this._getTokenBalance(toAccount, message.tokenId) + message.tokenValue
    if (newBalance > MAX_INTEGER) {
      throw new TVMError(TVMError.errorMessages.VALUE_OVERFLOW)
    }
    if (toAccount.asset && message.tokenId !== BIGINT_0) {
      toAccount.asset[Number(message.tokenId)] = newBalance
    }
    // putAccount as the nonce may have changed for contract creation
    await this.journal.putAccount(message.to, toAccount)
    debug(
      `Added toAccount (${message.to.toString()}) tokenId (-> ${message.tokenId.toString()}) tokenValue (-> ${newBalance.toString()})`,
    )
  }

  /**
   * Once the interpreter has finished depth 0, a post-message cleanup should be done
   */
  private postMessageCleanup() {
    if (this.common.isActivatedEIP(1153)) this.transientStorage.clear()
  }

  /**
   * This method copies the TVM, current HF and EIP settings
   * and returns a new TVM instance.
   *
   * Note: this is only a shallow copy and both TVM instances
   * will point to the same underlying state DB.
   *
   * @returns TVM
   */
  public shallowCopy(): TVM {
    const common = this.common.copy()
    common.setHardfork(this.common.hardfork())

    const opts = {
      ...this._optsCached,
      common,
      stateManager: this.stateManager.shallowCopy(),
    }
    // @ts-expect-error -- Assigning a StateManager property that is absent from the interface
    opts.stateManager['common'] = common
    return new TVM(opts)
  }

  public getPerformanceLogs() {
    return this.performanceLogger.getLogs()
  }

  public clearPerformanceLogs() {
    this.performanceLogger.clear()
  }
}
