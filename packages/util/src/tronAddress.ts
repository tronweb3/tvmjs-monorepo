import { sha256 } from '@noble/hashes/sha2.js'
import bs58 from 'bs58'
import { bytesToHex, concatBytes, hexToBytes } from './bytes.ts'
import { EthereumJSErrorWithoutCode } from './errors.ts'
import { assertIsBytes, assertIsString } from './helpers.ts'
import { isHexString } from './internal.ts'
import type { PrefixedHexString } from './types.ts'

/**
 * TRON address prefix byte (mainnet)
 */
const TRON_ADDRESS_PREFIX = 0x41

/**
 * Convert a 20-byte EVM address to TRON hex format (0x41 + 20 bytes)
 * @param address 20-byte address
 * @returns Hex string with 0x41 prefix (42 hex chars)
 */
export function toTronHexAddress(address: Uint8Array): PrefixedHexString {
  assertIsBytes(address)
  if (address.length !== 20) {
    throw EthereumJSErrorWithoutCode('Address must be 20 bytes')
  }
  const prefixed = concatBytes(Uint8Array.from([TRON_ADDRESS_PREFIX]), address)
  return bytesToHex(prefixed)
}

/**
 * Convert a 20-byte EVM address to TRON Base58Check format (T-prefixed)
 * @param address 20-byte address
 * @returns Base58Check encoded address (typically 34 chars starting with 'T')
 */
export function toTronBase58Address(address: Uint8Array): string {
  assertIsBytes(address)
  if (address.length !== 20) {
    throw EthereumJSErrorWithoutCode('Address must be 20 bytes')
  }

  // Step 1: Prepend TRON prefix (0x41)
  const prefixed = concatBytes(Uint8Array.from([TRON_ADDRESS_PREFIX]), address)

  // Step 2: Calculate checksum (first 4 bytes of double SHA256)
  const hash1 = sha256(prefixed)
  const hash2 = sha256(hash1)
  const checksum = hash2.subarray(0, 4)

  // Step 3: Append checksum and encode with Base58
  const payload = concatBytes(prefixed, checksum)
  return bs58.encode(payload)
}

/**
 * Convert TRON hex address (0x41...) to 20-byte EVM address
 * @param hexAddress Hex string with 0x41 prefix (42 hex chars)
 * @returns 20-byte address
 */
export function fromTronHexAddress(hexAddress: string): Uint8Array {
  if (!isHexString(hexAddress)) {
    throw EthereumJSErrorWithoutCode('Invalid hex string')
  }

  const bytes = hexToBytes(hexAddress as PrefixedHexString)

  if (bytes.length !== 21) {
    throw EthereumJSErrorWithoutCode('TRON hex address must be 21 bytes (0x41 + 20 bytes)')
  }

  if (bytes[0] !== TRON_ADDRESS_PREFIX) {
    throw EthereumJSErrorWithoutCode(
      `Invalid TRON address prefix: expected 0x41, got 0x${bytes[0].toString(16).padStart(2, '0')}`,
    )
  }

  return bytes.subarray(1)
}

/**
 * Convert TRON Base58Check address to 20-byte EVM address
 * @param base58Address Base58Check encoded address (T-prefixed)
 * @returns 20-byte address
 */
export function fromTronBase58Address(base58Address: string): Uint8Array {
  assertIsString(base58Address)
  if (base58Address.length !== 34) {
    throw EthereumJSErrorWithoutCode(
      `Invalid TRON Base58 address length: expected 34 characters, got ${base58Address.length}`,
    )
  }

  let decoded: Uint8Array
  try {
    decoded = bs58.decode(base58Address)
  } catch (e) {
    throw EthereumJSErrorWithoutCode(`Invalid Base58 encoding: ${(e as Error).message}`)
  }

  if (decoded.length !== 25) {
    throw EthereumJSErrorWithoutCode(
      `Invalid TRON address length: expected 25 bytes (0x41 + 20 bytes + 4 checksum), got ${decoded.length}`,
    )
  }

  // Verify prefix
  if (decoded[0] !== TRON_ADDRESS_PREFIX) {
    throw EthereumJSErrorWithoutCode(
      `Invalid TRON address prefix: expected 0x41, got 0x${decoded[0].toString(16).padStart(2, '0')}`,
    )
  }

  // Verify checksum
  const payload = decoded.subarray(0, 21)
  const checksum = decoded.subarray(21, 25)

  const hash1 = sha256(payload)
  const hash2 = sha256(hash1)
  const expectedChecksum = hash2.subarray(0, 4)

  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw EthereumJSErrorWithoutCode('TRON address checksum verification failed')
    }
  }

  // Return the 20-byte address (without prefix)
  return payload.subarray(1)
}

/**
 * Validate TRON Base58Check address format
 * @param address Base58Check encoded address
 * @returns true if valid, false otherwise
 */
export function isValidTronBase58Address(address: string): boolean {
  try {
    fromTronBase58Address(address)
    return true
  } catch {
    return false
  }
}
