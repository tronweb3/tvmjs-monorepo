import { bigIntToBytes, bytesToHex, concatBytes, hexToBytes, setLengthLeft } from '@tvmjs/util'

import { BLOCK_VERSION, rawHeaderHash, signBlockHash, witnessFieldOf } from './tronBlock.ts'

import type { Block } from '@tvmjs/block'
import type { TVMMockBlockchainInterface } from '@tvmjs/tvm'
import type { TransactionExecution } from './execution.ts'

export interface TronTxRecord {
  /** 64-char hex, no 0x */
  txid: string
  /** transaction JSON as returned by gettransactionbyid / embedded in block responses */
  transaction: unknown
  /** TransactionInfo JSON as returned by gettransactioninfobyid */
  info: unknown
  /** block the tx was sealed into (set at seal time; used by trace replay) */
  blockNumber?: bigint
  /** Historical VM inputs; state-only system contracts have no VM execution. */
  execution?: TransactionExecution
}

export interface BlockRecord {
  number: bigint
  /** TRON-style block id (64 hex chars, no 0x), see {@link toBlockID} */
  blockID: string
  parentBlockID: string
  /** TRON block timestamps are in milliseconds */
  timestampMs: number
  /**
   * TRON txTrieRoot: sha256-merkle root over the full signed transactions
   * (64 hex, no 0x). Handed in at seal time so the block id commits to it;
   * absent means an empty block, which reports as all zeros.
   */
  txTrieRoot?: string
  /**
   * The producer's ECDSA signature over the raw header hash (65 bytes hex,
   * raw recovery id last). The genesis block is not produced and has none.
   */
  witnessSignature?: string
  block: Block
  txs: TronTxRecord[]
}

/** what a block id and signature are computed over */
export function rawHeaderOf(record: {
  number: bigint
  timestampMs: number
  txTrieRoot?: string
  parentBlockID: string
  accountStateRoot?: string
}): Parameters<typeof rawHeaderHash>[0] {
  return {
    timestampMs: record.timestampMs,
    txTrieRoot: record.txTrieRoot ?? '0'.repeat(64),
    parentHash: record.parentBlockID,
    number: record.number,
    witnessAddress: witnessFieldOf(record.number),
    ...(record.number === 0n ? {} : { version: BLOCK_VERSION }),
    ...(record.accountStateRoot === undefined ? {} : { accountStateRoot: record.accountStateRoot }),
  }
}

const GENESIS_PARENT_ID = '0'.repeat(64)

/** VM history reads use the same TRON block IDs as the wallet queries. */
export class BlockStoreBlockchain implements TVMMockBlockchainInterface {
  private readonly blocks: BlockStore
  private readonly height?: bigint

  constructor(blocks: BlockStore, height?: bigint) {
    this.blocks = blocks
    this.height = height
  }

  async getBlock(number: number) {
    const height = BigInt(number)
    const record =
      height <= (this.height ?? this.blocks.height()) ? this.blocks.getByNumber(height) : undefined
    if (record === undefined) throw new Error(`Block ${number} is not in the committed history`)
    const id = record.blockID
    return { hash: () => hexToBytes(`0x${id}`) }
  }

  async putBlock(): Promise<void> {
    throw new Error('Publish client blocks through BlockStore.put')
  }

  shallowCopy(): BlockStoreBlockchain {
    // Committed history is immutable; a copy fixes its upper bound without duplicating it.
    return new BlockStoreBlockchain(this.blocks, this.height ?? this.blocks.height())
  }
}

/**
 * TRON blockID convention: the first 8 bytes carry the big-endian block height,
 * the remaining 24 bytes come from the raw header's SHA-256. Clients derive
 * ref_block_hash from blockID bytes 8..16 (hex chars 16..32), which this
 * layout satisfies.
 */
export function toBlockID(number: bigint, hash: Uint8Array): string {
  const prefix = setLengthLeft(bigIntToBytes(number), 8)
  return bytesToHex(concatBytes(prefix, hash.subarray(8))).slice(2)
}

export class BlockStore {
  private byNumber: Map<bigint, BlockRecord> = new Map()
  private byId: Map<string, BlockRecord> = new Map()
  private headNumber: bigint = -1n

  put(block: Block, txs: TronTxRecord[], timestampMs: number, txTrieRoot?: string): BlockRecord {
    const number = block.header.number
    const parent = this.byNumber.get(number - 1n)
    const parentBlockID = parent?.blockID ?? GENESIS_PARENT_ID
    // block 0 commits to the genesis state through accountStateRoot, so the
    // chain id derived from its blockID is a property of the account set
    const accountStateRoot = number === 0n ? bytesToHex(block.header.stateRoot).slice(2) : undefined
    const rawHash = rawHeaderHash(
      rawHeaderOf({ number, timestampMs, txTrieRoot, parentBlockID, accountStateRoot }),
    )
    const record: BlockRecord = {
      number,
      blockID: toBlockID(number, rawHash),
      parentBlockID,
      timestampMs,
      ...(txTrieRoot === undefined ? {} : { txTrieRoot }),
      ...(number === 0n ? {} : { witnessSignature: signBlockHash(rawHash) }),
      block,
      txs,
    }
    this.byNumber.set(number, record)
    this.byId.set(record.blockID, record)
    if (number > this.headNumber) {
      this.headNumber = number
    }
    return record
  }

  /** take back the most recent block, leaving the store at its parent */
  drop(number: bigint): void {
    const record = this.byNumber.get(number)
    if (record === undefined) return
    this.byNumber.delete(number)
    this.byId.delete(record.blockID)
    if (this.headNumber === number) {
      this.headNumber = number - 1n
    }
  }

  head(): BlockRecord {
    const record = this.byNumber.get(this.headNumber)
    if (record === undefined) {
      throw new Error('block store is empty (genesis not sealed yet)')
    }
    return record
  }

  height(): bigint {
    return this.headNumber
  }

  getByNumber(number: bigint): BlockRecord | undefined {
    return this.byNumber.get(number)
  }

  getById(blockID: string): BlockRecord | undefined {
    return this.byId.get(blockID.toLowerCase())
  }

  /** blocks in [start, end), capped at the current head */
  range(start: bigint, end: bigint): BlockRecord[] {
    const records: BlockRecord[] = []
    for (let n = start < 0n ? 0n : start; n < end; n++) {
      const record = this.byNumber.get(n)
      if (record === undefined) break
      records.push(record)
    }
    return records
  }
}
