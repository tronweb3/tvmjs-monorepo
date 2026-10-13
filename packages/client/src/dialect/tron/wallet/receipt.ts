import { bytesToHex, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'

import { toTronHex } from '../address.ts'

import type { BlockRecord } from '../../../core/blockStore.ts'
import type { InternalCall, WriteResult } from '../../../core/node.ts'
import type { SignedTronTx } from './types.ts'

/**
 * The `contractResult` value a failed frame reports. The VM's own error text is
 * the only signal available, so each recognised condition maps to the enum
 * member naming it; anything unrecognised stays `UNKNOWN`.
 */
export function contractRetOf(result: WriteResult): string {
  if (!result.reverted) return 'SUCCESS'
  const error = String(result.execResult.exceptionError?.error ?? '').toLowerCase()
  if (error.includes('revert')) return 'REVERT'
  if (error.includes('out of gas')) return 'OUT_OF_ENERGY'
  if (error.includes('invalid jump')) return 'BAD_JUMP_DESTINATION'
  if (error.includes('out of range') || error.includes('memory')) return 'OUT_OF_MEMORY'
  if (error.includes('stack underflow')) return 'STACK_TOO_SMALL'
  if (error.includes('stack overflow')) return 'STACK_TOO_LARGE'
  if (error.includes('invalid bytecode')) return 'INVALID_CODE'
  if (error.includes('invalid opcode') || error.includes('undefined opcode')) {
    return 'ILLEGAL_OPERATION'
  }
  // the value-movement failures the VM raises around CALL / CREATE
  if (
    error.includes('transfer trx failed') ||
    error.includes('transfer trc10 failed') ||
    error.includes('insufficient balance') ||
    error.includes('insufficient token balance') ||
    error.includes('invalid token id')
  ) {
    return 'TRANSFER_FAILED'
  }
  // anything unrecognised stays unnamed
  return 'UNKNOWN'
}

/**
 * The runtime error a failed frame reports. REVERT has fixed wording; anything
 * else names the condition that stopped execution.
 */
export function runtimeErrorText(result: {
  execResult: { exceptionError?: { error?: string } }
}): string {
  const error = String(result.execResult.exceptionError?.error ?? '')
  if (error === '') return 'REVERT opcode executed'
  return error.includes('revert') ? 'REVERT opcode executed' : error
}

/**
 * Map an execution outcome to TransactionInfo (gettransactioninfobyid shape).
 * `bandwidthOnly` marks tx families that never touch the VM (plain transfers,
 * TRC-10 actuators) — their receipts carry no energy fields.
 */
export function buildTransactionInfo(
  tx: SignedTronTx,
  result: WriteResult,
  blockRecord: BlockRecord,
  bandwidthOnly: boolean,
): Record<string, unknown> {
  // bandwidth billing: free quota shows as net_usage, burned TRX as net_fee —
  // the receipt carries one or the other, never both
  const netFeeSun = result.netFeeSun ?? 0n
  // the memo charge is folded into the total; ResourceReceipt has no field
  // of its own for it
  const memoFeeSun = result.memoFeeSun ?? 0n
  // like the memo charge, this one has no ResourceReceipt field of its own and
  // only shows up in the total
  const multiSignFeeSun = result.multiSignFeeSun ?? 0n
  // ResourceReceipt in proto field order; energy drawn from the caller's
  // stake shows as energy_usage, the burned remainder as energy_fee
  const receipt: Record<string, unknown> = {}
  if (!bandwidthOnly) {
    const fromStake = result.energyFromStake ?? 0n
    if (fromStake > 0n) {
      receipt.energy_usage = fromStake
    }
    receipt.energy_fee = result.energyFeeSun
    const originUsage = result.originEnergyUsage ?? 0n
    if (originUsage > 0n) {
      receipt.origin_energy_usage = originUsage
    }
    receipt.energy_usage_total = result.energyUsed
  }
  if (netFeeSun > 0n) {
    receipt.net_fee = netFeeSun
  } else if (result.netUsage !== undefined) {
    receipt.net_usage = result.netUsage
  }
  if (!bandwidthOnly) {
    receipt.result = contractRetOf(result)
  }

  const info: Record<string, unknown> = {
    id: tx.txID,
    // total fee = energy fee + burned bandwidth fee + chain fees
    fee:
      result.energyFeeSun + netFeeSun + (result.extraFeeSun ?? 0n) + memoFeeSun + multiSignFeeSun,
    blockNumber: Number(blockRecord.number),
    blockTimeStamp: blockRecord.timestampMs,
    contractResult: [bytesToHex(result.returnValue).slice(2)],
  }
  // the contract this transaction touched: the one it created, or the one it
  // named
  const called = tx.raw_data?.contract?.[0]
  const created = result.createdAddress ?? result.deployAddress
  const contractAddress =
    created !== undefined
      ? toTronHex(created)
      : called?.type === 'TriggerSmartContract'
        ? String(called.parameter?.value?.contract_address ?? '')
        : ''
  if (contractAddress !== '') {
    info.contract_address = contractAddress
  }
  info.receipt = receipt
  const logs = result.execResult.logs ?? []
  if (logs.length > 0) {
    // TRON log addresses are plain 20-byte hex (no 41 prefix)
    info.log = logs.map(([address, topics, data]) => ({
      address: bytesToHex(address).slice(2),
      topics: topics.map((t) => bytesToHex(t).slice(2)),
      data: bytesToHex(data).slice(2),
    }))
  }
  if (result.reverted) {
    info.result = 'FAILED'
    info.resMessage = TronWeb.fromUtf8(runtimeErrorText(result)).replace(/^0x/, '')
  }
  const internals = buildInternalTransactions(tx.txID, result)
  if (internals !== undefined) info.internal_transactions = internals
  return info
}

/** Internal execution messages shared by the admission reply and the mined receipt. */
export function buildInternalTransactions(
  txid: string,
  result: Pick<WriteResult, 'internalTxs' | 'reverted'>,
) {
  const internals = result.internalTxs ?? []
  if (internals.length === 0) return undefined
  // An outer revert rejects its descendants as well as the frame that failed.
  const rejected = internals.map((call) => call.rejected === true)
  internals.forEach((call, index) => {
    if (call.parentIndex >= 0 && rejected[call.parentIndex] === true) rejected[index] = true
  })
  const hashes = internalTxHashes(txid, internals)
  return internals.map((call, index) =>
    internalTxToJSON(hashes[index] ?? '', call, result.reverted === true || rejected[index]),
  )
}

/** a signed 64-bit field as the encoding states it: eight bytes, most significant first */
function int64BE(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let held = value < 0n ? value + (1n << 64n) : value
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(held & 0xffn)
    held >>= 8n
  }
  return out
}

