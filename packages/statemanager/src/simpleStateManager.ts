import { keccak_256 } from '@noble/hashes/sha3.js'
import { Account, EthereumJSErrorWithoutCode, bytesToHex, tokenIdFromKey } from '@tvmjs/util'

import { OriginalStorageCache } from './cache/originalStorageCache.ts'
import { modifyAccountFields } from './util.ts'

import type { AccountFields, Common, StateManagerInterface } from '@tvmjs/common'
import type { Address, PrefixedHexString } from '@tvmjs/util'
import type { SimpleStateManagerOpts } from './index.ts'

function copyAccount(account: Account | undefined): Account | undefined {
  if (account === undefined) return undefined
  // Sharing the mutable TRC-10 balance map across checkpoints leaks transfers
  // through REVERT and OOG, even when the Account instances themselves are copied.
  return Object.assign(Object.create(Object.getPrototypeOf(account)), account, {
    _asset: account._asset === null ? null : { ...account._asset },
  })
}

/**
 * Simple and dependency-free state manager for basic state access use cases
 * where a merkle-patricia or binary tree backed state manager is too heavy-weight.
 *
 * This state manager comes with the basic state access logic for
 * accounts, storage and code (put* and get* methods) as well as a simple
 * implementation of checkpointing but lacks methods implementations of
 * state root related logic as well as some other non-core functions.
 *
 * Functionality provided is sufficient to be used for simple TVM use
 * cases and the state manager is used as default there.
 *
 * For a more full fledged and MPT-backed state manager implementation
 * have a look at the [`@tvmjs/statemanager` package docs](https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/statemanager/docs/README.md).
 */
export class SimpleStateManager implements StateManagerInterface {
  public accountStack: Map<PrefixedHexString, Account | undefined>[] = []
  public codeStack: Map<PrefixedHexString, Uint8Array>[] = []
  public storageStack: Map<string, Uint8Array>[] = []
  private tokenIdStack: Set<bigint>[] = []

  originalStorageCache: {
    get(address: Address, key: Uint8Array): Promise<Uint8Array>
    clear(): void
  }

  public readonly common?: Common

  constructor(opts: SimpleStateManagerOpts = {}) {
    this.checkpointSync()
    this.originalStorageCache = new OriginalStorageCache(this.getStorage.bind(this))
    this.common = opts.common
  }

  protected topAccountStack() {
    return this.accountStack[this.accountStack.length - 1]
  }
  protected topCodeStack() {
    return this.codeStack[this.codeStack.length - 1]
  }
  protected topStorageStack() {
    return this.storageStack[this.storageStack.length - 1]
  }

  // Synchronous version of checkpoint() to allow to call from constructor
  protected checkpointSync() {
    const newTopA = new Map(this.topAccountStack())
    for (const [address, account] of newTopA) {
      newTopA.set(address, copyAccount(account))
    }
    this.accountStack.push(newTopA)
    this.codeStack.push(new Map(this.topCodeStack()))
    this.storageStack.push(new Map(this.topStorageStack()))
    this.tokenIdStack.push(new Set(this.tokenIdStack[this.tokenIdStack.length - 1]))
  }

  async getAccount(address: Address): Promise<Account | undefined> {
    return this.topAccountStack().get(address.toString())
  }

  async putAccount(address: Address, account?: Account | undefined): Promise<void> {
    const tokenIds = account === undefined ? [] : Object.keys(account.asset).map(tokenIdFromKey)
    this.topAccountStack().set(address.toString(), account)
    // Account assets seed the local registry. A known token remains registered
    // when its balance is spent or its holder is deleted, unless the write reverts.
    const registry = this.tokenIdStack[this.tokenIdStack.length - 1]
    for (const tokenId of tokenIds) registry.add(tokenId)
  }

  async deleteAccount(address: Address): Promise<void> {
    this.topAccountStack().set(address.toString(), undefined)
  }

  async modifyAccountFields(address: Address, accountFields: AccountFields): Promise<void> {
    await modifyAccountFields(this, address, accountFields)
  }

  async getCode(address: Address): Promise<Uint8Array> {
    return this.topCodeStack().get(address.toString()) ?? new Uint8Array(0)
  }

  async putCode(address: Address, value: Uint8Array): Promise<void> {
    this.topCodeStack().set(address.toString(), value)
    if ((await this.getAccount(address)) === undefined) {
      await this.putAccount(address, new Account())
    }
    await this.modifyAccountFields(address, {
      codeHash: (this.common?.customCrypto.keccak256 ?? keccak_256)(value),
    })
  }

  async getCodeSize(address: Address): Promise<number> {
    const contractCode = await this.getCode(address)
    return contractCode.length
  }

  async getStorage(address: Address, key: Uint8Array): Promise<Uint8Array> {
    return (
      this.topStorageStack().get(`${address.toString()}_${bytesToHex(key)}`) ?? new Uint8Array(0)
    )
  }

  async putStorage(address: Address, key: Uint8Array, value: Uint8Array): Promise<void> {
    this.topStorageStack().set(`${address.toString()}_${bytesToHex(key)}`, value)
  }

  async clearStorage(): Promise<void> {}

  async checkpoint(): Promise<void> {
    this.checkpointSync()
  }
  async commit(): Promise<void> {
    this.accountStack.splice(-2, 1)
    this.codeStack.splice(-2, 1)
    this.storageStack.splice(-2, 1)
    this.tokenIdStack.splice(-2, 1)
  }

  async revert(): Promise<void> {
    this.accountStack.pop()
    this.codeStack.pop()
    this.storageStack.pop()
    this.tokenIdStack.pop()
  }

  async flush(): Promise<void> {}
  clearCaches(): void {}

  shallowCopy(): StateManagerInterface {
    const copy = new SimpleStateManager({ common: this.common })
    copy.accountStack = this.accountStack.map(
      (accounts) =>
        new Map([...accounts].map(([address, account]) => [address, copyAccount(account)])),
    )
    copy.codeStack = this.codeStack.map((code) => new Map(code))
    copy.storageStack = this.storageStack.map((storage) => new Map(storage))
    copy.tokenIdStack = this.tokenIdStack.map((tokenIds) => new Set(tokenIds))
    return copy
  }

  // State root functionality not implemented
  getStateRoot(): Promise<Uint8Array> {
    throw EthereumJSErrorWithoutCode('Method not implemented.')
  }
  setStateRoot(): Promise<void> {
    throw EthereumJSErrorWithoutCode('Method not implemented.')
  }
  hasStateRoot(): Promise<boolean> {
    throw EthereumJSErrorWithoutCode('Method not implemented.')
  }

  /** Checks IDs registered by local account writes, with the same snapshot as account state. */
  async tokenIdExists(tokenId: bigint): Promise<boolean> {
    return this.tokenIdStack[this.tokenIdStack.length - 1].has(tokenId)
  }
}
