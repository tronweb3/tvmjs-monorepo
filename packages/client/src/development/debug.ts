import { bytesToHex, hexToBytes, setLengthLeft } from '@tvmjs/util'
import { utils } from 'tronweb'

import { executeTransaction } from '../core/execution.ts'
import { decodeAddress, scalarText } from '../dialect/tre/decode.ts'
import { toTronHex } from '../dialect/tron/address.ts'
import { parseBytes, parseInteger } from '../input.ts'
import { InvalidParamsError } from '../provider.ts'

import type { InterpreterStep } from '@tvmjs/tvm'
import type { Address } from '@tvmjs/util'
import type { TronTxRecord } from '../core/blockStore.ts'
import type { NodeCore } from '../core/node.ts'

export interface TransactionTrace {
  failed: boolean
  gas: string
  structLogs: StructLog[]
  returnValue: string
}

export interface StorageRange {
  storage: Record<string, { key: string; value: string }>
  nextKey: string | null
}

/** Transaction replay and current-state storage inspection. */
export interface DebugApi {
  /** Trace a 32-byte transaction ID, with or without a 0x prefix. */
  traceTransaction(txid: string): Promise<TransactionTrace>
  storageRangeAt(
    block: string | number | bigint | null,
    txIndex: number,
    address: string,
    startKey: string | null,
    limit: number,
  ): Promise<StorageRange>
}

function padHex64(value: bigint): string {
  return value.toString(16).padStart(64, '0')
}

function gasWord(value: bigint): string {
  return `0x${value.toString(16).padStart(16, '0')}`
}

function bareHex(bytes: Uint8Array): string {
  return bytesToHex(bytes).slice(2)
}

/**
 * The key one storage row is filed under: the first half of the account hash,
 * then the low half of the slot. Two slots agreeing on their low 16 bytes name
 * the same row.
 */
function storageRowKey(address: Address, slot: Uint8Array): Uint8Array {
  const accountHash = hexToBytes(
    utils.ethersUtils.keccak256(hexToBytes(`0x${toTronHex(address)}`)) as `0x${string}`,
  )
  const row = new Uint8Array(32)
  row.set(accountHash.subarray(0, 16), 0)
  row.set(slot.subarray(16, 32), 16)
  return row
}

/** byte order: unsigned, digit by digit, and a prefix sorts before what extends it */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * Where a storage range begins: the row key to start from, in hex with the
 * `0x` optional. Absent reads as the beginning, and a value shorter than a
 * whole key still orders against one.
 */
function startKeyOf(value: unknown): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined
  const text = scalarText(value)
  if (text === undefined) throw new InvalidParamsError('hex decode error')
  const body = text.startsWith('0x') ? text.slice(2) : text
  if (body === '') return undefined
  if (!/^[0-9a-fA-F]+$/.test(body)) throw new InvalidParamsError('hex decode error')
  return hexToBytes(`0x${body.length % 2 === 0 ? body : `0${body}`}`)
}

/**
 * Whether a block reference names the current state: nothing, `latest`, zero in
 * any spelling, the head's number (decimal, or hex with 0x) or the head's id.
 */
export function isCurrentRef(node: NodeCore, ref: unknown): boolean {
  if (ref === undefined || ref === null || ref === '') return true
  if (typeof ref === 'number' || typeof ref === 'bigint') {
    return (
      (typeof ref === 'bigint' || Number.isSafeInteger(ref)) &&
      (BigInt(ref) === 0n || BigInt(ref) === node.head().number)
    )
  }
  if (typeof ref !== 'string') return false
  if (ref.toLowerCase() === 'latest') return true
  const text = ref.trim()
  if (/^\d+$/.test(text)) return BigInt(text) === 0n || BigInt(text) === node.head().number
  const hex = text.replace(/^0x/i, '').toLowerCase()
  if (/^[0-9a-f]{64}$/.test(hex)) return hex === node.head().blockID
  if (/^0x[0-9a-f]+$/i.test(text)) return BigInt(text) === 0n || BigInt(text) === node.head().number
  return false
}

export function transactionHash(value: unknown): string {
  const bytes = parseBytes(value, 'txid')
  if (bytes.length !== 32) throw new RangeError('txid must hold 32 bytes')
  return bytesToHex(bytes)
}

export function blockReference(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'latest' || /^(?:0x)?[0-9a-f]{64}$/i.test(value)) return value
  }
  return parseInteger(value, 'block').toString()
}

export interface StructLog {
  depth: number
  error: string
  gas: string
  gasCost: number
  memory: string[]
  op: string
  pc: number
  stack: string[]
  storage: Record<string, string>
}

/** TRON CALL steps reserve the forwarded budget; value stipends are added afterwards. */
function traceGasCost(step: InterpreterStep): number {
  const overhead = step.opcode.dynamicFee ?? BigInt(step.opcode.fee)
  switch (step.opcode.name) {
    case 'CALL':
    case 'CALLCODE':
    case 'DELEGATECALL':
    case 'STATICCALL':
    case 'CALLTOKEN': {
      const available = step.gasLeft > overhead ? step.gasLeft - overhead : 0n
      const requested = step.stack[step.stack.length - 1] ?? 0n
      return Number(overhead + (requested < available ? requested : available))
    }
    default:
      return Number(overhead)
  }
}

