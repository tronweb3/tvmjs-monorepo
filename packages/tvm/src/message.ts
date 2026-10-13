import {
  BIGINT_0,
  EthereumJSErrorWithoutCode,
  MAX_INT64,
  MIN_TOKEN_ID,
  createZeroAddress,
} from '@tvmjs/util'

import type { BinaryTreeAccessWitnessInterface } from '@tvmjs/common'
import type { Address, PrefixedHexString } from '@tvmjs/util'
import type { PrecompileFunc } from './precompiles/index.ts'
import type { Block, EOFEnv, SelfdestructMap } from './types.ts'

const defaults = {
  value: BIGINT_0,
  tokenId: BIGINT_0,
  tokenValue: BIGINT_0,
  caller: createZeroAddress(),
  data: new Uint8Array(0),
  depth: 0,
  isStatic: false,
  isCompiled: false,
  delegatecall: false,
  callcode: false,
  gasRefund: BIGINT_0,
}

interface MessageOpts {
  to?: Address
  value?: bigint
  tokenId?: bigint
  tokenValue?: bigint
  caller?: Address
  gasLimit: bigint
  data?: Uint8Array
  eofCallData?: Uint8Array
  depth?: number
  code?: Uint8Array | PrecompileFunc
  codeAddress?: Address
  isStatic?: boolean
  isCompiled?: boolean
  salt?: Uint8Array
  /**
   * Selfdestructed addresses mapped to their beneficiary, see {@link Message.selfdestruct}
   */
  selfdestruct?: SelfdestructMap
  /**
   * Map of addresses which were created (used in EIP 6780)
   */
  createdAddresses?: Set<PrefixedHexString>
  delegatecall?: boolean
  callcode?: boolean
  gasRefund?: bigint
  accessWitness?: BinaryTreeAccessWitnessInterface
  tronTransactionContext?: TronTransactionContext
}

/**
 * Mutable transaction-wide TRON execution state shared by all nested messages.
 */
export interface TronTransactionContext {
  readonly rootTransactionId: Uint8Array
  nonce: bigint
}

export function createTronTransactionContext(
  rootTransactionId: Uint8Array,
): TronTransactionContext {
  if (!(rootTransactionId instanceof Uint8Array)) {
    throw EthereumJSErrorWithoutCode(
      `This method only supports Uint8Array but input was: ${rootTransactionId}`,
    )
  }
  if (rootTransactionId.length !== 32) {
    throw EthereumJSErrorWithoutCode('Expected rootTransactionId to be of length 32')
  }
  return {
    rootTransactionId: Uint8Array.from(rootTransactionId),
    nonce: BIGINT_0,
  }
}

export class Message {
  to?: Address
  value: bigint
  tokenId: bigint
  tokenValue: bigint
  caller: Address
  gasLimit: bigint
  data: Uint8Array
  eofCallData?: Uint8Array // Only used in EOFCreate to signal an EOF contract to be created with this calldata (via EOFCreate)
  isCreate?: boolean
  depth: number
  code?: Uint8Array | PrecompileFunc
  _codeAddress?: Address
  isStatic: boolean
  isCompiled: boolean
  salt?: Uint8Array
  eof?: EOFEnv
  chargeCodeAccesses?: boolean
  /**
   * Selfdestructed addresses mapped to their beneficiary.
   */
  selfdestruct?: SelfdestructMap
  /**
   * Map of addresses which were created (used in EIP 6780)
   */
  createdAddresses?: Set<PrefixedHexString>
  delegatecall: boolean
  callcode: boolean
  gasRefund: bigint // Keeps track of the gasRefund at the start of the frame (used for journaling purposes)
  accessWitness?: BinaryTreeAccessWitnessInterface
  tronTransactionContext?: TronTransactionContext

  constructor(opts: MessageOpts) {
    rejectRemovedExecutionOptions(opts)
    this.to = opts.to
    this.value = opts.value ?? defaults.value
    this.tokenId = opts.tokenId ?? defaults.tokenId
    this.tokenValue = opts.tokenValue ?? defaults.tokenValue
    this.caller = opts.caller ?? defaults.caller
    this.gasLimit = opts.gasLimit
    this.data = opts.data ?? defaults.data
    this.eofCallData = opts.eofCallData
    this.depth = opts.depth ?? defaults.depth
    this.code = opts.code
    this._codeAddress = opts.codeAddress
    this.isStatic = opts.isStatic ?? defaults.isStatic
    this.isCompiled = opts.isCompiled ?? defaults.isCompiled
    this.salt = opts.salt
    this.selfdestruct = opts.selfdestruct
    this.createdAddresses = opts.createdAddresses
    this.delegatecall = opts.delegatecall ?? defaults.delegatecall
    this.callcode = opts.callcode ?? defaults.callcode
    this.gasRefund = opts.gasRefund ?? defaults.gasRefund
    this.accessWitness = opts.accessWitness
    this.tronTransactionContext = opts.tronTransactionContext
    if (this.tokenId !== BIGINT_0 && this.tokenId <= MIN_TOKEN_ID) {
      throw EthereumJSErrorWithoutCode(
        `tokenId field cannot be less than ${MIN_TOKEN_ID}, received ${this.tokenId}`,
      )
    }
    if (this.tokenId === BIGINT_0 && this.tokenValue > BIGINT_0) {
      throw EthereumJSErrorWithoutCode(
        `tokenValue field must be zero when tokenId is zero, received ${this.tokenValue}`,
      )
    }
    if (this.tokenValue < BIGINT_0) {
      throw EthereumJSErrorWithoutCode(
        `tokenValue field cannot be negative, received ${this.tokenValue}`,
      )
    }
    if (this.tokenId > MAX_INT64) {
      throw EthereumJSErrorWithoutCode(
        `tokenId field must fit in a signed 64-bit integer, received ${this.tokenId}`,
      )
    }
    if (this.tokenValue > MAX_INT64) {
      throw EthereumJSErrorWithoutCode(
        `tokenValue field must fit in a signed 64-bit integer, received ${this.tokenValue}`,
      )
    }
    if (this.value < BIGINT_0) {
      throw EthereumJSErrorWithoutCode(`value field cannot be negative, received ${this.value}`)
    }
  }

  /**
   * Note: should only be called in instances where `_codeAddress` or `to` is defined.
   */
  get codeAddress(): Address {
    const codeAddress = this._codeAddress ?? this.to
    if (!codeAddress) {
      throw EthereumJSErrorWithoutCode('Missing codeAddress')
    }
    return codeAddress
  }
}

export type MessageWithTo = Message & Pick<Required<MessageOpts>, 'to'>

/** Reject removed execution context fields, including explicitly empty inputs. */
export function rejectRemovedExecutionOptions(opts: object) {
  if ('blobVersionedHashes' in opts) {
    throw EthereumJSErrorWithoutCode('blobVersionedHashes is no longer supported')
  }
  const header = 'block' in opts ? (opts.block as Block | undefined)?.header : undefined
  if (header) {
    for (const field of ['blobGasUsed', 'excessBlobGas', 'getBlobGasPrice']) {
      if (field in header) {
        throw EthereumJSErrorWithoutCode(`Blob block context field ${field} is no longer supported`)
      }
    }
    for (const field of ['parentBeaconBlockRoot', 'parent_beacon_block_root']) {
      if (field in header) {
        throw EthereumJSErrorWithoutCode(
          `Beacon root block context field ${field} is no longer supported`,
        )
      }
    }
  }
}
