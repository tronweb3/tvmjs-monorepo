import { EOFContainer, validateEOF } from './eof/container.ts'
import { TVMError } from './errors.ts'
import { Message } from './message.ts'
import { getOpcodesForHF } from './opcodes/index.ts'
import {
  type AddPrecompile,
  type CustomPrecompile,
  type DeletePrecompile,
  MCLBLS,
  NobleBLS,
  NobleBN254,
  type PrecompileFunc,
  type PrecompileInput,
  RustBN254,
  getActivePrecompiles,
} from './precompiles/index.ts'
import { TVM } from './tvm.ts'
import { TVMMockBlockchain } from './types.ts'

import type { InterpreterStep } from './interpreter.ts'
import type {
  ExecResult,
  Log,
  SelfdestructMap,
  TVMBLSInterface,
  TVMBN254Interface,
  TVMInterface,
  TVMMockBlockchainInterface,
  TVMOpts,
  TVMResult,
  TVMRunCallOpts,
  TVMRunCodeOpts,
} from './types.ts'
export * from './logger.ts'

export type {
  AddPrecompile,
  CustomPrecompile,
  DeletePrecompile,
  TVMBLSInterface,
  TVMBN254Interface,
  TVMInterface,
  TVMMockBlockchainInterface,
  TVMOpts,
  TVMResult,
  TVMRunCallOpts,
  TVMRunCodeOpts,
  ExecResult,
  InterpreterStep,
  Log,
  SelfdestructMap,
  PrecompileFunc,
  PrecompileInput,
}

export {
  EOFContainer,
  TVM,
  TVMError,
  TVMMockBlockchain,
  getActivePrecompiles,
  getOpcodesForHF,
  MCLBLS,
  Message,
  NobleBLS,
  NobleBN254,
  RustBN254,
  validateEOF,
}

export * from './binaryTreeAccessWitness.ts'
export * from './constructors.ts'
export * from './eip7708.ts'
export * from './params.ts'
