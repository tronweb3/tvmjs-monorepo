import { assert, describe, it } from 'vitest'

import { createTronTransactionContext } from '../src/message.ts'

describe('createTronTransactionContext input validation', () => {
  it('should throw on string input (not Uint8Array)', () => {
    assert.throws(
      () => createTronTransactionContext('0'.repeat(32) as any),
      /only supports Uint8Array/,
    )
  })

  it('should throw on plain array input', () => {
    assert.throws(
      () => createTronTransactionContext(new Array(32).fill(0) as any),
      /only supports Uint8Array/,
    )
  })

  it('should throw on wrong length Uint8Array', () => {
    assert.throws(
      () => createTronTransactionContext(new Uint8Array(31)),
      /Expected rootTransactionId to be of length 32/,
    )
  })

  it('should accept valid 32-byte Uint8Array', () => {
    const valid = new Uint8Array(32)
    const ctx = createTronTransactionContext(valid)
    assert.strictEqual(ctx.rootTransactionId.length, 32)
    assert.strictEqual(ctx.nonce, 0n)
  })
})
