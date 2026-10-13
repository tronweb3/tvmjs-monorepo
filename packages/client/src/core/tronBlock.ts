import { createHash } from 'node:crypto'

import { hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'

import { GENESIS_WITNESS_TEXT, WITNESS_ADDRESS, WITNESS_PRIVATE_KEY } from './witness.ts'

/** block header version, bumped with each chain upgrade */
export const BLOCK_VERSION = 36

/** TRON promotes an unpaired Merkle leaf unchanged instead of duplicating it. */
export function transactionMerkleRoot(leaves: string[]): string {
  let level = leaves
  while (level.length > 1) {
    const parents: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1]
      parents.push(
        right === undefined
          ? level[i]
          : createHash('sha256')
              .update(hexToBytes(`0x${level[i]}${right}`))
              .digest('hex'),
      )
    }
    level = parents
  }
  return level[0] ?? '0'.repeat(64)
}

/**
 * A block's identity, TRON-style: the raw header is protobuf-encoded and
 * SHA-256 hashed; the blockID is that hash with its first 8 bytes replaced by
 * the big-endian height, and the witness signature is ECDSA over the same
 * hash, its last byte the raw recovery id.
 */
export interface TronRawHeader {
  timestampMs: number
  /** 64 hex chars; an empty block carries all zeros */
  txTrieRoot: string
  /** 64 hex chars */
  parentHash: string
  number: bigint
  /** hex bytes: a 21-byte address, or the founding sentence on block 0 */
  witnessAddress: string
  /** absent on block 0, which predates block versioning */
  version?: number
  /** 64 hex chars; only block 0 carries it, committing to the genesis state */
  accountStateRoot?: string
}

const varint = (raw: bigint): number[] => {
  let held = raw < 0n ? raw + (1n << 64n) : raw
  const out: number[] = []
  for (;;) {
    const low = Number(held & 0x7fn)
    held >>= 7n
    if (held === 0n) {
      out.push(low)
      return out
    }
    out.push(low | 0x80)
  }
}

const key = (field: number, wire: number): number[] => varint(BigInt(field * 8 + wire))

const lenDelim = (field: number, bytes: Uint8Array): number[] => [
  ...key(field, 2),
  ...varint(BigInt(bytes.length)),
  ...bytes,
]

const bytesOf = (hex: string): Uint8Array => hexToBytes(`0x${hex}`)

/**
 * `BlockHeader.raw` wire bytes: timestamp(1), txTrieRoot(2), parentHash(3),
 * number(7), witness_address(9), version(10), accountStateRoot(11) — defaults
 * omitted, the proto3 way.
 */
export function encodeRawHeader(header: TronRawHeader): Uint8Array {
  const bytes: number[] = []
  if (header.timestampMs !== 0) bytes.push(...key(1, 0), ...varint(BigInt(header.timestampMs)))
  bytes.push(...lenDelim(2, bytesOf(header.txTrieRoot)))
  bytes.push(...lenDelim(3, bytesOf(header.parentHash)))
  if (header.number !== 0n) bytes.push(...key(7, 0), ...varint(header.number))
  bytes.push(...lenDelim(9, bytesOf(header.witnessAddress)))
  if (header.version !== undefined && header.version !== 0) {
    bytes.push(...key(10, 0), ...varint(BigInt(header.version)))
  }
  if (header.accountStateRoot !== undefined) {
    bytes.push(...lenDelim(11, bytesOf(header.accountStateRoot)))
  }
  return new Uint8Array(bytes)
}

/** SHA-256 of the raw header bytes — the preimage of both id and signature */
export function rawHeaderHash(header: TronRawHeader): Uint8Array {
  return createHash('sha256').update(encodeRawHeader(header)).digest()
}

/**
 * The producer's signature over the raw hash: 65 bytes r‖s‖v with v as the
 * raw recovery id, the way headers carry it on the wire.
 */
export function signBlockHash(rawHash: Uint8Array): string {
  const signature = utils.crypto.ECKeySign([...rawHash], [...bytesOf(WITNESS_PRIVATE_KEY)])
  const v = Number.parseInt(signature.slice(128), 16)
  return `${signature.slice(0, 128)}${(v >= 27 ? v - 27 : v).toString(16).padStart(2, '0')}`.toLowerCase()
}

/** the header's witness field: the address, or the founding text on block 0 */
export function witnessFieldOf(number: bigint): string {
  return number === 0n ? TronWeb.fromUtf8(GENESIS_WITNESS_TEXT).replace(/^0x/, '') : WITNESS_ADDRESS
}
