import type {
  BinaryTreeAccessWitnessInterface,
  Common,
  ParamsDict,
  StateManagerInterface,
} from '@tvmjs/common'
import type { Account, Address, BlockLevelAccessList, PrefixedHexString } from '@tvmjs/util'
import type { EventEmitter } from 'eventemitter3'
import type { BinaryTreeAccessWitness } from './binaryTreeAccessWitness.ts'
import type { EOFContainer } from './eof/container.ts'
import type { TVMError } from './errors.ts'
import type { InterpreterStep, RunState } from './interpreter.ts'
import type { Message } from './message.ts'
import type { AsyncDynamicGasHandler, SyncDynamicGasHandler } from './opcodes/gas.ts'
import type { OpHandler } from './opcodes/index.ts'
import type { CustomPrecompile } from './precompiles/index.ts'
import type { PrecompileFunc } from './precompiles/types.ts'

export type DeleteOpcode = {
  opcode: number
}

export type AddOpcode = {
  opcode: number
  opcodeName: string
  baseFee: number
  gasFunction?: AsyncDynamicGasHandler | SyncDynamicGasHandler
  logicFunction: OpHandler
}

export type SelfdestructMap = Map<PrefixedHexString, PrefixedHexString>

export type CustomOpcode = AddOpcode | DeleteOpcode

// Typeguard
export function isAddOpcode(customOpcode: CustomOpcode): customOpcode is AddOpcode {
  return (
    'opcode' in customOpcode &&
    'opcodeName' in customOpcode &&
    'baseFee' in customOpcode &&
    'logicFunction' in customOpcode
  )
}

/**
 * Base options for the `TVM.runCode()` / `TVM.runCall()` method.
 */
interface TVMRunOpts {
  /**
   * The `block` the `tx` belongs to. If omitted a default blank block will be used.
   */
  block?: Block
  /**
   * The gas price for the call. Defaults to `0`
   */
  gasPrice?: bigint
  /**
   * The address where the call originated from. Defaults to the zero address.
   */
  origin?: Address
  /**
   * The address that ran this code (`msg.sender`). Defaults to the zero address.
   */
  caller?: Address
  /**
   * The TVM code to run.
   */
  code?: Uint8Array
  /**
   * The input data.
   */
  data?: Uint8Array
  /**
   * The gas limit for the call. Defaults to `16777215` (`0xffffff`)
   */
  gasLimit?: bigint
  /**
   * The value in ether that is being sent to `opts.address`. Defaults to `0`
   */
  value?: bigint

  // TRON add token related code
  tokenId?: bigint
  tokenValue?: bigint
  /**
   * The call depth. Defaults to `0`
   */
  depth?: number
  /**
   * If the call should be executed statically. Defaults to false.
   */
  isStatic?: boolean
  /**
   * Selfdestructed addresses mapped to their beneficiary. Defaults to the empty map.
   */
  selfdestruct?: SelfdestructMap
  /**
   * The address of the account that is executing this code (`address(this)`). Defaults to the zero address.
   */
  to?: Address
  /**
   * The 32-byte root transaction ID used by java-tron to derive top-level
   * deployment and internal CREATE addresses. Required for TRON contract creation.
   */
  rootTransactionId?: Uint8Array
}

export interface TVMRunCodeOpts extends TVMRunOpts {
  /*
   * The initial program counter. Defaults to `0`
   */
  pc?: number
  /**
   * Created addresses in the current context. Defaults to an empty set when EIP-6780 is active.
   */
  createdAddresses?: Set<PrefixedHexString>
}

/**
 * Options for running a call (or create) operation with `TVM.runCall()`
 */
