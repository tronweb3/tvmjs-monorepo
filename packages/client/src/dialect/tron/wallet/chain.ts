import { bytesToHex } from '@tvmjs/util'
import { INT64_MAX, INT64_MIN } from '../../../intBounds.ts'

import { BLOCK_VERSION, witnessFieldOf } from '../../../core/tronBlock.ts'
import {
  HexDecoderError,
  boolParam,
  isVisible,
  mergeColumn,
  toTronHex,
  tryParseTronAddress,
} from '../address.ts'
import { mergeInt64Field } from '../mergeValue.ts'
import { omitDefaults } from '../proto.ts'
import { withVisibleAddresses } from '../visible.ts'
import { formatTransaction } from './print.ts'
import {
  HexDecodeError,
  MergeParseError,
  NumberFormatError,
  PlainError,
  isPostBody,
} from './types.ts'

import type { BlockRecord } from '../../../core/blockStore.ts'
import type { HandlerParams, Registry } from '../../registry.ts'

/** the span both range queries cap at */
const BLOCK_LIMIT_NUM = 100

/**
 * Numeric request fields: an absent
 * field is a null string, anything that is not a decimal integer within the
 * signed 64-bit range fails, and both fail with the parser's own exception.
 */
export function parseLong(value: unknown): bigint {
  if (value === undefined || value === null) throw new NumberFormatError(undefined)
  const raw = String(value)
  if (!/^[+-]?\d+$/.test(raw)) throw new NumberFormatError(raw)
  const parsed = BigInt(raw)
  if (parsed > INT64_MAX || parsed < INT64_MIN) {
    throw new NumberFormatError(raw)
  }
  return parsed
}

/** a bool field in a POST body, where only the two literals are accepted */
export function mergeBool(value: unknown, column: number): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') {
    throw new MergeParseError(`1:${column}: Expected "true" or "false".`)
  }
  return value
}

/** a hex request field, decoded by the lenient hex rules the servlets share */
export function parseHexField(value: unknown): string {
  const raw = String(value ?? '').replace(/^0x/i, '')
  if (raw === '') return ''
  if (!/^[0-9a-fA-F]+$/.test(raw)) throw new HexDecodeError(raw)
  return (raw.length % 2 === 1 ? `0${raw}` : raw).toLowerCase()
}

/**
 * The same field on a servlet that decodes the query string itself: a GET
 * surfaces the decoder's exception, a POST goes through the merge.
 */
export function hexValueField(params: HandlerParams, key: string): string {
  return hexField(params, key, isPostBody(params))
}

/**
 * A `value` field naming an address. Under `visible` the servlet converts
 * base58 to hex before anything else reads the field, so the hex decoder only
 * ever meets hex — and a value that is not base58, hex included, converts to
 * nothing and leaves the field empty.
 *
 * Without `visible` the families part ways: most rebuild the field into a
 * one-field object and merge it, the delegation indexes hand the text straight
 * to the hex decoder on GET only, and the market lookup does so on either verb
 * — each surfacing the decoder's own exception instead of a merge failure.
 */
export function addressValueField(
  params: HandlerParams,
  key: string,
  /** whether the servlet decodes the hex itself instead of merging the field */
  decodesItself: boolean | 'get-only' = false,
): string {
  if (!isVisible(params)) {
    const merged = decodesItself === false || (decodesItself === 'get-only' && isPostBody(params))
    return hexField(params, key, merged)
  }
  const raw = params[key]
  if (typeof raw !== 'string' || !raw.startsWith('T')) return ''
  const address = tryParseTronAddress(raw)
  return address === undefined ? '' : toTronHex(address)
}

function hexField(params: HandlerParams, key: string, merged: boolean): string {
  const value = params[key]
  // an empty list merges nothing at all, so there is no value to judge
  if (Array.isArray(value) && value.length === 0) return ''
  if (merged && value !== undefined && value !== null && typeof value !== 'string') {
    throw new MergeParseError(`1:${mergeColumn(params, key)}: Expected string.`)
  }
  const raw = String(value ?? '').replace(/^0x/i, '')
  if (raw === '') return ''
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    if (!merged) throw new HexDecoderError(raw)
    throw new MergeParseError(`1:${mergeColumn(params, key)}: INVALID hex String`)
  }
  return (raw.length % 2 === 1 ? `0${raw}` : raw).toLowerCase()
}

/** whether a digit string is a height within the signed 64-bit range */
function withinInt64(text: string): boolean {
  const parsed = BigInt(text)
  return parsed <= INT64_MAX && parsed >= INT64_MIN
}

/** `num`, which arrives as a query string on GET and as an int64 on POST */
export function blockNumberOf(params: HandlerParams): bigint {
  return numericField(params, 'num')
}

/** a named numeric field with the same GET/POST split */
export function numericField(params: HandlerParams, name: string): bigint {
  return isPostBody(params)
    ? mergeInt64Field(params, name)
    : parseLong(params[name] as string | undefined)
}

