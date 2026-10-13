import { TronWeb } from 'tronweb'

import { CLIENT_NAME, CLIENT_VERSION, MAX_ACCOUNT_COUNT, accountsFromMnemonic } from '../config.ts'
import { WITNESS_PRIVATE_KEY } from '../core/witness.ts'
import { parseAnyAddress } from '../dialect/tron/address.ts'
import { derivePrivateKeys, randomMnemonic } from '../hdWallet.ts'
import { parseInteger } from '../input.ts'
import { INT64_MAX } from '../intBounds.ts'

import type { NodeAccounts } from '../accounts.ts'
import type { AccountConfig } from '../config.ts'
import type { NodeCore } from '../core/node.ts'
import type { IntegerInput } from '../input.ts'

export interface ClientIdentity {
  name: string
  version: string
}

export interface TemporaryAccountsOptions {
  /** Number of accounts in the new group. Default: 10; maximum: 100. */
  accounts?: IntegerInput
  /** Balance for all development accounts, in whole TRX. Defaults to mnemonic.balance (10,000 TRX by default). */
  defaultBalance?: IntegerInput
}

/** Node identity and development-account management. */
export interface AdminApi {
  info(): ClientIdentity
  /** Development signing credentials for all account groups. */
  accounts(): Promise<NodeAccounts>
  /** Create a new group and reset all development balances; mine a block. */
  temporaryAccountsGeneration(options?: TemporaryAccountsOptions): Promise<NodeAccounts>
  /** Reset existing development accounts to the configured mnemonic balance and mine a block. */
  accountsGeneration(): Promise<void>
}

const DEFAULT_MINTED_ACCOUNTS = 10
const DEFAULT_BALANCE_SUN = 10_000_000_000n
const SUN_PER_TRX = 1_000_000n
const MAX_BALANCE_TRX = Number(INT64_MAX / SUN_PER_TRX)

export function temporaryAccountsOptions(value: unknown): {
  accounts?: number
  defaultBalance?: number
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('temporary account options must be an object')
  }
  const result: { accounts?: number; defaultBalance?: number } = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'accounts' && key !== 'defaultBalance') {
      throw new TypeError(`Unknown temporary account option "${key}"`)
    }
    if (entry === undefined) continue
    result[key] = Number(
      parseInteger(entry, key, {
        max: BigInt(key === 'accounts' ? MAX_ACCOUNT_COUNT : MAX_BALANCE_TRX),
        ...(key === 'defaultBalance' ? { unit: 'whole TRX' } : {}),
      }),
    )
  }
  return result
}

function rosterBalance(node: NodeCore): bigint {
  return node.config.mnemonic.balance ?? DEFAULT_BALANCE_SUN
}

/**
 * Put every account on the roster — the mnemonic-derived group, configured
 * genesis accounts, and every minted batch — on one balance. An outright set, so an account that
 * spent is topped back up and one that received is brought back down.
 * Everything off the roster stays as it is.
 *
 * The key that signs blocks keeps whatever it holds.
 */
async function fundRoster(node: NodeCore, balanceSun: bigint): Promise<void> {
  const config = node.config
  const mnemonicAccounts = accountsFromMnemonic(config.mnemonic)
  const wallets = [mnemonicAccounts, config.accounts].concat(
    node.generatedAccounts.map((batch) => batch.accounts),
  )
  for (const accounts of wallets) {
    for (const account of accounts) {
      if (account.privateKey.toLowerCase() === WITNESS_PRIVATE_KEY) continue
      await node.setBalance(
        parseAnyAddress(TronWeb.address.fromPrivateKey(account.privateKey) as string),
        balanceSun,
      )
    }
  }
}

export function createAdminApi(node: NodeCore): AdminApi {
  return {
    info: () => ({ name: CLIENT_NAME, version: CLIENT_VERSION }),
    accounts: () => node.withWriteLock(async () => node.getAccounts()),
    temporaryAccountsGeneration: async (options = {}) => {
      const parsed = temporaryAccountsOptions(options)
      const count = parsed.accounts ?? DEFAULT_MINTED_ACCOUNTS
      const named = parsed.defaultBalance
      return node.withWriteLock(async () => {
        const balance = named === undefined ? rosterBalance(node) : BigInt(named) * SUN_PER_TRX
        const mnemonic = randomMnemonic()
        const minted: AccountConfig[] = derivePrivateKeys(mnemonic, count).map((privateKey) => ({
          privateKey,
          balance,
        }))
        return node.transact(async () => {
          node.generatedAccounts.push({ mnemonic, accounts: minted })
          node.recordUndo(() => node.generatedAccounts.pop())
          await fundRoster(node, balance)
          await node.mine(1)
          return node.getAccounts()
        })
      })
    },
    accountsGeneration: () =>
      node.withWriteLock(async () => {
        await node.transact(async () => {
          await fundRoster(node, rosterBalance(node))
          await node.mine(1)
        })
      }),
  }
}