export interface TVMRunCallOpts extends TVMRunOpts {
  /**
   * If the code location is a precompile.
   */
  isCompiled?: boolean
  /**
   * An optional salt to pass to CREATE2.
   */
  salt?: Uint8Array
  /**
   * Created addresses in the current context. Used by EIP-6780.
   */
  createdAddresses?: Set<PrefixedHexString>
  /**
   * Skip balance checks if true. If caller balance is less than message value,
   * sets balance to message value to ensure execution doesn't fail.
   * When `message` is also supplied, this is only honored for top-level
   * (`depth === 0`) messages.
   */
  skipBalance?: boolean
  /**
   * If the call is a DELEGATECALL. Defaults to false.
   */
  delegatecall?: boolean
  /**
   * Refund counter. Defaults to `0`
   */
  gasRefund?: bigint
  /**
   * Optionally pass in an already-built message.
   */
  message?: Message

  accessWitness?: BinaryTreeAccessWitnessInterface
}

interface NewContractEvent {
  address: Address
  // The deployment code
  code: Uint8Array
}

export type TVMEvent = {
  newContract: (data: NewContractEvent, resolve?: (result?: any) => void) => void
  beforeMessage: (data: Message, resolve?: (result?: any) => void) => void
  afterMessage: (data: TVMResult, resolve?: (result?: any) => void) => void
  step: (data: InterpreterStep, resolve?: (result?: any) => void) => void
}

export interface TVMInterface {
  common: Common
  journal: {
    commit(): Promise<void>
    revert(): Promise<void>
    checkpoint(): Promise<void>
    cleanJournal(): void
    cleanup(): Promise<void>
    putAccount(address: Address, account: Account): Promise<void>
    deleteAccount(address: Address): Promise<void>
    accessList?: Map<string, Set<string>>
    preimages?: Map<PrefixedHexString, Uint8Array>
    addAlwaysWarmAddress(address: string, addToAccessList?: boolean): void
    addAlwaysWarmSlot(address: string, slot: string, addToAccessList?: boolean): void
    startReportingAccessList(): void
    startReportingPreimages?(): void
  }
  stateManager: StateManagerInterface
  /**
   * Blockchain used by this TVM. Optional for compatibility with custom TVM implementations;
   * built-in TVM instances expose it so VM and TVM can share the same instance.
   */
  blockchain?: TVMMockBlockchainInterface
  precompiles: Map<string, PrecompileFunc>
  getPrecompile?(address: Address | PrefixedHexString): PrecompileFunc | undefined
  runCall(opts: TVMRunCallOpts): Promise<TVMResult>
  runCode(opts: TVMRunCodeOpts): Promise<ExecResult>
  events?: EventEmitter<TVMEvent>
  binaryTreeAccessWitness?: BinaryTreeAccessWitness
  systemBinaryTreeAccessWitness?: BinaryTreeAccessWitness
  blockLevelAccessList?: BlockLevelAccessList
}

export type TVMProfilerOpts = {
  enabled: boolean
  // extra options here (such as use X hardfork for gas)
}

/**
 * Options for instantiating a {@link TVM}.
 */
export interface TVMOpts {
  /**
   * Use a TRON {@link Common} instance for TVM instantiation. Defaults to TronMainnet.
   *
   * The `tronExecutionProfile` in `@tvmjs/common` defines the supported baseline
   * and optional EIP capabilities. Ethereum hardfork configurations are rejected.
   * Energy uses the `tron` parameter group; EIP-2929 cold/warm pricing,
   * EIP-3529 refunds and EIP-3651 prewarming cannot be activated.
   */
  common?: Common

  /**
   * TVM parameters sorted by EIP can be found in the exported `paramsTVM` dictionary,
   * which is internally passed to the associated `@tvmjs/common` instance which
   * manages parameter selection based on the hardfork and EIP settings.
   *
   * This option allows providing a custom set of parameters. Note that parameters
   * get fully overwritten, so you need to extend the default parameter dict
   * to provide the full parameter set.
   *
   * It is recommended to deep-clone the params object for this to avoid side effects:
   *
   * ```ts
   * const params = JSON.parse(JSON.stringify(paramsTVM))
   * params['1679']['bn254AddGas'] = 100 // 150
   * ```
   */
  params?: ParamsDict

