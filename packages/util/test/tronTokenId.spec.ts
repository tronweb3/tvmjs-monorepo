import { RLP } from '@tvmjs/rlp'
import { assert, describe, it } from 'vitest'

import {
  Account,
  bytesToBigInt,
  createAccount,
  createAccountFromRLP,
  tokenIdFromKey,
  tokenIdToKey,
} from '../src/index.ts'

const TWO_POW_53 = 2n ** 53n
const HIGH_IDS = [TWO_POW_53 - 1n, TWO_POW_53, TWO_POW_53 + 1n, 2n ** 63n - 1n]

function decodedAssetIds(account: Account): bigint[] {
  const [, , , , asset] = RLP.decode(account.serialize()) as Uint8Array[][]
  const ids: bigint[] = []
  for (let i = 0; i < asset.length; i += 2) ids.push(bytesToBigInt(asset[i] as Uint8Array))
  return ids
}

describe('TRC-10 token ID precision', () => {
  it('converts token IDs to canonical decimal keys', () => {
    assert.strictEqual(tokenIdToKey(1000001n), '1000001')
    assert.strictEqual(tokenIdToKey(TWO_POW_53 + 1n), '9007199254740993')
    assert.strictEqual(tokenIdToKey(1000001), '1000001')
    assert.throws(() => tokenIdToKey(2 ** 53), /safe integer/)
    assert.throws(() => tokenIdToKey(1.5), /safe integer/)
    assert.throws(() => tokenIdToKey(-1n), /negative/)
    assert.strictEqual(tokenIdFromKey('9007199254740993'), TWO_POW_53 + 1n)
    assert.throws(() => tokenIdFromKey('0x0f4241'), /token ID/)
  })

  it('keys adjacent IDs above 2^53 independently', () => {
    const account = createAccount({})
    HIGH_IDS.forEach((id, index) => {
      account.asset[tokenIdToKey(id)] = BigInt(index + 1) * 10n
    })
    assert.strictEqual(Object.keys(account.asset).length, HIGH_IDS.length)
    HIGH_IDS.forEach((id, index) => {
      assert.strictEqual(account.getTokenBalance(id), BigInt(index + 1) * 10n)
    })
    assert.strictEqual(account.getTokenBalance(TWO_POW_53 + 2n), 0n)
  })

  it('round-trips high IDs through RLP without merging balances', () => {
    const account = createAccount({
      asset: {
        [tokenIdToKey(TWO_POW_53)]: 1n,
        [tokenIdToKey(TWO_POW_53 + 1n)]: 2n,
        [tokenIdToKey(2n ** 63n - 1n)]: 3n,
      },
    })
    const restored = createAccountFromRLP(account.serialize())
    assert.strictEqual(restored.getTokenBalance(TWO_POW_53), 1n)
    assert.strictEqual(restored.getTokenBalance(TWO_POW_53 + 1n), 2n)
    assert.strictEqual(restored.getTokenBalance(2n ** 63n - 1n), 3n)
    assert.deepEqual(restored.serialize(), account.serialize())
    assert.deepEqual(decodedAssetIds(account), [TWO_POW_53, TWO_POW_53 + 1n, 2n ** 63n - 1n])
  })

  it('keeps the ordinary ID encoding and orders assets by numeric ID', () => {
    const ascending = createAccount({ asset: { 1000001: 1n, 1000002: 2n } })
    const descending = createAccount({ asset: { 1000002: 2n, 1000001: 1n } })
    assert.deepEqual(ascending.serialize(), descending.serialize())
    assert.deepEqual(decodedAssetIds(descending), [1000001n, 1000002n])

    const mixed = createAccount({
      asset: {
        [tokenIdToKey(TWO_POW_53 + 1n)]: 5n,
        1000001: 1n,
        [tokenIdToKey(TWO_POW_53)]: 4n,
      },
    })
    assert.deepEqual(decodedAssetIds(mixed), [1000001n, TWO_POW_53, TWO_POW_53 + 1n])
  })

  it('rejects non-canonical asset keys and invalid balances', () => {
    for (const key of ['0x0f4241', '01000001', '1e6', '-1', '1000001.5', 'abc', '']) {
      assert.throws(() => createAccount({ asset: { [key]: 1n } }), /token ID/, key)
      assert.throws(() => {
        const account = new Account()
        account.asset = { [key]: 1n }
      }, /token ID/)
    }
    assert.throws(() => createAccount({ asset: { 1000001: -1n } }), /balance/)
    assert.throws(() => createAccount({ asset: { 1000001: 1 as unknown as bigint } }), /bigint/)
  })

  it('rejects unsafe number token IDs at the balance accessor', () => {
    const account = createAccount({ asset: { 1000001: 7n } })
    assert.strictEqual(account.getTokenBalance(1000001n), 7n)
    assert.strictEqual(account.getTokenBalance(1000001), 7n)
    assert.throws(() => account.getTokenBalance((2 ** 53) as unknown as bigint), /safe integer/)
  })
})
