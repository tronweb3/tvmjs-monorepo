import { bytesToHex } from '@tvmjs/util'
/** Protocol adapters for the shared development APIs. */
import { TronWeb } from 'tronweb'

import { accountsFromMnemonic } from '../../config.ts'
import { MAX_BLOCK_TIME_SECONDS, MAX_MINE_BLOCKS } from '../../core/validation.ts'
import { isCurrentRef } from '../../development/debug.ts'
import { developmentApi } from '../../development/index.ts'
import { INT64_MAX } from '../../intBounds.ts'
import { InvalidParamsError } from '../../provider.ts'
import { ACCEPT, TextBody } from '../registry.ts'
import { parseAnyAddress, toBase58 } from '../tron/address.ts'
import { accountListing, addressFormat } from './accountListing.ts'
import {
  decodeAddress,
  decodeBoundInt,
  decodeDataWord,
  decodeHash,
  decodeHex,
  decodeInt,
  decodeLong,
} from './decode.ts'

import type { AccountConfig } from '../../config.ts'
import type { NodeCore } from '../../core/node.ts'
import type { TreApi } from '../../development/tre.ts'
import type { HandlerParams, Registry } from '../registry.ts'
import type { AccountRow, RosterWallet } from './accountListing.ts'

/** tre_* / debug_* params arrive as JSON-RPC positional arrays. */
function asArray(params: HandlerParams): unknown[] {
  return Array.isArray(params) ? (params as unknown[]) : []
}

/** Enforce the protocol's positional argument counts before dispatch. */
function args(params: HandlerParams, ...counts: number[]): unknown[] {
  const list = asArray(params)
  if (!counts.includes(list.length)) throw new InvalidParamsError('method parameters invalid')
  return list
}

/**
 * Every key the node hands out, grouped by the wallet that made it: the genesis
 * allocation first, then each minted batch. Balances are read from the chain,
 * so the roster reflects spending rather than the funding amount.
 */
async function rosterWallets(node: NodeCore): Promise<RosterWallet[]> {
  const config = node.config
  const mnemonicAccounts = accountsFromMnemonic(config.mnemonic)
  const withBalances = async (accounts: AccountConfig[]): Promise<AccountRow[]> =>
    Promise.all(
      accounts.map(async (account) => ({
        privateKey: account.privateKey,
        balanceSun: await node.getBalance(
          parseAnyAddress(TronWeb.address.fromPrivateKey(account.privateKey) as string),
        ),
      })),
    )
  return [
    { mnemonic: config.mnemonic.phrase, accounts: await withBalances(mnemonicAccounts) },
    ...(config.accounts.length === 0
      ? []
      : [{ mnemonic: '', accounts: await withBalances(config.accounts) }]),
    ...(await Promise.all(
      node.generatedAccounts.map(async (batch) => ({
        mnemonic: batch.mnemonic,
        accounts: await withBalances(batch.accounts),
      })),
    )),
  ]
}

export function registerTreDialect(registry: Registry): void {
  registry.register('tre_setAccountBalance', (node, params) => {
    const [account, balance] = args(params, 2)
    const address = toBase58(decodeAddress(account))
    const amount = decodeLong(balance)
    if (amount < 0n) throw new InvalidParamsError('balance can not be less than 0')
    return developmentApi(node).tre.setAccountBalance(address, amount)
  })

  registry.register('tre_setAccountCode', (node, params) => {
    const [account, code] = args(params, 2)
    return developmentApi(node).tre.setAccountCode(
      toBase58(decodeAddress(account)),
      decodeHex(code),
    )
  })

  registry.register('tre_setAccountStorageAt', (node, params) => {
    const [account, slot, value] = args(params, 3)
    return developmentApi(node).tre.setAccountStorageAt(
      toBase58(decodeAddress(account)),
      decodeDataWord(slot),
      decodeDataWord(value),
    )
  })

  registry.register('tre_blockTime', async (node, params) => {
    const seconds = decodeInt(args(params, 1)[0])
    if (seconds < 0 || seconds > MAX_BLOCK_TIME_SECONDS) {
      throw new InvalidParamsError('block time should between [0, 60] in second')
    }
    await developmentApi(node).tre.blockTime(seconds)
    return true
  })

  registry.register('tre_increaseTime', async (node, params) => {
    const [seconds] = asArray(params)
    try {
      const record = await developmentApi(node).tre.increaseTime(decodeInt(seconds))
      return record.timestampMs
    } catch (error) {
      if (error instanceof RangeError) throw new InvalidParamsError(error.message)
      throw error
    }
  })

  registry.register('tre_mine', async (node, params) => {
    const [options] = args(params, 0, 1)
    const blocks =
      options === undefined ? 1 : decodeInt((options as { blocks?: unknown } | null)?.blocks)
    if (blocks <= 0 || blocks > MAX_MINE_BLOCKS) {
      throw new InvalidParamsError('blocks should between (0, 100]')
    }
    await developmentApi(node).tre.mine(blocks)
    return '0x0'
  })

  registry.register('tre_unlockedAccounts', (node, params) =>
    developmentApi(node).tre.unlockedAccounts(
      ...(args(params, 1) as Parameters<TreApi['unlockedAccounts']>),
    ),
  )

  registry.register('debug_traceTransaction', (node, params) =>
    developmentApi(node).debug.traceTransaction(bytesToHex(decodeHash(args(params, 1)[0]))),
  )

  registry.register('debug_storageRangeAt', (node, params) => {
    const [ref, txIndex, account, startKey, limit] = args(params, 5)
    if (decodeBoundInt(txIndex) > 0)
      throw new InvalidParamsError('only the latest/current state is supported, txIndex must be 0')
    if (!isCurrentRef(node, ref))
      throw new InvalidParamsError('only the latest/current state is supported')
    const address = toBase58(decodeAddress(account))
    const count = decodeBoundInt(limit)
    if (count <= 0) throw new InvalidParamsError('limit must be greater than 0')
    return developmentApi(node).debug.storageRangeAt(
      'latest',
      0,
      address,
      startKey as string | null,
      count,
    )
  })

  const identity = (node: NodeCore): TextBody => {
    const { name, version } = developmentApi(node).admin.info()
    return TextBody.plain(`${name} ${version}`)
  }
  registry.register('admin', identity)
  registry.register('admin/', identity)

  registry.register('admin/accounts', async (node, params) =>
    TextBody.plain(
      `${accountListing(
        await rosterWallets(node),
        addressFormat((params as Record<string, unknown>).format),
      )}\n`,
    ),
  )

  registry.register('healthcheck', (_node, params) =>
    (params[ACCEPT] ?? '').includes('json') ? { ok: true } : TextBody.plain('OK'),
  )

  registry.register('admin/accounts-json', (node) => developmentApi(node).admin.accounts())

  registry.register('admin/temporary-accounts-generation', async (node, params) => {
    // Query-string compatibility: invalid legacy values read as absent.
    const whole = (value: unknown): number | undefined => {
      if (value === undefined || value === null || value === '') return undefined
      const parsed = Number(String(value).trim())
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
    }
    const balance = whole(params.defaultBalance)
    await developmentApi(node).admin.temporaryAccountsGeneration({
      accounts: whole(params.accounts),
      defaultBalance:
        balance !== undefined && BigInt(balance) <= INT64_MAX / 1_000_000n ? balance : undefined,
    })
    return TextBody.plain(`${accountListing(await rosterWallets(node))}\n`)
  })

  registry.register('admin/accounts-generation', async (node) => {
    await developmentApi(node).admin.accountsGeneration()
    return TextBody.plain('')
  })
}
