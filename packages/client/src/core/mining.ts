import type { BlockRecord, TronTxRecord } from './blockStore.ts'
import type { NodeCore } from './node.ts'

/** A protocol rejection drops one queued transaction, not the rest of its block. */
export class TransactionRejectedError extends Error {}

export class DuplicateTransactionError extends TransactionRejectedError {}

/** Outcome of a failed attempt to drain the queue and enable instant mining. */
export interface BlockTimeChangeErrorData {
  requestedBlockTime: 0
  activeBlockTime: number
  committedTransactionIds: string[]
  pendingTransactionIds: string[]
}

/** The mining mode is unchanged, but earlier transactions may have committed. */
export class BlockTimeChangeError extends Error {
  readonly data: BlockTimeChangeErrorData
  readonly cause: unknown

  constructor(data: BlockTimeChangeErrorData, cause: unknown) {
    super(
      `Block time change to 0 failed; ${data.committedTransactionIds.length} transaction(s) committed, ${data.pendingTransactionIds.length} pending; block time remains ${data.activeBlockTime}s: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'BlockTimeChangeError'
    this.data = data
    this.cause = cause
  }
}

/** Admission previews execution; mining re-executes and assigns the final block and receipt. */
export interface PendingTransaction {
  txid: string
  execute(node: NodeCore): Promise<{
    record: TronTxRecord
    merkleLeaf: string
    finalize(block: BlockRecord): void
  }>
}