  /**
   * Override or add custom opcodes to the TVM instruction set
   * These custom opcodes are EIP-agnostic and are always statically added
   * To delete an opcode, add an entry of format `{opcode: number}`. This will delete that opcode from the TVM.
   * If this opcode is then used in the TVM, the `INVALID` opcode would instead be used.
   * To add an opcode, add an entry of the following format:
   * {
   *    // The opcode number which will invoke the custom opcode logic
   *    opcode: number
   *    // The name of the opcode (as seen in the `step` event)
   *    opcodeName: string
   *    // The base fee of the opcode
   *    baseFee: number
   *    // If the opcode charges dynamic gas, add this here. To charge the gas, use the `i` methods of the BN, to update the charged gas
   *    gasFunction?: function(runState: RunState, gas: BN, common: Common)
   *    // The logic of the opcode which holds the logic of changing the current state
   *    logicFunction: function(runState: RunState)
   * }
   * Note: gasFunction and logicFunction can both be async or synchronous functions
   */
  customOpcodes?: CustomOpcode[]

  /*
   * Adds custom precompiles. This is hardfork-agnostic: these precompiles are always activated
   * If only an address is given, the precompile is deleted
   * If an address and a `PrecompileFunc` is given, this precompile is inserted or overridden
   * Please ensure `PrecompileFunc` has exactly one parameter `input: PrecompileInput`
   */
  customPrecompiles?: CustomPrecompile[]

  /**
   * For the EIP-2537 BLS Precompiles, the native JS `ethereum-cryptography` (`@noble/curves`)
   * https://github.com/ethereum/js-ethereum-cryptography BLS12-381 curve implementation
   * is used (see `noble.ts` file in the `precompiles/bls12_381/` folder).
   *
   * To use an alternative implementation this option can be used by passing
   * in a wrapper implementation integrating the desired library and adhering
   * to the `TVMBLSInterface` specification.
   *
   * An interface for the MCL WASM implementation https://github.com/herumi/mcl-wasm
   * is shipped with this library which can be used as follows (with `mcl-wasm` being
   * explicitly added to the set of dependencies):
   *
   * ```ts
   * import * as mcl from 'mcl-wasm'
   *
   * await mcl.init(mcl.BLS12_381)
   * const tvm = await createTVM({ bls: new MCLBLS(mcl) })
   * ```
   */
  bls?: TVMBLSInterface

  /**
   * For the EIP-196/EIP-197 BN254 (alt_BN128) EC precompiles, the native JS `ethereum-cryptography`
   * (`@noble/curves`) https://github.com/ethereum/js-ethereum-cryptography BN254 curve implementation
   * is used (see `noble.ts` file in the `precompiles/bn254/` folder).
   *
   * To use an alternative implementation this option can be used by passing
   * in a wrapper implementation integrating the desired library and adhering
   * to the `TVMBN254Interface` specification.
   *
   * An interface for a WASM wrapper https://github.com/ethereumjs/rustbn.js around the
   * Parity fork of the Zcash bn pairing cryptography library is shipped with this library
   * which can be used as follows (with `rustbn.js` being explicitly added to the set of
   * dependencies):
   *
   * ```ts
   * import { initRustBN } from 'rustbn-wasm'
   *
   * const bn254 = await initRustBN()
   * const tvm = await createTVM({ bn254: new RustBN254(bn254) })
   * ```
   */
  bn254?: TVMBN254Interface

  /*
   * The TVM comes with a basic dependency-minimized `SimpleStateManager` implementation
   * which serves most code execution use cases and which is included in the
   * `@tvmjs/statemanager` package.
   *
   * The `@tvmjs/statemanager` package also provides a variety of state manager
   * implementations for different needs (MPT-tree backed, RPC, experimental binary tree)
   * which can be used by this option as a replacement.
   */
  stateManager?: StateManagerInterface

  /**
   * The TVM comes with a basic mock blockchain interface and implementation for
   * non-block containing use cases.
   *
   * For block-containing setups use the full blockchain implementation from the
   * `@tvmjs/blockchain package.
   */
  blockchain?: TVMMockBlockchainInterface

  /**
   *
   */
  profiler?: TVMProfilerOpts

