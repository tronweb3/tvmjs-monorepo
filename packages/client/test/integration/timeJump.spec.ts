import { assert } from 'chai'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

import type { Server } from 'node:http'

const config = resolveConfig()

const DAY_MS = 86_400_000

describe('tre_increaseTime', () => {
  let node: TronNode
  let server: Server
  let baseUrl = ''

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>

  const rpc = async (method: string, params: unknown): Promise<unknown> =>
    (
      (await (
        await fetch(`${baseUrl}/tre`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).json()) as { result?: unknown }
    ).result

  beforeAll(async () => {
    node = await TronNode.create(config)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
  })

  afterAll(() => {
    server.close()
  })

  it('moves head time forward by the seconds it is given and seals a block', async () => {
    const before = nodeCore(node).head().timestampMs
    const height = nodeCore(node).blocks.height()

    const result = await rpc('tre_increaseTime', [DAY_MS / 1000])

    // the jump reaches the head block, which is what the expiry judgements read
    assert.strictEqual(result, nodeCore(node).head().timestampMs)
    assert.approximately(nodeCore(node).head().timestampMs - before, DAY_MS, 5_000)
    assert.strictEqual(nodeCore(node).blocks.height(), height + 1n)
  })

  it('accumulates across calls', async () => {
    const before = nodeCore(node).head().timestampMs
    await rpc('tre_increaseTime', [3600])
    await rpc('tre_increaseTime', [3600])
    assert.approximately(nodeCore(node).head().timestampMs - before, 2 * 3_600_000, 5_000)
  })

  it('refuses a negative increase without changing the head', async () => {
    const before = nodeCore(node).head().timestampMs
    const height = nodeCore(node).blocks.height()

    const reply = await post('tre', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tre_increaseTime',
      params: [-DAY_MS / 1000],
    })
    assert.strictEqual((reply.error as { code: number }).code, -32602)
    assert.strictEqual(nodeCore(node).head().timestampMs, before)
    assert.strictEqual(nodeCore(node).blocks.height(), height)
  })

  it('free bandwidth comes back over the recovery window', async () => {
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[2].privateKey,
    })
    const me = tronWeb.defaultAddress.base58 as string
    const other = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[3].privateKey,
    ) as string
    const used = async (): Promise<number> =>
      Number(
        (
          (await post('wallet/getaccountnet', { address: TronWeb.address.toHex(me) })) as {
            freeNetUsed?: number
          }
        ).freeNetUsed ?? 0,
      )

    assert.strictEqual(await used(), 0)
    await tronWeb.trx.sendRawTransaction(
      await tronWeb.trx.sign(
        (await tronWeb.transactionBuilder.sendTrx(other, 1_000_000, me)) as never,
      ),
    )
    const spent = await used()
    assert.isAbove(spent, 0)

    // recovery is linear across the window, so half the window returns half
    await rpc('tre_increaseTime', [12 * 3600])
    const half = await used()
    assert.approximately(half, spent / 2, spent / 10)

    await rpc('tre_increaseTime', [13 * 3600])
    assert.strictEqual(await used(), 0)
  })

  it('brings a lock-up window within reach', async () => {
    const owner = accountsFromMnemonic(config.mnemonic)[0].privateKey
    const { TronWeb } = await import('tronweb')
    const tronWeb = new TronWeb({ fullHost: baseUrl, privateKey: owner })
    const me = tronWeb.defaultAddress.base58 as string
    // the sale window is judged against head time, which the jumps moved
    const now = nodeCore(node).head().timestampMs
    const name = `TJ${now.toString(36).slice(-4).toUpperCase()}`

    const issue = (await tronWeb.transactionBuilder.createToken(
      {
        name,
        abbreviation: name,
        description: 'x',
        url: 'https://e.io',
        totalSupply: 1_000_000,
        trxRatio: 1,
        tokenRatio: 1,
        saleStart: now + 5_000,
        saleEnd: now + 600_000,
        freeBandwidth: 100,
        freeBandwidthLimit: 10,
        frozenAmount: 10,
        frozenDuration: 1,
      },
      me,
    )) as unknown as Record<string, unknown>
    assert.isUndefined(issue.Error, JSON.stringify(issue.Error))
    assert.isTrue(
      (
        (await tronWeb.trx.sendRawTransaction(await tronWeb.trx.sign(issue as never))) as {
          result?: boolean
        }
      ).result,
    )

    const unfreeze = async (): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/unfreezeasset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ owner_address: TronWeb.address.toHex(me) }),
        })
      ).json()) as Record<string, unknown>

    assert.strictEqual((await unfreeze()).Error, "It's not time to unfreeze asset supply")
    await rpc('tre_increaseTime', [DAY_MS / 1000 + 60])
    assert.isUndefined((await unfreeze()).Error)
  })
})
