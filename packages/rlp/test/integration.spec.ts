import { assert, describe, it } from 'vitest'
import { RLP } from '../src/index.ts'
import { bytesToUtf8 } from './utils.ts'

describe('Shared RLP integration', () => {
  it('encodes a single byte without a length prefix', () => {
    const encoded = RLP.encode('a')
    assert.strictEqual(bytesToUtf8(encoded), 'a')
    assert.strictEqual(encoded.length, 1)
  })
})