/**
 * The hash each internal transaction carries, in the order the execution made
 * them. A frame commits to the frame that opened it — the transaction id
 * standing in for the outermost one — so the hashes form a chain down the call
 * tree. The nonce counts every internal transaction the execution has made,
 * starting at one, which is why the whole list is derived in one pass.
 *
 * A create frame states no receiver: the address it takes is not settled when
 * the frame is opened. A frame that carries a TRC-10 amount states zero for
 * its TRX value, the amount riding beside the frame instead.
 */
export function internalTxHashes(txID: string, calls: readonly InternalCall[]): string[] {
  const root = txID === '' ? new Uint8Array() : hexToBytes(`0x${txID}`)
  const hashes: string[] = []
  for (const [index, call] of calls.entries()) {
    const parentHash = hashes[call.parentIndex]
    const parent = parentHash === undefined ? root : hexToBytes(`0x${parentHash}`)
    const receiver =
      call.create || call.to === undefined
        ? new Uint8Array()
        : hexToBytes(`0x${toTronHex(call.to)}`)
    const trxValue = call.tokenId !== undefined && call.tokenId > 0n ? 0n : call.valueSun
    const body = new Uint8Array([
      ...parent,
      ...receiver,
      ...call.data,
      ...int64BE(trxValue),
      ...int64BE(BigInt(index + 1)),
    ])
    hashes.push(utils.ethersUtils.keccak256(body).slice(2))
  }
  return hashes
}

/** the word a frame is noted by, which also decides whether it states a receiver */
function noteOf(call: InternalCall): string {
  if (call.suicide === true) return 'suicide'
  return call.create ? 'create' : 'call'
}

export function internalTxToJSON(
  hash: string,
  call: InternalCall,
  outerRejected = false,
): Record<string, unknown> {
  // the TRX amount leads whatever else the frame carries, at its zero value too
  const callValueInfo: Record<string, unknown>[] = [
    call.valueSun > 0n ? { callValue: call.valueSun } : {},
  ]
  const tokens =
    call.tokens ??
    (call.tokenId === undefined ? [] : ([[call.tokenId, call.tokenValue ?? 0n]] as const))
  for (const [tokenId, amount] of tokens) {
    callValueInfo.push({
      ...(amount > 0n ? { callValue: amount } : {}),
      tokenId: String(tokenId),
    })
  }
  // proto field order: hash, caller_address, transferTo_address, callValueInfo,
  // note, rejected; data is outside the proto and prints last
  const json: Record<string, unknown> = {
    hash,
    caller_address: toTronHex(call.caller),
    ...(call.to === undefined ? {} : { transferTo_address: toTronHex(call.to) }),
    callValueInfo,
    note: TronWeb.fromUtf8(noteOf(call)).replace(/^0x/, ''),
    ...(call.rejected || outerRejected ? { rejected: true } : {}),
    ...(call.data.length > 0 ? { data: bytesToHex(call.data).slice(2) } : {}),
  }
  return json
}
