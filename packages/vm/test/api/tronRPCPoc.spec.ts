import { assert, describe, expect, it, vi } from 'vitest'
import { parseTronRPCAddress, runTronRPCPoc } from '../../examples/tronRPCClient.ts'

// cspell:ignore getaccount getcontractinfo getnowblock runtimecode triggerconstantcontract walletsolidity

const CALLER = '410000000000000000000000000000000000000000'
const CONTRACT = `41${'0'.repeat(36)}1000`
const TRANSACTION_ID = `0x${'ab'.repeat(32)}` as const
const RUNTIME_CODE = '60005460005260206000f3'
const RETURN_VALUE = `${'0'.repeat(62)}2a`

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('TRON RPC Client PoC', () => {
  it('accepts Base58Check, 41-prefixed, and 20-byte addresses', () => {
    const hex41 = parseTronRPCAddress(CALLER)
    const hex20 = parseTronRPCAddress(`0x${CALLER.slice(2)}`)
    const base58 = parseTronRPCAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb')
    assert.deepEqual(hex41.bytes, hex20.bytes)
    assert.deepEqual(hex41.bytes, base58.bytes)
    assert.throws(() => parseTronRPCAddress('invalid'))
  })

  it('rejects an invalid stable-block retry count before making requests', async () => {
    const fetch = vi.fn()
    await expect(
      runTronRPCPoc({
        jsonRpcUrl: 'https://node.example/jsonrpc',
        walletUrl: 'https://node.example',
        caller: CALLER,
        contract: CONTRACT,
        calldata: '0x',
        stableBlockAttempts: 0,
        fetch: fetch as typeof globalThis.fetch,
      }),
    ).rejects.toThrow('stableBlockAttempts must be a positive integer')
    assert.strictEqual(fetch.mock.calls.length, 0)
  })

  it('loads one state snapshot and matches java-tron read-only execution', async () => {
    const calls: Array<{ url: string; body: any }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body))
      calls.push({ url, body })

      if (body.jsonrpc === '2.0') {
        const result: Record<string, unknown> = {
          eth_getBalance: '0x0',
          eth_getCode: body.params[0] === `0x${CONTRACT.slice(2)}` ? `0x${RUNTIME_CODE}` : '0x',
          eth_getStorageAt: `0x${RETURN_VALUE}`,
          eth_getBlockByNumber: {
            number: '0x64',
            timestamp: '0x1',
            gasLimit: '0xe4e1c0',
            difficulty: '0x0',
            miner: `0x${CALLER.slice(2)}`,
            mixHash: `0x${'0'.repeat(64)}`,
            transactions: [TRANSACTION_ID],
          },
          eth_getTransactionByHash: {
            hash: TRANSACTION_ID,
            blockNumber: '0x64',
            from: `0x${CALLER.slice(2)}`,
            to: `0x${CONTRACT.slice(2)}`,
            input: '0x',
            value: '0x0',
          },
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: result[body.method] })
      }
      if (url.endsWith('/getnowblock')) {
        return jsonResponse({ block_header: { raw_data: { number: 100 } } })
      }
      if (url.endsWith('/triggerconstantcontract')) {
        return jsonResponse({
          result: { result: true },
          constant_result: [RETURN_VALUE],
          energy_used: 221,
        })
      }
      if (url.endsWith('/getaccount')) {
        return jsonResponse({ address: CALLER, balance: 1_000_000 })
      }
      if (url.endsWith('/getcontractinfo')) {
        return jsonResponse({ runtimecode: RUNTIME_CODE })
      }
      return jsonResponse({})
    })

    const result = await runTronRPCPoc({
      jsonRpcUrl: 'https://node.example/jsonrpc',
      walletUrl: 'https://node.example',
      apiKey: 'test-key',
      caller: CALLER,
      contract: CONTRACT,
      calldata: '0x',
      stateTag: 100n,
      fetch: fetch as typeof globalThis.fetch,
    })

    assert.isTrue(result.blockStable)
    assert.strictEqual(result.localBlockNumber, 100n)
    assert.strictEqual(result.localReturnValue, `0x${RETURN_VALUE}`)
    assert.strictEqual(result.remoteReturnValue, `0x${RETURN_VALUE}`)
    assert.isTrue(result.returnValueMatches)
    assert.isTrue(result.walletRuntimeCodeMatches)
    assert.strictEqual(result.blockNumber, 100n)
    assert.strictEqual(result.remoteEnergyUsed, 221)
    assert.strictEqual(result.rpcTransaction?.hash, TRANSACTION_ID)
    assert.isTrue(calls.some(({ body }) => body.method === 'eth_getStorageAt'))
    assert.isTrue(calls.some(({ body }) => body.method === 'eth_getTransactionByHash'))
    assert.isTrue(calls.some(({ url }) => url.endsWith('/wallet/getaccount')))
    assert.isTrue(
      calls.every(
        ({ body }) =>
          body.jsonrpc !== '2.0' ||
          body.params.at(-1) === '0x64' ||
          body.method === 'eth_getBlockByNumber' ||
          body.method === 'eth_getTransactionByHash',
      ),
    )
    assert.isTrue(
      fetch.mock.calls.every(([, init]) =>
        Object.entries(init?.headers ?? {}).some(
          ([name, value]) => name === 'TRON-PRO-API-KEY' && value === 'test-key',
        ),
      ),
    )
  })

  it('reports a moving remote head instead of claiming snapshot consistency', async () => {
    let block = 100
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body))
      if (body.jsonrpc === '2.0') {
        const result: Record<string, unknown> = {
          eth_getBalance: '0x0',
          eth_getCode: body.params[0] === `0x${CONTRACT.slice(2)}` ? `0x${RUNTIME_CODE}` : '0x',
          eth_getStorageAt: `0x${RETURN_VALUE}`,
          eth_getBlockByNumber: {
            number: '0x66',
            timestamp: '0x1',
            gasLimit: '0xe4e1c0',
          },
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: result[body.method] })
      }
      if (url.endsWith('/getnowblock')) {
        return jsonResponse({ block_header: { raw_data: { number: block++ } } })
      }
      if (url.endsWith('/triggerconstantcontract')) {
        return jsonResponse({ result: { result: true }, constant_result: [RETURN_VALUE] })
      }
      if (url.endsWith('/getaccount')) return jsonResponse({ address: CALLER })
      if (url.endsWith('/getcontractinfo')) return jsonResponse({ runtimecode: RUNTIME_CODE })
      return jsonResponse({})
    })

    const result = await runTronRPCPoc({
      jsonRpcUrl: 'https://node.example/jsonrpc',
      walletUrl: 'https://node.example',
      caller: CALLER,
      contract: CONTRACT,
      calldata: '0x',
      stableBlockAttempts: 1,
      fetch: fetch as typeof globalThis.fetch,
    })
    assert.isFalse(result.blockStable)
    assert.isUndefined(result.energyMatches)
  })
})
