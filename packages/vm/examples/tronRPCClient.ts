import { keccak_256 } from '@noble/hashes/sha3.js'
import { createCurrentTronMainnetCommon, createTronChainIdCommon } from '@tvmjs/common'
import { RPCStateManager } from '@tvmjs/statemanager'
import { createTVM } from '@tvmjs/tvm'
import {
  Address,
  EthereumJSErrorWithoutCode,
  bytesToHex,
  createAccount,
  createZeroAddress,
  equalsBytes,
  fromTronBase58Address,
  fromTronHexAddress,
  hexToBytes,
  setLengthLeft,
  toTronHexAddress,
} from '@tvmjs/util'

import type { Common, TronNetwork } from '@tvmjs/common'
import type { TVMResult, TVMRunCallOpts } from '@tvmjs/tvm'
import type { PrefixedHexString } from '@tvmjs/util'

// cspell:ignore getaccount getcontractinfo getnowblock runtimecode triggerconstantcontract walletsolidity

type Fetch = typeof globalThis.fetch
type StateTag = bigint | 'latest'
type ExecutionBlock = NonNullable<TVMRunCallOpts['block']>

type RPCBlock = {
  number: PrefixedHexString
  timestamp: PrefixedHexString
  gasLimit: PrefixedHexString
  difficulty?: PrefixedHexString
  miner?: PrefixedHexString
  mixHash?: PrefixedHexString
  baseFeePerGas?: PrefixedHexString
  transactions?: Array<PrefixedHexString | { hash?: PrefixedHexString }>
}

export type RPCTransaction = {
  hash: PrefixedHexString
  blockHash?: PrefixedHexString | null
  blockNumber?: PrefixedHexString | null
  from?: PrefixedHexString
  to?: PrefixedHexString | null
  input?: PrefixedHexString
  value?: PrefixedHexString
  [key: string]: unknown
}

export type WalletAccount = {
  address?: string
  balance?: number | string
  type?: string
  assetV2?: Array<{ key: string; value: number | string }>
  active_permission?: unknown[]
}

type ContractInfo = {
  runtimecode?: string
  bytecode?: string
  smart_contract?: { bytecode?: string }
}

type TriggerConstantResponse = {
  result?: { result?: boolean; message?: string }
  constant_result?: string[]
  energy_used?: number
}

export interface TronRPCClientOpts {
  jsonRpcUrl: string
  walletUrl: string
  apiKey?: string
  walletApiPrefix?: 'wallet' | 'walletsolidity'
  fetch?: Fetch
}

export interface TronRPCPocOpts extends TronRPCClientOpts {
  network?: TronNetwork
  common?: Common
  caller: string
  contract: string
  calldata: PrefixedHexString
  gasLimit?: bigint
  stableBlockAttempts?: number
  stateTag?: StateTag
  transactionId?: PrefixedHexString
}

export interface TronRPCPocResult {
  blockNumber: bigint
  localBlockNumber: bigint
  blockStable: boolean
  localReturnValue: PrefixedHexString
  remoteReturnValue: PrefixedHexString
  returnValueMatches: boolean
  localEnergyUsed: bigint
  remoteEnergyUsed?: number
  energyMatches: boolean | undefined
  walletAccount: WalletAccount
  walletRuntimeCodeMatches: boolean | undefined
  rpcTransaction?: RPCTransaction
}

function ensureHttpUrl(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw EthereumJSErrorWithoutCode(`${name} must be a valid HTTP URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw EthereumJSErrorWithoutCode(`${name} must use http or https`)
  }
  return value.replace(/\/$/, '')
}

function normalizeDataHex(value: string): PrefixedHexString {
  const normalized = value.startsWith('0x') ? value : `0x${value}`
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(normalized)) {
    throw EthereumJSErrorWithoutCode(`Invalid hex data: ${value}`)
  }
  return normalized.toLowerCase() as PrefixedHexString
}

function parseQuantity(value: string | number | undefined, name: string): bigint {
  if (value === undefined || value === '') {
    throw EthereumJSErrorWithoutCode(`Missing ${name}`)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw EthereumJSErrorWithoutCode(`${name} exceeds JavaScript's safe integer range`)
    }
    return BigInt(value)
  }
  return BigInt(value)
}

