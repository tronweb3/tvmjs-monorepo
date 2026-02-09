import { OOGResult } from '../evm.ts'
import type { ExecResult } from '../types.ts'
import { DataWord } from './dataWord.ts'
import type { PrecompileInput } from './types.ts'
import { extractBytes32Array, extractBytesArray, recoverAddrBySign } from './util.ts'

export function precompile09(opts: PrecompileInput): ExecResult {
  const data = opts.data

  const ENGERYPERSIGN = opts.common.param('batchvalidatesignGas')
  const MAX_SIZE = 16
  const cnt = Math.floor((Math.floor(data.length / DataWord.WORD_SIZE) - 5) / 6)
  const gasUsed = BigInt(cnt) * BigInt(ENGERYPERSIGN)

  if (opts.gasLimit < gasUsed) {
    return OOGResult(opts.gasLimit)
  }

  const words = DataWord.parseArray(data)

  const hash = words[0].data

  const signatures = extractBytesArray(words, words[1].intValueSafe() / DataWord.WORD_SIZE, data)
  const addresses = extractBytes32Array(words, words[2].intValueSafe() / DataWord.WORD_SIZE)

  // check length
  const length = signatures.length
  const returnValue = new Uint8Array(DataWord.WORD_SIZE)
  if (length === 0 || length > MAX_SIZE || length !== addresses.length) {
    return {
      executionGasUsed: gasUsed,
      returnValue,
    }
  }

  for (let i = 0; i < length; ++i) {
    const address = addresses[i]
    const recoveredAddr = recoverAddrBySign(signatures[i], hash)
    if (DataWord.equalAddressByteArray(address, recoveredAddr)) {
      returnValue[i] = 1
    }
  }

  return {
    executionGasUsed: gasUsed,
    returnValue,
  }
}
