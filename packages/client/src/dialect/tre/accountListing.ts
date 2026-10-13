import { TronWeb } from 'tronweb'

import { HD_PATH } from '../../hdWallet.ts'

/** the rule under each heading */
const RULE = '=================='

/** one roster row: the key, and what the chain says the account holds now */
export interface AccountRow {
  privateKey: string
  balanceSun: bigint
}

/** a set of accounts and the phrase they were derived from */
export interface RosterWallet {
  /** empty when the accounts did not come from a wallet */
  mnemonic: string
  accounts: AccountRow[]
}

/**
 * How the addresses are rendered. `hex` swaps base58 for the 41-prefixed form;
 * `all` prints both, the balance riding the indented hex line.
 */
export type AddressFormat = 'base58' | 'hex' | 'all'

export function addressFormat(value: unknown): AddressFormat {
  return value === 'hex' ? 'hex' : value === 'all' ? 'all' : 'base58'
}

/**
 * The account roster as text: the addresses, then the keys that open them.
 * The startup banner and the `admin/accounts` route print the same block, so
 * whatever a caller reads on the wire is what scrolled past at boot.
 *
 * Balances are whatever the chain holds when the roster is asked for, not what
 * the accounts were funded with, so the listing tracks spending.
 *
 * A batch minted later is a wallet of its own, and gets its own block with its
 * own numbering. Running the batches into one sequence would put a row at an
 * index its wallet never derived, which is exactly what `{account_index}` on
 * the path line promises it can reproduce.
 */
export function accountListing(wallets: RosterWallet[], format: AddressFormat = 'base58'): string {
  return wallets.map((wallet) => walletBlock(wallet, format)).join('\n\n')
}

function walletBlock(wallet: RosterWallet, format: AddressFormat): string {
  const entries = wallet.accounts.flatMap((row, index) => {
    const base58 = TronWeb.address.fromPrivateKey(row.privateKey) as string
    const hex = TronWeb.address.toHex(base58) as string
    const trx = `(${TronWeb.fromSun(row.balanceSun as never)} TRX)`
    if (format === 'all') {
      return [`(${index}) ${base58}`, `    ${hex} ${trx}`]
    }
    return [`(${index}) ${format === 'hex' ? hex : base58} ${trx}`]
  })
  return [
    'Available Accounts',
    RULE,
    '',
    ...entries,
    '',
    'Private Keys',
    RULE,
    '',
    ...wallet.accounts.map((row, index) => `(${index}) ${row.privateKey}`),
    ...(wallet.mnemonic === ''
      ? []
      : [
          '',
          'HD Wallet',
          RULE,
          `Mnemonic:      ${wallet.mnemonic}`,
          `Base HD Path:  ${HD_PATH}{account_index}`,
        ]),
  ].join('\n')
}
