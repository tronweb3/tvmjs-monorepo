import { ecrecover, publicToAddress, short } from '@tvmjs/util'

import { DataWord } from './dataWord.ts'
import type { PrecompileInput } from './index.ts'

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

export function extractBytes32Array(words: DataWord[], offset: number): Buffer[] {
  const len = words[offset].intValueSafe()
  const result = new Array(len)
  for (let i = 0; i < len; ++i) {
    result[i] = words[offset + i + 1].data
  }
  return result
}

export function extractBytesArray(
  words: DataWord[],
  offset: number,
  data: Uint8Array,
): Uint8Array[] {
  if (offset > words.length - 1) {
    return []
  }

  const len = words[offset].intValueSafe()
  const result = new Array<Uint8Array>(len)
  for (let i = 0; i < len; ++i) {
    const bytesOffset = words[offset + i + 1].intValueSafe() / DataWord.WORD_SIZE
    const bytesLen = words[offset + bytesOffset + 1].intValueSafe()
    const bytes = new Uint8Array(bytesLen)
    const start = (bytesOffset + offset + 2) * DataWord.WORD_SIZE
    const end = start + bytesLen
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
