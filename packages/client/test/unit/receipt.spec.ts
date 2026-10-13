import { assert, describe, it } from 'vitest'

import { createAddressFromString } from '@tvmjs/util'
import { TronWeb } from 'tronweb'

import {
  buildTransactionInfo,
  contractRetOf,
  internalTxHashes,
  internalTxToJSON,
  runtimeErrorText,
} from '../../src/dialect/tron/wallet/receipt.ts'

import type { InternalCall, WriteResult } from '../../src/core/node.ts'

/** a frame that stopped on the given VM error, or ran to the end when absent */
const frame = (error?: string): WriteResult =>
  ({
    reverted: error !== undefined,
    execResult: error === undefined ? {} : { exceptionError: { error } },
  }) as unknown as WriteResult

describe('contractResult', () => {
  it('reports success for a frame that ran to the end', () => {
    assert.strictEqual(contractRetOf(frame()), 'SUCCESS')
  })

  it('names the condition the VM stopped on', () => {
    const cases: [string, string][] = [
      ['revert', 'REVERT'],
      ['out of gas', 'OUT_OF_ENERGY'],
      ['invalid JUMP', 'BAD_JUMP_DESTINATION'],
      ['value out of range', 'OUT_OF_MEMORY'],
      ['memory access', 'OUT_OF_MEMORY'],
      ['stack underflow', 'STACK_TOO_SMALL'],
      ['stack overflow', 'STACK_TOO_LARGE'],
      ['invalid bytecode', 'INVALID_CODE'],
      ['invalid opcode', 'ILLEGAL_OPERATION'],
      ['undefined opcode', 'ILLEGAL_OPERATION'],
      ['transfer trx failed', 'TRANSFER_FAILED'],
      ['transfer trc10 failed', 'TRANSFER_FAILED'],
      ['insufficient balance', 'TRANSFER_FAILED'],
      ['insufficient token balance', 'TRANSFER_FAILED'],
      ['invalid token id', 'TRANSFER_FAILED'],
    ]
    for (const [error, want] of cases) {
      assert.strictEqual(contractRetOf(frame(error)), want, error)
    }
  })

  it('matches the VM text whatever case it arrives in', () => {
    assert.strictEqual(contractRetOf(frame('REVERT')), 'REVERT')
    assert.strictEqual(contractRetOf(frame('Out Of Gas')), 'OUT_OF_ENERGY')
  })

  it('leaves a condition it does not recognise unnamed', () => {
    // filing an unknown cause under a specific one would misreport it
    assert.strictEqual(contractRetOf(frame('something new')), 'UNKNOWN')
    assert.strictEqual(contractRetOf(frame('')), 'UNKNOWN')
  })
})

describe('the runtime error a receipt carries', () => {
  it('gives REVERT its fixed wording, however the VM stated it', () => {
    assert.strictEqual(runtimeErrorText(frame('revert')), 'REVERT opcode executed')
    assert.strictEqual(runtimeErrorText(frame('execution reverted')), 'REVERT opcode executed')
    // a frame that failed with no text at all is a bare REVERT
    assert.strictEqual(runtimeErrorText(frame('')), 'REVERT opcode executed')
  })

  it('passes any other condition through, so it agrees with the result code', () => {
    assert.strictEqual(runtimeErrorText(frame('out of gas')), 'out of gas')
    assert.strictEqual(runtimeErrorText(frame('stack overflow')), 'stack overflow')
  })
})

describe('internal-transaction call values', () => {
  // 2^53 + 1: the smallest int64 a JavaScript number cannot state
  const BIG = 9_007_199_254_740_993n
  const call = (extra: Partial<InternalCall>): InternalCall => ({
    caller: createAddressFromString('0x'.padEnd(42, '1')),
    to: createAddressFromString('0x'.padEnd(42, '2')),
    parentIndex: -1,
    valueSun: 0n,
    data: new Uint8Array(),
    create: false,
    rejected: false,
    ...extra,
  })

  it('carries a TRC-10 amount whole, however large', () => {
    const json = internalTxToJSON('', call({ tokenId: 1_000_001n, tokenValue: BIG }))
    // the TRX amount leads even when the frame carries none of it
    assert.deepEqual(json.callValueInfo, [{}, { callValue: BIG, tokenId: '1000001' }])
  })

  it('carries a TRX amount whole, however large', () => {
    const json = internalTxToJSON('', call({ valueSun: BIG }))
    assert.deepEqual(json.callValueInfo, [{ callValue: BIG }])
  })

  it('states a token the frame carries none of', () => {
    const json = internalTxToJSON('', call({ tokenId: 1_000_001n, tokenValue: 0n }))
    assert.deepEqual(json.callValueInfo, [{}, { tokenId: '1000001' }])
  })

  it('states every token a destroyed contract still held', () => {
    const json = internalTxToJSON(
      '',
      call({
        suicide: true,
        valueSun: 7n,
        tokens: [
          [1_000_001n, 5n],
          [1_000_002n, 9n],
        ],
      }),
    )
    assert.deepEqual(json.callValueInfo, [
      { callValue: 7n },
      { callValue: 5n, tokenId: '1000001' },
      { callValue: 9n, tokenId: '1000002' },
    ])
    assert.strictEqual(json.note, TronWeb.fromUtf8('suicide').replace(/^0x/, ''))
  })
})

/**
 * The encoding under the hash is `parentHash ++ receiveAddress ++ data ++
 * int64(value) ++ int64(nonce)`, keccak-256 over the whole. The vectors are
 * fixed so a change to any part of that sentence shows up here.
 */
