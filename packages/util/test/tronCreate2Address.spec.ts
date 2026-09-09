// cspell:ignore osok
import { keccak_256 } from '@noble/hashes/sha3.js'
import { assert, describe, it } from 'vitest'
import { generateAddress2, generateTronAddress2 } from '../src/account.ts'
import { bytesToHex, concatBytes, hexToBytes } from '../src/bytes.ts'
import { toTronBase58Address, toTronHexAddress } from '../src/tronAddress.ts'

import type { PrefixedHexString } from '../src/types.ts'

/**
 * TRON CREATE2 contract address derivation tests.
 *
 * Protocol alignment (against java-tron GreatVoyage-v4.8.2):
 *
 *   CREATE2 (ALIGNED):
 *     - java-tron: keccak256(senderAddress21 || salt32 || keccak256(code))[-20:]
 *       (see Program.java:1618-1641, WalletUtil.java:56-58)
 *     - TVMJS:     keccak256(0x41 || deployer20 || salt32 || keccak256(code))[-20:]
 *     - The 0x41 prefix participates in the hash preimage, NOT just result encoding.
 *     - TRON uses 0x41 where Ethereum uses 0xff (EIP-1014).
 *
 *   CREATE (ALIGNED):
 *     - java-tron uses keccak256(rootTransactionId || nonce), not Ethereum's RLP.
 *     - TVMJS uses the same keccak256(rootTransactionId || nonce) derivation.
 *     - CREATE alignment is complete with TVM context propagation.
 *
 * Vector provenance:
 *   - Base58Check encodings cross-validated with TronWeb 6.3.0 (TronWeb.address.fromHex).
 *   - Hex20 values lock current CREATE2 implementation behavior.
 */

const DEPLOYER_HEX: PrefixedHexString = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'
const DEPLOYER = hexToBytes(DEPLOYER_HEX)

describe('TRON CREATE2 contract address derivation', () => {
  const SALT_ONE = (() => {
    const s = new Uint8Array(32)
    s[31] = 1
    return s
  })()
  const INIT_CODE = hexToBytes(
    '0x6080604052348015600f57600080fd5b50603f80601d6000396000f3fe6080604052600080fdfea2646970667358221220',
  )

  it('should match the fixed TRON vector', () => {
    const actual = generateTronAddress2(DEPLOYER, SALT_ONE, INIT_CODE)
    assert.strictEqual(bytesToHex(actual), '0x9c4aafe1c2bddf8aa6fa601ea57e0d5dc0132cd5')
    assert.strictEqual(toTronBase58Address(actual), 'TQDbtL9c9HcFce5hpHTNnqFHnQcZ5osokK')
    assert.strictEqual(toTronHexAddress(actual), '0x419c4aafe1c2bddf8aa6fa601ea57e0d5dc0132cd5')
  })

  it('should use the 0x41 prefix and NOT the Ethereum 0xff prefix', () => {
    // Recompute both variants explicitly. This is the assertion that actually
    // pins the prefix: reverting the implementation to 0xff fails here.
    const withTronPrefix = keccak_256(
      concatBytes(Uint8Array.from([0x41]), DEPLOYER, SALT_ONE, keccak_256(INIT_CODE)),
    ).subarray(-20)
    const withEthPrefix = keccak_256(
      concatBytes(Uint8Array.from([0xff]), DEPLOYER, SALT_ONE, keccak_256(INIT_CODE)),
    ).subarray(-20)

    const actual = generateTronAddress2(DEPLOYER, SALT_ONE, INIT_CODE)
    assert.deepEqual(actual, withTronPrefix, 'must equal the 0x41 (TRON) derivation')
    assert.notDeepEqual(actual, withEthPrefix, 'must NOT equal the 0xff (Ethereum) derivation')
    // Pin the Ethereum result too, so the two are provably distinct.
    assert.strictEqual(bytesToHex(withEthPrefix), '0x33039046eae7d5b4a50be2f9509d1525900bc005')
  })

  it('should be deterministic for identical inputs', () => {
    const a = generateTronAddress2(DEPLOYER, SALT_ONE, INIT_CODE)
    const b = generateTronAddress2(DEPLOYER, SALT_ONE, INIT_CODE)
    assert.deepEqual(a, b)
  })

  it('should differ when the salt differs', () => {
    const salt1 = new Uint8Array(32).fill(1)
    const salt2 = new Uint8Array(32).fill(2)
    assert.notDeepEqual(
      generateTronAddress2(DEPLOYER, salt1, INIT_CODE),
      generateTronAddress2(DEPLOYER, salt2, INIT_CODE),
    )
  })

  it('is distinct from Ethereum EIP-1014 derivation', () => {
    assert.notDeepEqual(
      generateTronAddress2(DEPLOYER, SALT_ONE, INIT_CODE),
      generateAddress2(DEPLOYER, SALT_ONE, INIT_CODE),
    )
  })
})