  /**
   * If EIP-7928 is activated, a block-level access list can be provided here.
   * If not provided, a new one will be created if EIP-7928 is activated
   */
  blockLevelAccessList?: BlockLevelAccessList

  /**
   * When running the TVM with PoA consensus, the `cliqueSigner` function from the `@tvmjs/block` class
   * must be provided along with a `BlockHeader` so that the coinbase can be correctly retrieved when the
   * `Interpreter.getBlockCoinbase` method is called.
   */
  cliqueSigner?: (header: Block['header']) => Address
}

/**
 * Result of executing a message via the {@link TVM}.
 */
export interface TVMResult {
  /**
   * Address of created account during transaction, if any
   */
  createdAddress?: Address
  /**
   * Contains the results from running the code, if any, as described in {@link runCode}
   */
  execResult: ExecResult
}

/**
 * Result of executing a call via the {@link TVM}.
 */
export interface ExecResult {
  runState?: RunState
  /**
   * Description of the exception, if any occurred
   */
  exceptionError?: TVMError
  /**
   * Amount of gas left
   */
  gas?: bigint
  /**
   * Amount of gas the code used to run
   */
  executionGasUsed: bigint
  /**
   * Return value from the contract
   */
  returnValue: Uint8Array
  /**
   * Array of logs that the contract emitted
   */
  logs?: Log[]
  /**
   * Selfdestructed accounts mapped to their beneficiary
   */
  selfdestruct?: SelfdestructMap
  /**
   * Map of addresses which were created (used in EIP 6780)
   */
  createdAddresses?: Set<PrefixedHexString>
  /**
   * The gas refund counter
   */
  gasRefund?: bigint
}

/**
 * High level wrapper for BLS libraries used
 * for the BLS precompiles
 */
export type TVMBLSInterface = {
  init?(): void
  addG1(input: Uint8Array): Uint8Array
  addG2(input: Uint8Array): Uint8Array
  mapFPtoG1(input: Uint8Array): Uint8Array
  mapFP2toG2(input: Uint8Array): Uint8Array
  msmG1(input: Uint8Array): Uint8Array
  msmG2(input: Uint8Array): Uint8Array
  pairingCheck(input: Uint8Array): Uint8Array
}

/**
 * High level wrapper for BN254 (alt_BN128) libraries
 * used for the BN254 (alt_BN128) EC precompiles
 */
export type TVMBN254Interface = {
  add: (input: Uint8Array) => Uint8Array
  mul: (input: Uint8Array) => Uint8Array
  pairing: (input: Uint8Array) => Uint8Array
}

/**
 * Log that the contract emits.
 */
export type Log = [address: Uint8Array, topics: Uint8Array[], data: Uint8Array]

export type Block = {
  header: {
    number: bigint
    coinbase: Address
    timestamp: bigint
    difficulty: bigint
    prevRandao: Uint8Array
    gasLimit: bigint
    baseFeePerGas?: bigint
    slotNumber?: bigint
  }
}

export interface TransientStorageInterface {
  get(addr: Address, key: Uint8Array): Uint8Array
  put(addr: Address, key: Uint8Array, value: Uint8Array): void
  commit(): void
  checkpoint(): void
  revert(): void
  toJSON(): { [address: string]: { [key: string]: string } }
  clear(): void
}

export type TVMMockBlock = {
  hash(): Uint8Array
}

export interface TVMMockBlockchainInterface {
  getBlock(blockId: number): Promise<TVMMockBlock>
  putBlock(block: TVMMockBlock): Promise<void>
  shallowCopy(): TVMMockBlockchainInterface
}

export class TVMMockBlockchain implements TVMMockBlockchainInterface {
  async getBlock(_blockId: number) {
    return {
      hash() {
        return new Uint8Array(32)
      },
    }
  }
  async putBlock(_block: TVMMockBlock) {}
  shallowCopy() {
    return this
  }
}

// EOF type which holds the execution-related data for EOF
export type EOFEnv = {
  container: EOFContainer
  eofRunState: {
    returnStack: number[]
  }
}
