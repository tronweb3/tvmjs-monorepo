import { request as httpRequest } from 'node:http'
import { assert, describe, expectTypeOf, it } from 'vitest'

import * as api from '../../src/index.ts'
import { PUBLIC_SURFACE } from '../publicSurface.ts'

import type { AddressInfo } from 'node:net'

const addressOf = (started: api.StartedServer): string =>
  (started.server.address() as AddressInfo).address

async function requestStatus(
  url: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; cors: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host, ...headers } }, (response) => {
      response.resume()
      response.once('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          cors: response.headers['access-control-allow-origin'],
        }),
      )
    })
    request.once('error', reject)
    request.end()
  })
}

async function closeServer(server: api.StartedServer['server']): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}

describe('the public surface', () => {
  it('is the list the packaged builds are held to, name for name', () => {
    assert.deepEqual(Object.keys(api).sort(), PUBLIC_SURFACE)
  })

  it('carries the node, the provider and the transport', () => {
    assert.isFunction(api.TronNode.create)
    assert.isFunction(api.TronProvider)
    assert.isFunction(api.startHttpServer)
    assert.isFunction(api.createHttpServer)
  })

  for (const host of ['127.0.0.1', '::1']) {
    it(`returns a reachable ${host} URL`, async () => {
      const node = await api.TronNode.create()
      const started = await api.startHttpServer(new api.TronProvider(node), { host, port: 0 })
      try {
        assert.strictEqual(new URL(started.url).port, String(started.port))
        assert.strictEqual((await fetch(`${started.url}/wallet/getnodeinfo`)).status, 200)
        assert.strictEqual((await fetch(`${started.url}/admin/accounts-json`)).status, 200)
      } finally {
        started.server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          started.server.close((error) => (error === undefined ? resolve() : reject(error))),
        )
      }
    })
  }

  it('returns ordinary program values while preserving HTTP number and text formats', async () => {
    const node = await api.TronNode.create()
    const provider = new api.TronProvider(node)
    const started = await api.startHttpServer(provider, { port: 0 })
    try {
      const info = await provider.request({ method: 'wallet/getnodeinfo' })
      expectTypeOf(info.configNodeInfo.maxTimeRatio).toEqualTypeOf<number>()
      assert.strictEqual(info.configNodeInfo.maxTimeRatio + 1, 6)
      const wire = await (await fetch(`${started.url}/wallet/getnodeinfo`)).text()
      assert.match(wire, /"maxTimeRatio"\s*:\s*5\.0/)
      assert.strictEqual(JSON.parse(wire).configNodeInfo.maxTimeRatio, 5)
      assert.strictEqual(
        await provider.request({ method: 'admin' }),
        await (await fetch(`${started.url}/admin`)).text(),
      )
      const listing = await provider.request({ method: 'admin/accounts' })
      expectTypeOf(listing).toEqualTypeOf<string>()
      assert.strictEqual(listing, await (await fetch(`${started.url}/admin/accounts`)).text())
    } finally {
      started.server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        started.server.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    }
  })

  it('assembles a working provider from the surface alone', async () => {
    const node = await api.TronNode.create()
    const provider = new api.TronProvider(node)
    const block = (await provider.request({
      method: 'wallet/getnowblock',
    })) as { blockID?: string }
    assert.isString(block.blockID)
  })

  it('binds loopback until the caller names an interface', async () => {
    const node = await api.TronNode.create()
    const provider = new api.TronProvider(node)
    const closed = await api.startHttpServer(provider, { port: 0 })
    try {
      assert.oneOf(addressOf(closed), ['127.0.0.1', '::1'])
    } finally {
      closed.server.close()
    }
    const open = await api.startHttpServer(provider, { port: 0, host: '*' })
    try {
      assert.oneOf(addressOf(open), ['::', '0.0.0.0'])
    } finally {
      open.server.close()
    }
  })

  it('matches control Host checks to explicit and wildcard bindings', async () => {
    const node = await api.TronNode.create()
    const provider = new api.TronProvider(node)

    const namedServer = api.createHttpServer(provider, { host: 'node.example' })
    await new Promise<void>((resolve, reject) => {
      namedServer.once('error', reject)
      namedServer.listen(0, '127.0.0.1', resolve)
    })
    const namedPort = (namedServer.address() as AddressInfo).port
    const namedUrl = `http://127.0.0.1:${namedPort}/admin/accounts-json`
    try {
      assert.deepEqual(await requestStatus(namedUrl, 'node.example'), {
        status: 200,
        cors: undefined,
      })
      assert.deepEqual(await requestStatus(namedUrl, 'other.example'), {
        status: 403,
        cors: undefined,
      })
    } finally {
      await closeServer(namedServer)
    }

    const wildcard = await api.startHttpServer(provider, { host: '*', port: 0 })
    try {
      assert.deepEqual(
        await requestStatus(`${wildcard.url}/admin/accounts-json`, 'other.example'),
        { status: 200, cors: undefined },
      )
      assert.deepEqual(
        await requestStatus(`${wildcard.url}/admin/accounts-json`, 'other.example', {
          origin: 'https://other.example',
        }),
        { status: 403, cors: undefined },
      )
    } finally {
      await closeServer(wildcard.server)
    }
  })

  it('logs initialization and HTTP through the configured node logger', async () => {
    const lines: string[] = []
    const node = await api.TronNode.create({
      runtime: { logger: { log: (line) => lines.push(line) } },
    })
    assert.lengthOf(lines, 1)
    assert.match(lines[0], / INFO Produced block number=1 txs=0$/)
    lines.length = 0
    const started = await api.startHttpServer(new api.TronProvider(node), {
      port: 0,
    })
    try {
      assert.strictEqual((await fetch(`${started.url}/wallet/getnowblock`)).status, 200)
      assert.lengthOf(lines, 1)
      assert.match(lines[0], /^\[\d{2}-\d{2}\|\d{2}:\d{2}:\d{2}\] INFO GET \/wallet\/getnowblock$/)
      await node.tre.mine()
      assert.match(lines[1], / INFO tre_mine$/)
      assert.match(lines[2], / INFO Produced block number=2 txs=0$/)
    } finally {
      started.server.close()
    }
  })

  it('types only registered solidity mirrors as known results', async () => {
    const provider = new api.TronProvider(await api.TronNode.create())
    const head = await provider.request({ method: 'walletsolidity/getnowblock' })
    expectTypeOf(head).toEqualTypeOf<api.TronBlock>()
    assert.isString(head.blockID)
    expectTypeOf<api.ProviderResult<'walletsolidity/getpendingsize'>>().toEqualTypeOf<unknown>()
    expectTypeOf<api.ProviderResult<'walletsolidity/createtransaction'>>().toEqualTypeOf<unknown>()
    for (const method of ['walletsolidity/getpendingsize', 'walletsolidity/createtransaction']) {
      await provider.request({ method }).then(
        () => assert.fail('unregistered method must not succeed'),
        (error) => assert.instanceOf(error, api.MethodNotFoundError),
      )
    }
  })
})