export function parseTronRPCAddress(value: string): Address {
  if (value.startsWith('T')) {
    return new Address(fromTronBase58Address(value))
  }
  const unprefixed = value.startsWith('0x') ? value.slice(2) : value
  if (/^41[0-9a-fA-F]{40}$/.test(unprefixed)) {
    return new Address(fromTronHexAddress(`0x${unprefixed}`))
  }
  if (/^[0-9a-fA-F]{40}$/.test(unprefixed)) {
    return new Address(hexToBytes(`0x${unprefixed}`))
  }
  throw EthereumJSErrorWithoutCode(`Invalid TRON address: ${value}`)
}

function toWalletAddress(address: Address): string {
  return toTronHexAddress(address.bytes).slice(2)
}

export class TronRPCPocClient {
  readonly jsonRpcUrl: string
  readonly walletUrl: string
  readonly walletApiPrefix: 'wallet' | 'walletsolidity'
  private readonly apiKey?: string
  private readonly fetch: Fetch

  constructor(opts: TronRPCClientOpts) {
    this.jsonRpcUrl = ensureHttpUrl(opts.jsonRpcUrl, 'jsonRpcUrl')
    this.walletUrl = ensureHttpUrl(opts.walletUrl, 'walletUrl')
    this.walletApiPrefix = opts.walletApiPrefix ?? 'wallet'
    this.apiKey = opts.apiKey
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey === undefined ? {} : { 'TRON-PRO-API-KEY': this.apiKey }),
    }
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const response = await this.fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    const responseText = await response.text()
    if (!response.ok) {
      throw EthereumJSErrorWithoutCode(`RPC request failed (${response.status}): ${responseText}`)
    }
    try {
      return JSON.parse(responseText) as T
    } catch {
      throw EthereumJSErrorWithoutCode(`RPC returned invalid JSON: ${responseText}`)
    }
  }

  async jsonRpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.post<{
      result?: T
      error?: { code?: number; message?: string }
    }>(this.jsonRpcUrl, { jsonrpc: '2.0', id: 1, method, params })
    if (response.error !== undefined) {
      throw EthereumJSErrorWithoutCode(
        `JSON-RPC ${method} failed: ${response.error.message ?? response.error.code ?? 'unknown error'}`,
      )
    }
    if (response.result === undefined || response.result === null) {
      throw EthereumJSErrorWithoutCode(`JSON-RPC ${method} returned no result`)
    }
    return response.result
  }

  async wallet<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.post<T>(`${this.walletUrl}/${this.walletApiPrefix}/${method}`, body)
  }

  async getReferenceBlockNumber(): Promise<bigint> {
    const block = await this.wallet<{
      block_header?: { raw_data?: { number?: number | string } }
    }>('getnowblock')
    return parseQuantity(block.block_header?.raw_data?.number, 'reference block number')
  }

  async getWalletAccount(address: Address): Promise<WalletAccount> {
    return this.wallet<WalletAccount>('getaccount', {
      address: toWalletAddress(address),
      visible: false,
    })
  }

  async getContractInfo(address: Address): Promise<ContractInfo> {
    return this.wallet<ContractInfo>('getcontractinfo', {
      value: toWalletAddress(address),
      visible: false,
    })
  }

  private stateTag(tag: StateTag): string {
    return tag === 'latest' ? tag : `0x${tag.toString(16)}`
  }

  async getBalance(address: Address, stateTag: StateTag): Promise<bigint> {
    const result = await this.jsonRpc<PrefixedHexString>('eth_getBalance', [
      address.toString(),
      this.stateTag(stateTag),
    ])
    return BigInt(result)
  }

  async getCode(address: Address, stateTag: StateTag): Promise<Uint8Array> {
    const result = await this.jsonRpc<PrefixedHexString>('eth_getCode', [
      address.toString(),
      this.stateTag(stateTag),
    ])
    return hexToBytes(normalizeDataHex(result))
  }

  async getStorage(address: Address, key: Uint8Array, stateTag: StateTag): Promise<Uint8Array> {
    const result = await this.jsonRpc<PrefixedHexString>('eth_getStorageAt', [
      address.toString(),
      bytesToHex(key),
      this.stateTag(stateTag),
    ])
    return hexToBytes(normalizeDataHex(result))
  }

  async getBlock(stateTag: StateTag): Promise<RPCBlock> {
    return this.jsonRpc<RPCBlock>('eth_getBlockByNumber', [this.stateTag(stateTag), false])
  }

  async getTransaction(transactionId: PrefixedHexString): Promise<RPCTransaction> {
    return this.jsonRpc<RPCTransaction>('eth_getTransactionByHash', [transactionId])
  }

  async triggerConstantContract(
    caller: Address,
    contract: Address,
    calldata: Uint8Array,
  ): Promise<{ returnValue: Uint8Array; energyUsed?: number }> {
    const response = await this.wallet<TriggerConstantResponse>('triggerconstantcontract', {
      owner_address: toWalletAddress(caller),
      contract_address: toWalletAddress(contract),
      data: bytesToHex(calldata).slice(2),
      visible: false,
    })
    if (response.result?.result !== true) {
      throw EthereumJSErrorWithoutCode(
        `triggerconstantcontract failed: ${response.result?.message ?? 'unknown error'}`,
      )
    }
    const returnValue = response.constant_result?.[0]
    if (returnValue === undefined) {
      throw EthereumJSErrorWithoutCode('triggerconstantcontract returned no constant_result')
    }
    return {
      returnValue: hexToBytes(normalizeDataHex(returnValue)),
      energyUsed: response.energy_used,
    }
  }
}