/**
 * Replay on this transaction's pre-execution state, including earlier writes
 * in the same block, collecting structLogs from interpreter step events.
 */
async function traceTransaction(node: NodeCore, record: TronTxRecord): Promise<TransactionTrace> {
  if (record.blockNumber === undefined) {
    throw new Error('transaction has no block assigned')
  }
  const execution = record.execution
  if (execution === undefined) {
    throw new Error('transaction did not execute in the VM, no trace available')
  }

  const vmCopy = await node.vm.shallowCopy()
  await vmCopy.stateManager.setStateRoot(execution.stateRoot)

  const structLogs: StructLog[] = []
  let touched = new Map<string, Set<string>>()
  const checkpoints: (typeof touched)[] = []
  vmCopy.tvm.events?.on('beforeMessage', () => {
    checkpoints.push(new Map([...touched].map(([address, slots]) => [address, new Set(slots)])))
  })
  vmCopy.tvm.events?.on('afterMessage', (result) => {
    const previous = checkpoints.pop()!
    if (result.execResult.exceptionError !== undefined) touched = previous
  })
  let captureError: unknown
  const captureStep = async (step: InterpreterStep): Promise<void> => {
    const address = step.address.toString()
    const slots = touched.get(address) ?? new Set<string>()
    touched.set(address, slots)
    const storage: Record<string, string> = {}
    for (const slot of slots) {
      const value = await step.stateManager.getStorage(step.address, hexToBytes(`0x${slot}`))
      storage[slot] = bareHex(setLengthLeft(value, 32))
    }
    const memory: string[] = []
    for (let i = 0; i < step.memory.length; i += 32) {
      memory.push(bytesToHex(step.memory.subarray(i, i + 32)).slice(2))
    }
    structLogs.push({
      depth: step.depth + 1,
      error: '',
      gas: gasWord(step.gasLeft),
      gasCost: traceGasCost(step),
      memory,
      op: step.opcode.name,
      pc: step.pc,
      stack: step.stack.map(padHex64),
      storage,
    })
    // The current opcode has not executed yet; its slot belongs to subsequent snapshots.
    if (step.opcode.name === 'SLOAD' || step.opcode.name === 'SSTORE') {
      const slot = step.stack[step.stack.length - 1]
      if (slot !== undefined) {
        const key = padHex64(slot)
        // Reading an absent row does not populate the storage cache; explicit writes do.
        if (
          step.opcode.name === 'SSTORE' ||
          (await step.stateManager.getStorage(step.address, hexToBytes(`0x${key}`))).length > 0
        ) {
          slots.add(key)
        }
      }
    }
  }
  vmCopy.tvm.events?.on('step', (step, resolve) => {
    // The VM awaits callbacks, not returned promises. Always release the event on failure.
    void captureStep(step)
      .catch((error: unknown) => {
        captureError ??= error
      })
      .finally(resolve)
  })

  const { execResult } = await executeTransaction(vmCopy, execution)
  if (captureError !== undefined) throw captureError

  return {
    failed: execResult.exceptionError !== undefined,
    gas: gasWord(execResult.executionGasUsed),
    structLogs,
    returnValue: bytesToHex(execResult.returnValue).slice(2),
  }
}

export function createDebugApi(node: NodeCore): DebugApi {
  return {
    traceTransaction: (txid) =>
      node.withWriteLock(async () => {
        const id = transactionHash(txid).slice(2)
        const record = node.txs.get(id)
        if (record === undefined) throw new Error(`transaction ${id} not found`)
        return traceTransaction(node, record)
      }),
    storageRangeAt: (ref, txIndex, account, startKey, limit) =>
      node.withWriteLock(async () => {
        parseInteger(txIndex, 'txIndex', { max: 0n })
        if (!isCurrentRef(node, blockReference(ref))) {
          throw new InvalidParamsError('only the latest/current state is supported')
        }
        const address = decodeAddress(account)
        const count = Number(
          parseInteger(limit, 'limit', { min: 1n, max: BigInt(Number.MAX_SAFE_INTEGER) }),
        )
        const start = startKeyOf(startKey)
        const rows = (await node.storageEntries(address))
          .map((entry) => ({
            key: storageRowKey(address, entry.slot),
            value: setLengthLeft(entry.value, 32),
          }))
          .sort((a, b) => compareBytes(a.key, b.key))

        const storage: StorageRange['storage'] = {}
        let nextKey: string | null = null
        let taken = 0
        for (const row of rows) {
          if (start !== undefined && compareBytes(row.key, start) < 0) continue
          if (taken >= count) {
            nextKey = bareHex(row.key)
            break
          }
          const key = bareHex(row.key)
          storage[key] = { key, value: bareHex(row.value) }
          taken++
        }
        return { storage, nextKey }
      }),
  }
}