describe('internal-transaction hashes', () => {
  const TXID = 'aa'.repeat(32)
  const to = createAddressFromString(`0x${'22'.repeat(20)}`)
  const call = (extra: Partial<InternalCall>): InternalCall => ({
    caller: createAddressFromString(`0x${'11'.repeat(20)}`),
    to,
    parentIndex: -1,
    valueSun: 0n,
    data: new Uint8Array(),
    create: false,
    rejected: false,
    ...extra,
  })

  it('states a single call frame by its fixed vector', () => {
    assert.deepEqual(internalTxHashes(TXID, [call({ valueSun: 1_000_000n })]), [
      '1c0e4cc3bea9b0e25685f0d4bc1324cacb9e9c54687e66992dc8b40761bb443d',
    ])
  })

  it('chains a nested frame onto the one that opened it', () => {
    const hashes = internalTxHashes(TXID, [
      call({ valueSun: 1_000_000n }),
      call({ parentIndex: 0, valueSun: 2_000_000n }),
    ])
    // the outer frame is unaffected by what runs inside it
    assert.strictEqual(hashes[0], internalTxHashes(TXID, [call({ valueSun: 1_000_000n })])[0])
    // and a re-parented frame is a different transaction
    const flat = internalTxHashes(TXID, [
      call({ valueSun: 1_000_000n }),
      call({ valueSun: 2_000_000n }),
    ])
    assert.notStrictEqual(hashes[1], flat[1])
  })

  it('counts the nonce across the whole execution, not per frame', () => {
    const [first, second] = internalTxHashes(TXID, [call({}), call({})])
    // same fields, same parent, different position
    assert.notStrictEqual(first, second)
  })

  it('states no receiver for a create frame', () => {
    const created = internalTxHashes(TXID, [call({ create: true, data: new Uint8Array([1, 2]) })])
    const called = internalTxHashes(TXID, [
      call({ create: false, to: undefined, data: new Uint8Array([1, 2]) }),
    ])
    assert.strictEqual(created[0], called[0])
  })

  it('leaves the TRX value at zero when the frame carries a token', () => {
    const token = internalTxHashes(TXID, [
      call({ valueSun: 5n, tokenId: 1_000_001n, tokenValue: 5n }),
    ])
    const zero = internalTxHashes(TXID, [call({ valueSun: 0n })])
    assert.strictEqual(token[0], zero[0])
  })

  it('starts the chain at nothing when there is no transaction', () => {
    assert.notStrictEqual(
      internalTxHashes('', [call({})])[0],
      internalTxHashes(TXID, [call({})])[0],
    )
  })
})

describe('rejection down the internal-call tree', () => {
  const call = (extra: Partial<InternalCall>): InternalCall => ({
    caller: createAddressFromString(`0x${'11'.repeat(20)}`),
    to: createAddressFromString(`0x${'22'.repeat(20)}`),
    parentIndex: -1,
    valueSun: 0n,
    data: new Uint8Array(),
    create: false,
    rejected: false,
    ...extra,
  })
  const rejectedFlags = (internalTxs: InternalCall[]): boolean[] => {
    const info = buildTransactionInfo(
      { txID: 'aa', raw_data: {} } as never,
      {
        energyFeeSun: 0n,
        reverted: false,
        execResult: {},
        returnValue: new Uint8Array(),
        internalTxs,
      } as never,
      { number: 7n, timestampMs: 0 } as never,
      false,
    )
    return (info.internal_transactions as Record<string, unknown>[]).map(
      (tx) => tx.rejected === true,
    )
  }

  it('rejects the frames under one that reverted, however deep', () => {
    // 0 succeeds; 1 reverts inside it and the caller swallows the failure;
    // 2 runs inside 1 and returns on its own; 3 runs inside 2
    const flags = rejectedFlags([
      call({}),
      call({ parentIndex: 0, rejected: true }),
      call({ parentIndex: 1 }),
      call({ parentIndex: 2 }),
    ])
    assert.deepEqual(flags, [false, true, true, true])
  })

  it('leaves a sibling of the reverting frame alone', () => {
    const flags = rejectedFlags([
      call({}),
      call({ parentIndex: 0, rejected: true }),
      call({ parentIndex: 0 }),
    ])
    assert.deepEqual(flags, [false, true, false])
  })

  it('rejects every frame when the outermost one reverts', () => {
    const info = buildTransactionInfo(
      { txID: 'aa', raw_data: {} } as never,
      {
        energyFeeSun: 0n,
        reverted: true,
        execResult: {},
        returnValue: new Uint8Array(),
        internalTxs: [call({}), call({ parentIndex: 0 })],
      } as never,
      { number: 7n, timestampMs: 0 } as never,
      false,
    )
    assert.deepEqual(
      (info.internal_transactions as Record<string, unknown>[]).map((tx) => tx.rejected === true),
      [true, true],
    )
  })
})

describe('the fee a receipt totals', () => {
  const BIG = 9_007_199_254_740_993n

  it('carries the total whole, however large', () => {
    const info = buildTransactionInfo(
      { txID: 'aa', raw_data: {} } as never,
      {
        energyFeeSun: BIG,
        reverted: false,
        execResult: {},
        returnValue: new Uint8Array(),
        internalTxs: [],
      } as never,
      { number: 7n, timestampMs: 0 } as never,
      false,
    )
    assert.strictEqual(info.fee, BIG)
  })

  it('adds the charges that have no receipt field of their own', () => {
    const info = buildTransactionInfo(
      { txID: 'aa', raw_data: {} } as never,
      {
        energyFeeSun: BIG,
        memoFeeSun: 1n,
        multiSignFeeSun: 1n,
        reverted: false,
        execResult: {},
        returnValue: new Uint8Array(),
        internalTxs: [],
      } as never,
      { number: 7n, timestampMs: 0 } as never,
      false,
    )
    assert.strictEqual(info.fee, BIG + 2n)
  })
})
