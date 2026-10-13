import { rejects } from 'node:assert/strict'
import { assert, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { HTTP_METHOD } from '../../src/dialect/registry.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider, requestWire } from '../../src/provider.ts'

import type { HandlerParams } from '../../src/dialect/registry.ts'

const TXID = 'a'.repeat(64)

let provider: TronProvider

const ask = async (method: string, fields: Record<string, unknown> = {}): Promise<unknown> => {
  const params: HandlerParams = { ...fields, [HTTP_METHOD]: 'POST' }
  return requestWire(provider, { method, params })
}

beforeAll(async () => {
  const node = await TronNode.create()
  nodeCore(node).txs.set(TXID, {
    transaction: { txID: TXID, raw_data: {} },
    info: { id: TXID, receipt: { net_usage: 268 }, contract_address: '41' },
  } as never)
  provider = new TronProvider(node)
})

describe('transaction queries', () => {
  it('reads a stored transaction by id, in either letter case', async () => {
    assert.deepInclude(await ask('wallet/gettransactionbyid', { value: TXID }), { txID: TXID })
    assert.deepInclude(await ask('wallet/gettransactionbyid', { value: TXID.toUpperCase() }), {
      txID: TXID,
    })
    // the 0x form is stripped before the store is keyed
    assert.deepInclude(await ask('wallet/gettransactionbyid', { value: `0x${TXID}` }), {
      txID: TXID,
    })
  })

  it('answers an empty object for an id nothing is stored under', async () => {
    assert.deepEqual(await ask('wallet/gettransactionbyid', { value: 'b'.repeat(64) }), {})
    assert.deepEqual(await ask('wallet/gettransactioninfobyid', { value: 'b'.repeat(64) }), {})
  })

  it('answers an empty object for hex that is not 32 bytes, and for no value at all', async () => {
    assert.deepEqual(await ask('wallet/gettransactionbyid', { value: 'abcd' }), {})
    assert.deepEqual(await ask('wallet/gettransactionbyid', {}), {})
  })

  it('refuses a value that is not hex before it looks anything up', async () => {
    let message = ''
    try {
      await ask('wallet/gettransactionbyid', { value: 'zzzz' })
    } catch (err) {
      message = (err as Error).message
    }
    assert.include(message, 'INVALID hex String')
  })

  it('prints only the receipt sub-message, under a capitalised key', async () => {
    assert.deepEqual(await ask('wallet/gettransactionreceiptbyid', { value: TXID }), {
      Receipt: { net_usage: 268 },
    })
    assert.deepEqual(await ask('wallet/gettransactionreceiptbyid', { value: 'b'.repeat(64) }), {})
  })

  it('reads the confirmed mirror off the same store', async () => {
    assert.deepInclude(await ask('walletsolidity/gettransactionbyid', { value: TXID }), {
      txID: TXID,
    })
  })

  describe('by block number', () => {
    it.each([
      'wallet/getblockbynum',
      'wallet/gettransactioncountbyblocknum',
      'wallet/gettransactioninfobyblocknum',
      'walletsolidity/getblockbynum',
      'walletsolidity/gettransactioncountbyblocknum',
      'walletsolidity/gettransactioninfobyblocknum',
    ] as const)('accepts equivalent program integer inputs for %s', async (method) => {
      const local = new TronProvider(await TronNode.create())
      const block = await local.node.tre.mine()
      const expected = await local.request({ method, params: { num: block.number } })
      for (const num of [
        Number(block.number),
        block.number,
        String(block.number),
        `0x${block.number.toString(16)}`,
      ]) {
        assert.deepEqual(await local.request({ method, params: { num } }), expected)
      }
      for (const num of ['', '1.5', 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
        await rejects(local.request({ method: String(method), params: { num } }), /num/)
      }
    })

    it('answers an empty object at or below the genesis block', async () => {
      assert.deepEqual(await ask('wallet/gettransactioninfobyblocknum', { num: 0 }), {})
      assert.deepEqual(await ask('wallet/gettransactioninfobyblocknum', { num: -1 }), {})
    })

    it('answers an empty list for a height the chain has not reached', async () => {
      assert.deepEqual(await ask('wallet/gettransactioninfobyblocknum', { num: 9_999_999 }), [])
    })

    it('counts the transactions in a block, keeping the zero', async () => {
      assert.deepEqual(await ask('wallet/gettransactioncountbyblocknum', { num: 9_999_999 }), {
        count: 0,
      })
    })
  })
})
