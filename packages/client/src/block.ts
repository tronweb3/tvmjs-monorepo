import { responseSnapshot } from './response.ts'

import type { BlockRecord } from './core/blockStore.ts'
import type { TransactionInfo, TronTransaction } from './rpc.ts'

/** A mined transaction and its receipt, detached from the node's records. */
export interface NodeTransaction {
  txid: string
  transaction: TronTransaction
  info: TransactionInfo
  blockNumber?: bigint
}

/** Block metadata and transactions, without the execution engine's block object. */
export interface NodeBlock {
  number: bigint
  blockID: string
  parentBlockID: string
  timestampMs: number
  txTrieRoot?: string
  witnessSignature?: string
  txs: NodeTransaction[]
}

export function blockSnapshot(record: BlockRecord): NodeBlock {
  return responseSnapshot(
    {
      number: record.number,
      blockID: record.blockID,
      parentBlockID: record.parentBlockID,
      timestampMs: record.timestampMs,
      txTrieRoot: record.txTrieRoot,
      witnessSignature: record.witnessSignature,
      txs: record.txs.map((tx) => ({
        txid: tx.txid,
        transaction: tx.transaction,
        info: tx.info,
        blockNumber: tx.blockNumber,
      })),
    },
    false,
  ) as NodeBlock
}
