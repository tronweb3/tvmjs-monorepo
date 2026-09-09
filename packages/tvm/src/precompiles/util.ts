import { Hardfork } from '@tvmjs/common'
import { EthereumJSErrorWithoutCode, ecrecover, publicToAddress, short } from '@tvmjs/util'

import { DataWord } from './dataWord.ts'
import type { PrecompileInput } from './index.ts'

const TRON_OSAKA_PROPOSAL = 96
const SIGNATURE_CALLDATA_HEADER_WORDS = 5
export const SIGNATURE_LENGTH = 65

/**
 * Returns whether TRON's Osaka proposal is active for this execution profile.
 * Ethereum hardforks and proposal metadata must not enable TIP-854.
 */
export function isTronOsakaEnabled(opts: Pick<PrecompileInput, 'common'>): boolean {
  return (
    opts.common.gteHardfork(Hardfork.Tron) && opts.common.isActivatedProposal(TRON_OSAKA_PROPOSAL)
  )
}

/**
 * TIP-854 ABI shape check shared by the TRON signature precompiles.
 */
export function isValidTronSignatureCalldata(data: Uint8Array, itemWords: number): boolean {
  const headerBytes = SIGNATURE_CALLDATA_HEADER_WORDS * DataWord.WORD_SIZE
  return (
    data.length % DataWord.WORD_SIZE === 0 &&
    data.length > headerBytes &&
    (data.length - headerBytes) % (itemWords * DataWord.WORD_SIZE) === 0
  )
}

/**
 * Checks that the gas used remain under the gas limit.
 *
 * @param opts - Precompile input wrapper
 * @param gasUsed - Amount of gas consumed by the precompile
 * @param pName - Human readable precompile name for logging
 * @returns `true` if the gas usage is within the provided limit
 */
export const gasLimitCheck = (opts: PrecompileInput, gasUsed: bigint, pName: string) => {
  if (opts._debug !== undefined) {
    opts._debug(
      `Run ${pName} precompile data=${short(opts.data)} length=${
        opts.data.length
      } gasLimit=${opts.gasLimit} gasUsed=${gasUsed}`,
    )
  }

  if (opts.gasLimit < gasUsed) {
    if (opts._debug !== undefined) {
      opts._debug(`${pName} failed: OOG`)
    }
    return false
  }
  return true
}

/**
 * Checks that the length of the provided data is equal to `length`.
 *
 * @param opts - Precompile input wrapper
 * @param length - Required data length in bytes
 * @param pName - Human readable precompile name for logging
 * @returns `true` if the provided data matches the required length
 */
export const equalityLengthCheck = (opts: PrecompileInput, length: number, pName: string) => {
  if (opts.data.length !== length) {
    if (opts._debug !== undefined) {
      opts._debug(
        `${pName} failed: Invalid input length length=${opts.data.length} (expected: ${length})`,
      )
    }
    return false
  }
  return true
}

/**
 * Checks that the total length of the provided data input can be subdivided into k equal parts
 * with `length` (without leaving some remainder bytes).
 *
 * @param opts - Precompile input wrapper
 * @param length - Required chunk size
 * @param pName - Human readable precompile name for logging
 * @returns `true` if the length is divisible by the chunk size
 */
export const moduloLengthCheck = (opts: PrecompileInput, length: number, pName: string) => {
  if (opts.data.length % length !== 0) {
    if (opts._debug !== undefined) {
      opts._debug(
        `${pName} failed: Invalid input length length=${opts.data.length} (expected: ${length}*k bytes)`,
      )
    }
    return false
  }
  return true
}

function assertArrayElementsAvailable(words: DataWord[], offset: number, count: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    offset >= words.length ||
    count > words.length - offset - 1
  ) {
    throw EthereumJSErrorWithoutCode('ABI array elements exceed calldata bounds')
  }
}

export function extractBytes32Array(words: DataWord[], offset: number, count: number): Buffer[] {
  if (count === 0) {
    return []
  }
  assertArrayElementsAvailable(words, offset, count)
  const result = new Array(count)
  for (let i = 0; i < count; ++i) {
    result[i] = words[offset + i + 1].data
  }
  return result
}

export function extractArrayLength(words: DataWord[], offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw EthereumJSErrorWithoutCode('ABI array offset is not word-aligned')
  }
  if (offset > words.length - 1) {
    return 0
  }
  return words[offset].intValueSafe()
}

/**
 * Extracts ABI-encoded signatures using TRON's fixed 65-byte signature length.
 *
 * The ABI bytes length word is intentionally ignored. It is caller-controlled and must not be
 * used as an allocation size. This matches java-tron's `extractSigArray` behavior.
 * The caller must pass a count which has already been checked against the precompile's limit.
 */
export function extractSigArray(
  words: DataWord[],
  offset: number,
  count: number,
  data: Uint8Array,
): Uint8Array[] {
  if (count === 0) {
    return []
  }
  assertArrayElementsAvailable(words, offset, count)
  const result = new Array<Uint8Array>(count)
  for (let i = 0; i < count; ++i) {
    const bytesOffset = words[offset + i + 1].intValueSafe() / DataWord.WORD_SIZE
    if (!Number.isSafeInteger(bytesOffset) || offset + bytesOffset + 1 >= words.length) {
      throw EthereumJSErrorWithoutCode('ABI signature offset exceeds calldata bounds')
    }
    const bytes = new Uint8Array(SIGNATURE_LENGTH)
    const start = (bytesOffset + offset + 2) * DataWord.WORD_SIZE
    const end = start + SIGNATURE_LENGTH
    bytes.set(data.subarray(start, end), 0)
    result[i] = bytes
  }
  return result
}

export function recoverAddrBySign(sign: Uint8Array, hash: Uint8Array) {
  const r = sign.slice(0, 32)
  const s = sign.slice(32, 64)
  let v = sign[64]

  if (v < 27) {
    v += 27
  }

  try {
    const publicKey = ecrecover(hash, BigInt(v), r, s)
    return publicToAddress(publicKey)
  } catch {
    return new Uint8Array(0)
  }
}

export function convertToTronAddress(address: Uint8Array): Uint8Array {
  if (address.length === 20) {
    const newAddress = new Uint8Array(21)
    // 0xa0 is no longer used
    // newAddress[0] = isMainnet() ? 0x41 : 0xa0
    newAddress[0] = 0x41
    newAddress.set(address, 1)
    return newAddress
  }
  return address
}

export function isMainnet(): boolean {
  // return process.env.IS_TESTNET !== '1'
  return true
}
