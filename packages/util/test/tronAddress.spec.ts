import { assert, describe, it } from 'vitest'
import { hexToBytes } from '../src/bytes.ts'
import {
  fromTronBase58Address,
  fromTronHexAddress,
  isValidTronBase58Address,
  toTronBase58Address,
  toTronHexAddress,
} from '../src/tronAddress.ts'

import type { PrefixedHexString } from '../src/types.ts'

type AddressVector = {
  name: string
  base58: string
  hex41: PrefixedHexString
  hex20: PrefixedHexString
}

describe('TRON Address Utilities', () => {
  // Known TRON addresses, cross-checked against the official TronWeb library
  // (tronweb.address.fromHex / toHex) and public mainnet data.
  // cspell:ignore Hqje Szgj
  const knownAddresses: AddressVector[] = [
    {
      name: 'USDT TRC20 Contract',
      base58: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      hex41: '0x41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
      hex20: '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c',
    },
    {
      name: 'Zero address (T9yD...)',
      base58: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
      hex41: '0x410000000000000000000000000000000000000000',
      hex20: '0x0000000000000000000000000000000000000000',
    },
  ]

  describe('toTronHexAddress', () => {
    it('should convert 20-byte address to TRON hex format (0x41 prefix)', () => {
      for (const addr of knownAddresses) {
        const bytes20 = hexToBytes(addr.hex20)
        const result = toTronHexAddress(bytes20)
        assert.equal(result, addr.hex41, `Failed for ${addr.name}`)
      }
    })

    it('should throw on invalid input length', () => {
      assert.throws(() => toTronHexAddress(hexToBytes('0x1234')), /Address must be 20 bytes/)
    })
  })

  describe('toTronBase58Address', () => {
    it('should convert 20-byte address to TRON Base58Check format', () => {
      for (const addr of knownAddresses) {
        const bytes20 = hexToBytes(addr.hex20)
        const result = toTronBase58Address(bytes20)
        assert.equal(result, addr.base58, `Failed for ${addr.name}`)
      }
    })

    it('should throw on invalid input length', () => {
      assert.throws(() => toTronBase58Address(hexToBytes('0x1234')), /Address must be 20 bytes/)
    })
  })

  describe('fromTronHexAddress', () => {
    it('should convert TRON hex address to 20-byte address', () => {
      for (const addr of knownAddresses) {
        const result = fromTronHexAddress(addr.hex41)
        const expected = hexToBytes(addr.hex20)
        assert.deepEqual(result, expected, `Failed for ${addr.name}`)
      }
    })

    it('should throw on invalid length', () => {
      assert.throws(() => fromTronHexAddress('0x41a614f8'), /TRON hex address must be 21 bytes/)
    })

    it('should throw on invalid prefix', () => {
      assert.throws(
        () => fromTronHexAddress('0xffa614f803b6fd780986a42c78ec9c7f77e6ded13c'),
        /Invalid TRON address prefix: expected 0x41, got 0xff/,
      )
    })
  })

  describe('fromTronBase58Address', () => {
    it('should convert TRON Base58Check address to 20-byte address', () => {
      for (const addr of knownAddresses) {
        const result = fromTronBase58Address(addr.base58)
        const expected = hexToBytes(addr.hex20)
        assert.deepEqual(result, expected, `Failed for ${addr.name}`)
      }
    })

    it('should throw on invalid Base58 encoding', () => {
      assert.throws(() => fromTronBase58Address('0'.repeat(34)), /Invalid Base58 encoding/)
    })

    it('should reject invalid length before Base58 decoding', () => {
      assert.throws(
        () => fromTronBase58Address('T'.repeat(10000)),
        /Invalid TRON Base58 address length: expected 34 characters, got 10000/,
      )
    })

    it('should throw on non-string input', () => {
      assert.throws(() => fromTronBase58Address(new Uint8Array(34) as any), /only supports string/)
    })

    it('should throw on invalid checksum', () => {
      // Modify last character to break checksum
      const invalidAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6X'
      assert.throws(
        () => fromTronBase58Address(invalidAddress),
        /TRON address checksum verification failed/,
      )
    })
  })

  describe('isValidTronBase58Address', () => {
    it('should return true for valid addresses', () => {
      for (const addr of knownAddresses) {
        assert.equal(isValidTronBase58Address(addr.base58), true, `Failed for ${addr.name}`)
      }
    })

    it('should return false for invalid addresses', () => {
      assert.equal(isValidTronBase58Address('Invalid0OIl'), false)
      assert.equal(isValidTronBase58Address('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6X'), false)
      assert.equal(isValidTronBase58Address(''), false)
    })
  })

  describe('Round-trip conversion', () => {
    it('should maintain consistency: hex20 → hex41 → hex20', () => {
      for (const addr of knownAddresses) {
        const bytes20 = hexToBytes(addr.hex20)
        const hex41 = toTronHexAddress(bytes20)
        const recovered = fromTronHexAddress(hex41)
        assert.deepEqual(recovered, bytes20, `Failed for ${addr.name}`)
      }
    })

    it('should maintain consistency: hex20 → base58 → hex20', () => {
      for (const addr of knownAddresses) {
        const bytes20 = hexToBytes(addr.hex20)
        const base58 = toTronBase58Address(bytes20)
        const recovered = fromTronBase58Address(base58)
        assert.deepEqual(recovered, bytes20, `Failed for ${addr.name}`)
      }
    })

    it('should maintain consistency: hex41 ↔ base58', () => {
      for (const addr of knownAddresses) {
        const bytes20fromHex = fromTronHexAddress(addr.hex41)
        const bytes20fromBase58 = fromTronBase58Address(addr.base58)
        assert.deepEqual(bytes20fromHex, bytes20fromBase58, `Failed for ${addr.name}`)
      }
    })
  })

  describe('Input validation (type safety)', () => {
    it('toTronHexAddress should throw on string input instead of silently converting', () => {
      // This would produce 0x41 + 20 zeros (wrong!) without assertIsBytes
      assert.throws(() => toTronHexAddress('a'.repeat(20) as any), /only supports Uint8Array/)
    })

    it('toTronBase58Address should throw on string input instead of silently converting', () => {
      assert.throws(() => toTronBase58Address('a'.repeat(20) as any), /only supports Uint8Array/)
    })

    it('toTronHexAddress should throw on plain array', () => {
      assert.throws(
        () => toTronHexAddress(new Array(20).fill(0) as any),
        /only supports Uint8Array/,
      )
    })

    it('toTronBase58Address should throw on plain array', () => {
      assert.throws(
        () => toTronBase58Address(new Array(20).fill(0) as any),
        /only supports Uint8Array/,
      )
    })
  })
})
