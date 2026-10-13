import { assert, beforeAll, describe, it } from 'vitest'

import { HTTP_METHOD } from '../../src/dialect/registry.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'

import type { HandlerParams } from '../../src/dialect/registry.ts'

const BASE58 = 'TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm'
const HEX41 = '4171b0af54e0a1182a5e0947d6a64f3b22740ef318'

let provider: TronProvider

const check = async (address: unknown): Promise<{ result: boolean; message: string }> => {
  const params: HandlerParams = { address, [HTTP_METHOD]: 'POST' }
  // @ts-expect-error The validation matrix intentionally passes non-string addresses.
  return (await provider.request({ method: 'wallet/validateaddress', params })) as {
    result: boolean
    message: string
  }
}

beforeAll(async () => {
  provider = new TronProvider(await TronNode.create())
})

/**
 * The servlet picks how to decode from the value's length alone, and says which
 * way it read it. A value of any other length is never decoded at all.
 */
describe('validateaddress', () => {
  it('reads 42 characters as hex', async () => {
    assert.deepEqual(await check(HEX41), { result: true, message: 'Hex string format' })
    assert.deepEqual(await check(HEX41.toUpperCase()), {
      result: true,
      message: 'Hex string format',
    })
  })

  it('reads 34 characters as base58check', async () => {
    assert.deepEqual(await check(BASE58), { result: true, message: 'Base58check format' })
  })

  it('reads 28 characters as base64', async () => {
    // the same 21 bytes, stated the third way the servlet accepts
    const base64 = btoa(
      String.fromCharCode(...(HEX41.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16))),
    )
    assert.strictEqual(base64.length, 28)
    assert.deepEqual(await check(base64), { result: true, message: 'Base64 format' })
  })

  it('refuses any other length before it decodes anything', async () => {
    assert.deepEqual(await check('41ab'), { result: false, message: 'Length error' })
    assert.deepEqual(await check(''), { result: false, message: 'Length error' })
    assert.deepEqual(await check('a'.repeat(43)), { result: false, message: 'Length error' })
  })

  it.each([
    ['!'.repeat(28), 'Illegal base64 character 21'],
    [' '.repeat(28), 'Illegal base64 character 20'],
    ['é'.repeat(28), 'Illegal base64 character -17'],
    ['\u4e2d'.repeat(28), 'Illegal base64 character 3f'],
    ['='.repeat(28), 'Input byte array has wrong 4-byte ending unit'],
    ['A' + '='.repeat(27), 'Last unit does not have enough valid bits'],
    ['AA=A' + 'A'.repeat(24), 'Input byte array has wrong 4-byte ending unit'],
    ['AA==' + 'A'.repeat(24), 'Input byte array has incorrect ending byte at 4'],
  ])('reports a Base64 decoding failure for %s', async (address, message) => {
    assert.deepEqual(await check(address), { result: false, message })
  })

  it('refuses a value of the right length that does not decode to an address', async () => {
    // 42 characters, but not hex
    const reply = await check('z'.repeat(42))
    assert.isFalse(reply.result)
    // 34 characters whose checksum does not hold
    const bad = await check(`${BASE58.slice(0, 33)}1`)
    assert.isFalse(bad.result)
  })

  it('refuses 21 decoded bytes that do not start with the TRON prefix', async () => {
    const notTron = btoa(String.fromCharCode(0x42, ...new Array<number>(20).fill(0)))
    assert.strictEqual(notTron.length, 28)
    assert.deepEqual(await check(notTron), { result: false, message: 'Invalid address' })
  })
})
