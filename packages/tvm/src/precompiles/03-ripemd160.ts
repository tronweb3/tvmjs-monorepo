import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@tvmjs/util'

import { OOGResult } from '../tvm.ts'

import { getPrecompileName } from './index.ts'
import { gasLimitCheck } from './util.ts'

import type { ExecResult } from '../types.ts'
import type { PrecompileInput } from './types.ts'

// TRON precompile at address 0x03

export function precompile03(opts: PrecompileInput): ExecResult {
  const pName = getPrecompileName('03')
  const data = opts.data

  let gasUsed = opts.common.param('ripemd160Gas')
  gasUsed += opts.common.param('ripemd160WordGas') * BigInt(Math.ceil(data.length / 32))

  if (!gasLimitCheck(opts, gasUsed, pName)) {
    return OOGResult(opts.gasLimit)
  }

  const hash = sha256(sha256(data).slice(0, 20))
  if (opts._debug !== undefined) {
    opts._debug(`${pName} return hash=${bytesToHex(hash)}`)
  }

  return {
    executionGasUsed: gasUsed,
    returnValue: hash,
  }
}
