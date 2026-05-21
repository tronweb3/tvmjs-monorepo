import { bytesToHex } from '@tvmjs/util'

import { TVMError } from '../errors.ts'
import type { TVM } from '../tvm.ts'
import { OOGResult, TVMErrorResult } from '../tvm.ts'

import {
  BLS_GAS_DISCOUNT_PAIRS_G2,
  leading16ZeroBytesCheck,
  msmGasUsed,
} from './bls12_381/index.ts'
import { getPrecompileName } from './index.ts'
import { gasLimitCheck, moduloLengthCheck } from './util.ts'

import type { ExecResult } from '../types.ts'
import type { PrecompileInput } from './types.ts'

export async function precompile0e(opts: PrecompileInput): Promise<ExecResult> {
  const pName = getPrecompileName('10')
  const bls = (opts._TVM as TVM)['_bls']!

  if (opts.data.length === 0) {
    if (opts._debug !== undefined) {
      opts._debug(`${pName} failed: Empty input`)
    }
    return TVMErrorResult(
      new TVMError(TVMError.errorMessages.BLS_12_381_INPUT_EMPTY),
      opts.gasLimit,
    ) // follow Geth's implementation
  }

  const numPairs = Math.floor(opts.data.length / 288)
  const gasUsedPerPair = opts.common.param('bls12381G2MulGas')
  const gasUsed = msmGasUsed(numPairs, gasUsedPerPair, BLS_GAS_DISCOUNT_PAIRS_G2)

  if (!gasLimitCheck(opts, gasUsed, pName)) {
    return OOGResult(opts.gasLimit)
  }

  if (!moduloLengthCheck(opts, 288, pName)) {
    return TVMErrorResult(
      new TVMError(TVMError.errorMessages.BLS_12_381_INVALID_INPUT_LENGTH),
      opts.gasLimit,
    )
  }

  // prepare pairing list and check for mandatory zero bytes
  const zeroByteRanges = [
    [0, 16],
    [64, 80],
    [128, 144],
    [192, 208],
  ]

  for (let k = 0; k < numPairs; k++) {
    // zero bytes check
    const pairStart = 288 * k
    if (!leading16ZeroBytesCheck(opts, zeroByteRanges, pName, pairStart)) {
      return TVMErrorResult(
        new TVMError(TVMError.errorMessages.BLS_12_381_POINT_NOT_ON_CURVE),
        opts.gasLimit,
      )
    }
  }

  let returnValue
  try {
    returnValue = bls.msmG2(opts.data)
  } catch (e: any) {
    if (opts._debug !== undefined) {
      opts._debug(`${pName} failed: ${e.message}`)
    }
    return TVMErrorResult(e, opts.gasLimit)
  }

  if (opts._debug !== undefined) {
    opts._debug(`${pName} return value=${bytesToHex(returnValue)}`)
  }

  return {
    executionGasUsed: gasUsed,
    returnValue,
  }
}
