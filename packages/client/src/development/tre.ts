import { setLengthLeft } from '@tvmjs/util'

import { parseBalance } from '../balance.ts'
import { blockSnapshot } from '../block.ts'
import { decodeAddress } from '../dialect/tre/decode.ts'
import { toBase58 } from '../dialect/tron/address.ts'
import { parseBytes } from '../input.ts'
import { InvalidParamsError } from '../provider.ts'

import type { NodeBlock } from '../block.ts'
import type { NodeCore } from '../core/node.ts'
import type { BytesInput, IntegerInput } from '../input.ts'

/** Local block, time and state controls. */
export interface TreApi {
  /** Mine 1–100 blocks (default 1), returning the last block. */
  mine(blocks?: number): Promise<NodeBlock>
  /** Advance time by whole seconds and mine a block. */
  increaseTime(seconds: number): Promise<NodeBlock>
  /**
   * Set the mining interval in seconds; zero drains the queue before enabling instant mining.
   * A failed drain throws BlockTimeChangeError with committed and pending transaction IDs,
   * preserving the previous interval and timer.
   */
  blockTime(seconds: number): Promise<void>
  /** Set a balance in sun and mine a block. */
  setAccountBalance(account: string, balance: IntegerInput): Promise<true>
  /** Write runtime bytecode and mine a block. Hex text accepts an optional 0x prefix. */
  setAccountCode(account: string, code: BytesInput): Promise<true>
  /** Write a storage word and mine a block. Slot and value hold at most 32 bytes. */
  setAccountStorageAt(account: string, slot: BytesInput, value: BytesInput): Promise<true>
  /** Add addresses to the unsigned-broadcast allowlist. */
  unlockedAccounts(accounts: string | string[]): Promise<true>
}

export function storageWord(value: unknown, label: string): Uint8Array {
  const bytes = parseBytes(value, label)
  if (bytes.length > 32) throw new RangeError(`${label} must hold at most 32 bytes`)
  return setLengthLeft(bytes, 32)
}

export function createTreApi(node: NodeCore): TreApi {
  return {
    mine: (blocks = 1) => node.mine(blocks).then(blockSnapshot),
    increaseTime: (seconds) => node.increaseTime(seconds).then(blockSnapshot),
    blockTime: (seconds) => node.setBlockTime(seconds),
    setAccountBalance: async (account, balance) => {
      const address = decodeAddress(account)
      const amount = parseBalance(balance, 'balance')
      return node.withWriteLock(() =>
        node.transact(async () => {
          await node.setBalance(address, amount)
          await node.mine(1)
          return true as const
        }),
      )
    },
    setAccountCode: async (account, code) => {
      const address = decodeAddress(account)
      const bytes = parseBytes(code, 'code')
      return node.withWriteLock(() =>
        node.transact(async () => {
          await node.setCode(address, bytes)
          await node.mine(1)
          return true as const
        }),
      )
    },
    setAccountStorageAt: async (account, slot, value) => {
      const address = decodeAddress(account)
      const key = storageWord(slot, 'slot')
      const bytes = storageWord(value, 'value')
      return node.withWriteLock(() =>
        node.transact(async () => {
          await node.setStorage(address, key, bytes)
          await node.mine(1)
          return true as const
        }),
      )
    },
    unlockedAccounts: (accounts) => {
      // Capture the caller's list before waiting for another operation to finish.
      const entries = Array.isArray(accounts) ? [...accounts] : accounts
      return node.withWriteLock(async () => {
        const listed =
          Array.isArray(entries) ||
          typeof entries === 'string' ||
          typeof entries === 'number' ||
          typeof entries === 'boolean'
        if (!listed) throw new InvalidParamsError('method parameters invalid')
        const addresses = (Array.isArray(entries) ? entries : [entries]).map((account) =>
          toBase58(decodeAddress(account)),
        )
        for (const address of addresses) node.unlockedAccounts.add(address)
        return true as const
      })
    },
  }
}