function blockToJSON(record: BlockRecord, detail = true): Record<string, unknown> {
  const json: Record<string, unknown> = {
    blockID: record.blockID,
    block_header: {
      // key order follows the protobuf field order, as a protobuf printer
      // emits it
      raw_data: {
        // TRON block timestamps are milliseconds
        timestamp: record.timestampMs,
        // an empty block reports all zeros
        txTrieRoot: record.txTrieRoot ?? '0'.repeat(64),
        parentHash: record.parentBlockID,
        number: Number(record.number),
        witness_address: witnessFieldOf(record.number),
        // the genesis block predates block versioning and carries none
        ...(record.number === 0n ? {} : { version: BLOCK_VERSION }),
        // block 0 commits to the genesis account state; later blocks leave
        // the field to the account-state-root feature, which is off
        ...(record.number === 0n
          ? { accountStateRoot: bytesToHex(record.block.header.stateRoot).slice(2) }
          : {}),
      },
      // the producer's signature over the raw header hash; the genesis
      // block is not produced by a witness and has none
      ...(record.witnessSignature === undefined
        ? {}
        : { witness_signature: record.witnessSignature }),
    },
  }
  if (detail) {
    json.transactions = record.txs.map((tx) => tx.transaction)
  }
  return json
}

function formatBlock(
  record: BlockRecord,
  detail: boolean,
  visible: boolean,
): Record<string, unknown> {
  const block = blockToJSON(record, detail)
  const formatted = withVisibleAddresses(block, visible)
  if (visible && Array.isArray(block.transactions)) {
    // `formatted` has already walked every transaction. Format each original
    // transaction instead so text fields are converted exactly once.
    formatted.transactions = block.transactions.map((transaction) =>
      formatTransaction(transaction, true),
    )
  }
  return formatted
}

/**
 * A block list is handwritten around proto-printed blocks: the wrapper keeps
 * its array even when empty, while each block inside drops its default values.
 */
function blockListJSON(records: BlockRecord[], visible: boolean): Record<string, unknown> {
  return {
    block: records.map((record) => omitDefaults(formatBlock(record, true, visible))),
  }
}

export function registerChainHandlers(registry: Registry): void {
  registry.register(
    'wallet/getnowblock',
    (node, params) => formatBlock(node.head(), true, isVisible(params)),
    { solidity: true },
  )

  // unified endpoint; callers fetch ref-block params via {detail:false}
  registry.register(
    'wallet/getblock',
    (node, params) => {
      const detail = isPostBody(params)
        ? mergeBool(params.detail, mergeColumn(params, 'detail'))
        : boolParam(params.detail)
      const query =
        Array.isArray(params.id_or_num) && params.id_or_num.length === 0
          ? undefined
          : params.id_or_num
      // a field stated as JSON null carries no value, the same as an absent one
      if (query === undefined || query === null || query === '') {
        return formatBlock(node.head(), detail, isVisible(params))
      }
      // the field is a string in the request message, so a JSON number never
      // reaches the two branches below
      if (isPostBody(params) && typeof query !== 'string') {
        throw new MergeParseError(`1:${mergeColumn(params, 'id_or_num')}: Expected string.`)
      }
      const text = String(query)
      let record: ReturnType<typeof node.blocks.getById>
      // only a height that fits an int64 is read as one; anything longer is
      // left to the hash branch, which then rejects it on length
      if (/^[+-]?\d+$/.test(text) && withinInt64(text)) {
        const num = BigInt(text)
        if (num < 0n) throw new PlainError('num must be non-positive number.')
        record = node.blocks.getByNumber(num)
      } else {
        if (text.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(text)) {
          throw new PlainError('id must be legal block hash.')
        }
        // the first eight bytes of a block id are its height, and one outside
        // the chain names a block that could never exist
        const embedded = BigInt(`0x${text.slice(0, 16)}`)
        if (embedded > node.blocks.height() || embedded < 0n) {
          throw new PlainError('id must be legal block hash.')
        }
        record = node.blocks.getById(text)
      }
      return record === undefined ? {} : formatBlock(record, detail, isVisible(params))
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getblockbynum',
    (node, params) => {
      // an absent height is height zero, the protobuf default
      const num = params.num === undefined ? 0n : blockNumberOf(params)
      const record = node.blocks.getByNumber(num)
      return record === undefined ? {} : formatBlock(record, true, isVisible(params))
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getblockbyid',
    (node, params) => {
      const record = node.blocks.getById(hexValueField(params, 'value'))
      return record === undefined ? {} : formatBlock(record, true, isVisible(params))
    },
    { solidity: true },
  )

  registry.register(
    'wallet/getblockbylimitnext',
    (node, params) => {
      const start = numericField(params, 'startNum')
      const end = numericField(params, 'endNum')
      // outside the accepted span the reply carries no block list at all
      if (!(end > 0n && end > start && end - start <= BigInt(BLOCK_LIMIT_NUM))) {
        return {}
      }
      // a negative start is below every stored key, so the scan finds nothing
      const blocks = start < 0n ? [] : node.blocks.range(start, end)
      return blockListJSON(blocks, isVisible(params))
    },
    { solidity: true, verbatim: true },
  )

  registry.register(
    'wallet/getblockbylatestnum',
    (node, params) => {
      const count = blockNumberOf(params)
      if (!(count > 0n && count < BigInt(BLOCK_LIMIT_NUM))) {
        return {}
      }
      const head = node.blocks.height()
      const start = head - count + 1n
      return blockListJSON(node.blocks.range(start < 0n ? 0n : start, head + 1n), isVisible(params))
    },
    { solidity: true },
  )
}
