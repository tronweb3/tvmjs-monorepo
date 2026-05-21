import type { Common } from '@tvmjs/common'
import type { debug } from 'debug'
import type { ExecResult, TVMInterface } from '../types.ts'

export interface PrecompileFunc {
  (input: PrecompileInput): Promise<ExecResult> | ExecResult
}

export interface PrecompileInput {
  data: Uint8Array
  gasLimit: bigint
  common: Common
  _TVM: TVMInterface
  _debug?: debug.Debugger
}