class TronRPCStateManager extends RPCStateManager {
  private readonly client: TronRPCPocClient
  private readonly stateTag: StateTag
  private readonly referenceBlockNumber: bigint

  constructor(
    client: TronRPCPocClient,
    stateTag: StateTag,
    referenceBlockNumber: bigint,
    common: Common,
  ) {
    super({ provider: client.jsonRpcUrl, blockTag: referenceBlockNumber, common })
    this.client = client
    this.stateTag = stateTag
    this.referenceBlockNumber = referenceBlockNumber
  }

  override async getAccountFromProvider(address: Address) {
    const [balance, code] = await Promise.all([
      this.client.getBalance(address, this.stateTag),
      this.client.getCode(address, this.stateTag),
    ])
    return createAccount({
      nonce: 0n,
      balance,
      codeHash: code.length === 0 ? undefined : keccak_256(code),
    })
  }

  override async getCode(address: Address): Promise<Uint8Array> {
    const cached = this._caches.code?.get(address)?.code
    if (cached !== undefined) return cached
    const code = await this.client.getCode(address, this.stateTag)
    this._caches.code?.put(address, code)
    return code
  }

  override async getStorage(address: Address, key: Uint8Array): Promise<Uint8Array> {
    if (key.length !== 32) {
      throw EthereumJSErrorWithoutCode('Storage key must be 32 bytes long')
    }
    const cached = this._caches.storage?.get(address, key)
    if (cached !== undefined) return cached
    const value = await this.client.getStorage(address, key, this.stateTag)
    await this.putStorage(address, key, value)
    return value
  }

  override shallowCopy(): TronRPCStateManager {
    return new TronRPCStateManager(
      this.client,
      this.stateTag,
      this.referenceBlockNumber,
      this.common.copy(),
    )
  }
}

function executionBlock(block: RPCBlock): ExecutionBlock {
  return {
    header: {
      number: parseQuantity(block.number, 'block number'),
      timestamp: parseQuantity(block.timestamp, 'block timestamp'),
      gasLimit: parseQuantity(block.gasLimit, 'block gas limit'),
      difficulty: block.difficulty === undefined ? 0n : BigInt(block.difficulty),
      coinbase: block.miner === undefined ? createZeroAddress() : parseTronRPCAddress(block.miner),
      prevRandao:
        block.mixHash === undefined
          ? new Uint8Array(32)
          : setLengthLeft(hexToBytes(block.mixHash), 32),
      baseFeePerGas: block.baseFeePerGas === undefined ? undefined : BigInt(block.baseFeePerGas),
    },
  }
}

