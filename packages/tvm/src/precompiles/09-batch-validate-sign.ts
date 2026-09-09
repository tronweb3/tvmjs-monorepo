import { TVMError } from '../errors.ts'
import { OOGResult } from '../tvm.ts'
import type { ExecResult } from '../types.ts'
import { DataWord } from './dataWord.ts'
import type { PrecompileInput } from './types.ts'
import {
  extractArrayLength,
  extractBytes32Array,
  extractSigArray,
  isTronOsakaEnabled,
  isValidTronSignatureCalldata,
  recoverAddrBySign,
} from './util.ts'

export function precompile09(opts: PrecompileInput): ExecResult {
  const data = opts.data

  const ENGERYPERSIGN = opts.common.param('batchvalidatesignGas')
  const MAX_SIZE = 16
  const cnt = Math.max(Math.floor((Math.floor(data.length / DataWord.WORD_SIZE) - 5) / 6), 0)
  const gasUsed = BigInt(cnt) * BigInt(ENGERYPERSIGN)

  if (isTronOsakaEnabled(opts) && !isValidTronSignatureCalldata(data, 6)) {
    return OOGResult(opts.gasLimit)
  }

  if (opts.gasLimit < gasUsed) {
    return OOGResult(opts.gasLimit)
  }
  try {
    const words = DataWord.parseArray(data)

    const hash = words[0].data
    const returnValue = new Uint8Array(DataWord.WORD_SIZE)

    const signaturesOffset = words[1].intValueSafe() / DataWord.WORD_SIZE
    const signatureCount = extractArrayLength(words, signaturesOffset)
    if (signatureCount === 0 || signatureCount > MAX_SIZE) {
      return {
        executionGasUsed: gasUsed,
        returnValue,
      }
    }

    const addressesOffset = words[2].intValueSafe() / DataWord.WORD_SIZE
    const addressCount = extractArrayLength(words, addressesOffset)
    if (signatureCount !== addressCount) {
      return {
        executionGasUsed: gasUsed,
        returnValue,
      }
    }

    const signatures = extractSigArray(words, signaturesOffset, signatureCount, data)
    const addresses = extractBytes32Array(words, addressesOffset, addressCount)

    for (let i = 0; i < signatureCount; ++i) {
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
  } catch {
    return {
      executionGasUsed: opts.gasLimit,
      returnValue: new Uint8Array(),
      exceptionError: new TVMError(TVMError.errorMessages.UNKNOWN),
    }
  }
}
