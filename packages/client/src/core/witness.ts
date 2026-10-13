/**
 * The chain's single block producer, on the witness roll from genesis. The
 * key is the canonical dev key — private key 1 — and every sealed header
 * carries its signature over the raw header hash, which recovers to this
 * address.
 */
export const WITNESS_PRIVATE_KEY = `${'00'.repeat(31)}01`
export const WITNESS_ADDRESS = '417e5f4552091a69125d5dfcb7b8c2659029395bdf'

/** the producer's balance on the genesis roll; a configured account at this address replaces it */
export const WITNESS_INITIAL_BALANCE_SUN = 99_000_000_000_000_000n

/**
 * The genesis block names its producer with a sentence rather than an address.
 * The text is fixed in the source, so every chain's block 0 carries it.
 */
export const GENESIS_WITNESS_TEXT =
  'A new system must allow existing systems to be linked together without ' +
  'requiring any central control or coordination'

/** genesis votes on the producer's record — its full weight in the standby list */
export const WITNESS_VOTE_COUNT = 10_000

/** the producer's url on record */
export const WITNESS_URL = 'https://github.com/tronweb3/tvmjs-monorepo'

/** percent of each reward the producer keeps; the rest belongs to its voters */
export const WITNESS_BROKERAGE = 20

/**
 * The producer's cut of one reward payment. The runtime intentionally uses
 * IEEE-754 here: reward settlement rounds each multiplication through a
 * double before storing its integral result.
 */
export function brokerageShareSun(valueSun: bigint, brokerage = WITNESS_BROKERAGE): bigint {
  return BigInt(Math.trunc((brokerage / 100) * Number(valueSun)))
}
