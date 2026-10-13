import { randomBytes } from 'node:crypto'

import { utils } from 'tronweb'

const { Mnemonic, ethersHDNodeWallet, sha256 } = utils.ethersUtils

/**
 * TRON's registered coin type. The account index is appended per key, so the
 * path that reproduces account `n` is `${HD_PATH}${n}`.
 *
 * Wallets derive TRON accounts only under `m/44'/195'`, so this is the only
 * prefix that reproduces these accounts.
 */
export const HD_PATH = "m/44'/195'/0'/0/"

/**
 * The wallet the default accounts come from. Fixed entropy, so every start
 * brings up the same chain and the phrase is plainly synthetic.
 */
export const DEV_MNEMONIC = Mnemonic.fromEntropy(
  sha256(new TextEncoder().encode('tvmjs/client dev wallet')).slice(0, 34),
).phrase

/** the first `count` private keys of a wallet, as unprefixed hex */
export function derivePrivateKeys(mnemonic: string, count: number): string[] {
  const phrase = Mnemonic.fromPhrase(mnemonic)
  return Array.from({ length: count }, (_unused, index) =>
    ethersHDNodeWallet.fromMnemonic(phrase, `${HD_PATH}${index}`).privateKey.replace(/^0x/, ''),
  )
}

/** a fresh wallet, for accounts minted after the chain is already running */
export function randomMnemonic(): string {
  return Mnemonic.fromEntropy(randomBytes(16)).phrase
}