async function captureConstantResult(
  client: TronRPCPocClient,
  caller: Address,
  contract: Address,
  calldata: Uint8Array,
  attempts: number,
) {
  let last:
    | {
        blockNumber: bigint
        blockStable: boolean
        returnValue: Uint8Array
        energyUsed?: number
      }
    | undefined

  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = await client.getReferenceBlockNumber()
    const remote = await client.triggerConstantContract(caller, contract, calldata)
    const after = await client.getReferenceBlockNumber()
    last = { blockNumber: before, blockStable: before === after, ...remote }
    if (last.blockStable) return last
  }
  return last!
}

function selectedTransactionId(
  explicit: PrefixedHexString | undefined,
  transactions: RPCBlock['transactions'],
): PrefixedHexString | undefined {
  if (explicit !== undefined) return normalizeDataHex(explicit)
  const first = transactions?.[0]
  if (typeof first === 'string') return normalizeDataHex(first)
  return first?.hash === undefined ? undefined : normalizeDataHex(first.hash)
}

function executionCommon(opts: TronRPCPocOpts): Common {
  if (opts.common !== undefined) return opts.common.copy()
  return (opts.network ?? 'mainnet') === 'mainnet'
    ? createCurrentTronMainnetCommon()
    : createTronChainIdCommon(opts.network!)
}

export async function runTronRPCPoc(opts: TronRPCPocOpts): Promise<TronRPCPocResult> {
  const stableBlockAttempts = opts.stableBlockAttempts ?? 3
  if (!Number.isInteger(stableBlockAttempts) || stableBlockAttempts < 1) {
    throw EthereumJSErrorWithoutCode('stableBlockAttempts must be a positive integer')
  }

  const client = new TronRPCPocClient(opts)
  const caller = parseTronRPCAddress(opts.caller)
  const contract = parseTronRPCAddress(opts.contract)
  const calldata = hexToBytes(normalizeDataHex(opts.calldata))
  const remote = await captureConstantResult(
    client,
    caller,
    contract,
    calldata,
    stableBlockAttempts,
  )
  const common = executionCommon(opts)
  const stateTag = opts.stateTag ?? 'latest'
  const stateManager = new TronRPCStateManager(client, stateTag, remote.blockNumber, common)
  const [blockData, walletAccount, contractInfo, rpcCode] = await Promise.all([
    client.getBlock(stateTag),
    client.getWalletAccount(caller),
    client.getContractInfo(contract),
    client.getCode(contract, stateTag),
  ])
  const transactionId = selectedTransactionId(opts.transactionId, blockData.transactions)
  const rpcTransaction =
    transactionId === undefined ? undefined : await client.getTransaction(transactionId)
  const localBlockNumber = parseQuantity(blockData.number, 'local block number')
  const tvm = await createTVM({ common, stateManager })

  await stateManager.checkpoint()
  let local: TVMResult
  try {
    local = await tvm.runCall({
      block: executionBlock(blockData),
      caller,
      origin: caller,
      to: contract,
      data: calldata,
      gasLimit: opts.gasLimit ?? 15_000_000n,
      skipBalance: true,
    })
  } finally {
    await stateManager.revert()
  }

  if (local.execResult.exceptionError !== undefined) {
    throw EthereumJSErrorWithoutCode(
      `Local TVM execution failed: ${local.execResult.exceptionError.error}`,
    )
  }
  const walletRuntimeCode = contractInfo.runtimecode
  const afterLocalExecution = await client.getReferenceBlockNumber()
  return {
    blockNumber: remote.blockNumber,
    localBlockNumber,
    blockStable:
      remote.blockStable &&
      localBlockNumber === remote.blockNumber &&
      afterLocalExecution === remote.blockNumber,
    localReturnValue: bytesToHex(local.execResult.returnValue),
    remoteReturnValue: bytesToHex(remote.returnValue),
    returnValueMatches: equalsBytes(local.execResult.returnValue, remote.returnValue),
    localEnergyUsed: local.execResult.executionGasUsed,
    remoteEnergyUsed: remote.energyUsed,
    energyMatches:
      remote.energyUsed === undefined
        ? undefined
        : local.execResult.executionGasUsed === BigInt(remote.energyUsed),
    walletAccount,
    walletRuntimeCodeMatches:
      walletRuntimeCode === undefined
        ? undefined
        : equalsBytes(hexToBytes(normalizeDataHex(walletRuntimeCode)), rpcCode),
    rpcTransaction,
  }
}
