import type { Block } from '@tvmjs/block'
import type { ExecResult } from '@tvmjs/tvm'
import { EthereumJSErrorWithoutCode } from '@tvmjs/util'
import type { Address } from '@tvmjs/util'
import type { VM } from '@tvmjs/vm'
import { TRON_VM_GAS_PRICE } from '../chainParameters.ts'
import type { WriteParams } from './node.ts'

/** Inputs fixed at execution time, before VM writes or energy billing. */
export interface TransactionExecution {
  params: WriteParams
  stateRoot: Uint8Array
  block: Block
  gasLimit: bigint
}

/** Shared VM execution for block production and isolated historical replay. */
export async function executeTransaction(
  vm: VM,
  { params, block, gasLimit }: TransactionExecution,
): Promise<{ execResult: ExecResult; createdAddress?: Address }> {
  try {
    if (params.create === true) {
      if (params.deployAddress === undefined) {
        throw EthereumJSErrorWithoutCode('create requires a pre-computed deployAddress')
      }
    }
    const result = await vm.tvm.runCall({
      rootTransactionId: params.rootTransactionId,
      block,
      caller: params.caller,
      origin: params.caller,
      value: params.value ?? 0n,
      gasLimit,
      gasPrice: TRON_VM_GAS_PRICE,
      ...(params.create === true
        ? {
            data: params.data,
          }
        : {
            to: params.to,
            data: params.data,
            ...(params.plainTransfer === true ? { code: new Uint8Array() } : {}),
          }),
      ...(params.tokenId !== undefined && params.tokenId > 0n
        ? { tokenId: params.tokenId, tokenValue: params.tokenValue ?? 0n }
        : {}),
    })
    if (
      params.create === true &&
      result.execResult.exceptionError === undefined &&
      (result.createdAddress === undefined || !result.createdAddress.equals(params.deployAddress!))
    ) {
      throw EthereumJSErrorWithoutCode('TRON deployment address derivation mismatch')
    }
    return result
  } finally {
    // Access warmth belongs to this transaction, including deployment copies.
    await vm.tvm.journal.cleanup()
  }
}
