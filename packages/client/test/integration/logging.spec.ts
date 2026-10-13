import { rejects } from 'node:assert/strict'
import { ServerResponse } from 'node:http'
import { createConnection } from 'node:net'

import { bytesToHex, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import type { Types } from 'tronweb'
import { assert, afterEach, beforeEach, describe, it, vi } from 'vitest'

import { nodeCore } from '../../src/core/nodeAccess.ts'
import { TronNode, TronProvider, startHttpServer } from '../../src/index.ts'
import type { StartedServer } from '../../src/index.ts'

const STAMP = /^\[\d{2}-\d{2}\|\d{2}:\d{2}:\d{2}\] /

async function close(started: StartedServer) {
  started.server.closeAllConnections()
  await new Promise<void>((resolve) => started.server.close(() => resolve()))
}

describe('runtime logging', () => {
  let node: TronNode
  let provider: TronProvider
  let started: StartedServer
  let lines: string[]
  let collect: (line: string) => void

  beforeEach(async () => {
    lines = []
    collect = (line) => {
      lines.push(line)
    }
    node = await TronNode.create({ runtime: { logger: { log: collect } } })
    assert.deepEqual(messages(), ['INFO Produced block number=1 txs=0'])
    provider = new TronProvider(node)
    started = await startHttpServer(provider, { port: 0 })
    lines.length = 0
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await node.tre.blockTime(0)
    await close(started)
  })

  const messages = () =>
    lines.map((line) => {
      assert.match(line, STAMP)
      return line.replace(STAMP, '')
    })
  const post = (path: string, body: unknown) =>
    fetch(`${started.url}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const rpc = (method: string, params: unknown[] = []) =>
    post('tre', { jsonrpc: '2.0', id: 1, method, params })

  it('logs the actual method once, before blocks, through each public entry', async () => {
    await node.tre.mine(2)
    assert.deepEqual(messages(), [
      'INFO tre_mine',
      'INFO Produced block number=2 txs=0',
      'INFO Produced block number=3 txs=0',
    ])
    lines.length = 0
    assert.strictEqual((await rpc('tre_mine', [{ blocks: 2 }])).status, 200)
    assert.deepEqual(messages(), [
      'INFO POST tre_mine',
      'INFO Produced block number=4 txs=0',
      'INFO Produced block number=5 txs=0',
    ])
    lines.length = 0
    await provider.request({ method: 'wallet/getnowblock' })
    await fetch(`${started.url}/wallet/getnowblock`)
    assert.deepEqual(messages(), ['INFO wallet/getnowblock', 'INFO GET /wallet/getnowblock'])
    lines.length = 0
    assert.isString(node.admin.info().name)
    await node.admin.accounts()
    const generated = await node.admin.temporaryAccountsGeneration({ accounts: 1 })
    assert.deepEqual(messages(), [
      'INFO admin',
      'INFO admin/accounts-json',
      'INFO admin/temporary-accounts-generation',
      'INFO Produced block number=6 txs=0',
    ])
    assert.notInclude(lines.join('\n'), generated.mnemonic)
    for (const group of [generated, ...generated.more]) {
      for (const key of group.privateKeys) assert.notInclude(lines.join('\n'), key)
    }
    lines.length = 0
    await node.debug.traceTransaction('ab'.repeat(32)).catch(() => {})
    assert.strictEqual(messages()[0], 'INFO debug_traceTransaction')
    assert.notInclude(lines.join('\n'), 'ab'.repeat(32))
  })

  it('reports RPC, builder and contract failures even when HTTP returns 200', async () => {
    const { privateKeys } = await node.admin.accounts()
    const [owner, target] = privateKeys.map((key) => TronWeb.address.fromPrivateKey(key) as string)
    await node.tre.setAccountCode(target, '60006000fd')
    lines.length = 0
    const invalid = await rpc('tre_blockTime', [0.5])
    assert.strictEqual(invalid.status, 200)
    assert.strictEqual((await invalid.json()).error.code, -32602)
    assert.deepEqual(messages(), [
      'INFO POST tre_blockTime',
      'WARN POST tre_blockTime: Invalid parameters',
    ])
    lines.length = 0
    const failed = await post('wallet/triggerconstantcontract', {
      owner_address: owner,
      contract_address: target,
      visible: true,
    })
    assert.strictEqual(failed.status, 200)
    assert.isTrue((await failed.json()).result.result)
    assert.deepEqual(messages(), [
      'INFO POST /wallet/triggerconstantcontract',
      'WARN POST /wallet/triggerconstantcontract: Contract reverted',
    ])
    lines.length = 0
    const built = await post('wallet/createtransaction', {
      owner_address: owner,
      to_address: target,
      amount: -1,
      visible: true,
    })
    assert.strictEqual(built.status, 200)
    assert.isString((await built.json()).Error)
    assert.deepEqual(messages(), [
      'INFO POST /wallet/createtransaction',
      'WARN POST /wallet/createtransaction: Request rejected',
    ])
    const unsigned = await (
      await post('wallet/createtransaction', {
        owner_address: owner,
        to_address: TronWeb.address.fromPrivateKey(privateKeys[2]) as string,
        amount: 1,
        visible: true,
      })
    ).json()
    if ('Error' in unsigned) throw new Error(unsigned.Error)
    lines.length = 0
    const broadcast = await post('wallet/broadcasttransaction', { ...unsigned, signature: [] })
    assert.strictEqual(broadcast.status, 200)
    assert.strictEqual((await broadcast.json()).code, 'SIGERROR')
    assert.deepEqual(messages(), [
      'INFO POST /wallet/broadcasttransaction',
      'WARN POST /wallet/broadcasttransaction: SIGERROR',
    ])
  })

  it('reports failed execution separately from block sealing, not when querying its receipt', async () => {
    const { privateKeys } = await node.admin.accounts()
    const [owner, contract] = privateKeys.map(
      (key) => TronWeb.address.fromPrivateKey(key) as string,
    )
    await node.tre.setAccountCode(contract, '60006000fd')
    const built = await (
      await post('wallet/triggersmartcontract', {
        owner_address: TronWeb.address.toHex(owner),
        contract_address: TronWeb.address.toHex(contract),
        data: '00',
        fee_limit: 100_000_000,
      })
    ).json()
    if (built.transaction === undefined) throw new Error('transaction was not built')
    const signed = utils.crypto.signTransaction(privateKeys[0], built.transaction)
    lines.length = 0
    const response = await post('wallet/broadcasttransaction', signed)
    assert.isTrue((await response.json()).result)
    assert.deepEqual(messages(), [
      'INFO POST /wallet/broadcasttransaction',
      'INFO Produced block number=3 txs=1',
      `WARN Transaction failed txid=${signed.txID} reason=REVERT`,
    ])
    lines.length = 0
    await provider.request({
      method: 'wallet/gettransactioninfobyid',
      params: { value: signed.txID },
    })
    assert.deepEqual(messages(), ['INFO wallet/gettransactioninfobyid'])
  })

  it.each(['provider', 'http'] as const)(
    'classifies alias failures using the shared definition while logging the requested name through %s',
    async (transport) => {
      const { privateKeys } = await node.admin.accounts()
      const [owner, target] = privateKeys.map(
        (key) => TronWeb.address.fromPrivateKey(key) as string,
      )
      await node.tre.setAccountCode(target, '60006000fd')
      for (const method of [
        'wallet/triggerconstantcontract',
        'walletsolidity/triggerconstantcontract',
      ] as const) {
        lines.length = 0
        const params = { owner_address: owner, contract_address: target, visible: true }
        if (transport === 'provider') await provider.request({ method, params })
        else assert.strictEqual((await post(method, params)).status, 200)
        const label = transport === 'provider' ? method : `POST /${method}`
        assert.deepEqual(messages(), [`INFO ${label}`, `WARN ${label}: Contract reverted`])
      }
    },
  )

  it.each(['provider', 'http'] as const)(
    'reports JSON and hex broadcast outcomes consistently through %s',
    async (transport) => {
      const { privateKeys, mnemonic } = await node.admin.accounts()
      const [owner, receiver] = privateKeys.map(
        (key) => TronWeb.address.fromPrivateKey(key) as string,
      )
      for (const method of ['wallet/broadcasttransaction', 'wallet/broadcasthex'] as const) {
        const tx = await provider.request({
          method: 'wallet/createtransaction',
          params: {
            owner_address: owner,
            to_address: receiver,
            amount: method.endsWith('hex') ? 19 : 17,
          },
        })
        if ('Error' in tx) throw new Error(tx.Error)
        const send = async (transaction: Types.Transaction & { signature?: string[] }) => {
          const pb = utils.transaction.txJsonToPb(transaction)
          for (const signature of transaction.signature ?? [])
            pb.addSignature(hexToBytes(`0x${signature}`))
          const params =
            method === 'wallet/broadcasthex'
              ? { transaction: bytesToHex(pb.serializeBinary()).slice(2) }
              : transaction
          lines.length = 0
          const reply =
            transport === 'provider'
              ? await provider.request({ method, params })
              : await (await post(method, params)).json()
          assert.notInclude(lines.join('\n'), privateKeys[0])
          assert.notInclude(lines.join('\n'), mnemonic)
          return reply
        }
        const label = transport === 'http' ? `POST /${method}` : method
        assert.deepInclude(await send(tx), { code: 'SIGERROR' })
        assert.deepEqual(messages(), [`INFO ${label}`, `WARN ${label}: SIGERROR`])
        const expired = { ...tx, raw_data: { ...tx.raw_data, expiration: 1 } }
        const pb = utils.transaction.txJsonToPb(expired)
        expired.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '')
        expired.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).replace(/^0x/, '')
        assert.deepInclude(await send(utils.crypto.signTransaction(privateKeys[0], expired)), {
          code: 'TRANSACTION_EXPIRATION_ERROR',
        })
        assert.deepEqual(messages(), [
          `INFO ${label}`,
          `WARN ${label}: TRANSACTION_EXPIRATION_ERROR`,
        ])
        const signed = utils.crypto.signTransaction(privateKeys[0], tx)
        assert.deepInclude(await send(signed), { result: true })
        assert.isEmpty(messages().filter((line) => line.startsWith('WARN')))
        assert.deepInclude(await send(signed), { code: 'DUP_TRANSACTION_ERROR' })
        assert.deepEqual(messages(), [`INFO ${label}`, `WARN ${label}: DUP_TRANSACTION_ERROR`])
      }
    },
  )

  it('keeps actual paths and RPC names, without query parameters or request bodies', async () => {
    const secret = 'private-material-'.repeat(30)
    await rpc('tre_mnie', [{ privateKey: secret, mnemonic: secret }])
    await fetch(`${started.url}/admin/missing?privateKey=${secret}`)
    await fetch(`${started.url}/wallet/getaccount?privateKey=${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{${secret}`,
    })
    assert.deepEqual(messages(), [
      'INFO POST tre_mnie',
      'WARN POST tre_mnie: Method not found',
      'INFO GET /admin/missing',
      'WARN GET /admin/missing status=404',
      'INFO POST /wallet/getaccount',
      'WARN POST /wallet/getaccount: Invalid request body',
    ])
    assert.notInclude(lines.join('\n'), secret)
    assert.isTrue(
      lines.every((line) => !/[\r\n]/.test(line) && !line.includes('\x1b') && line.length < 160),
    )
    lines.length = 0
    await fetch(`${started.url}/tre`, { method: 'OPTIONS' })
    assert.isEmpty(lines)
  })

  it('reports requests rejected by the HTTP parser and the outer failure handler', async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: started.port })
      let body = ''
      socket.setEncoding('utf8')
      socket.once('connect', () => socket.write('G@T / HTTP/1.1\r\nHost: localhost\r\n\r\n'))
      socket.on('data', (chunk) => {
        body += chunk
      })
      socket.once('end', () => resolve(body))
      socket.once('error', reject)
    })
    assert.match(response, /^HTTP\/1.1 400 /)
    assert.deepEqual(messages(), ['WARN HTTP parser rejected request status=400'])
    lines.length = 0
    vi.spyOn(ServerResponse.prototype, 'setHeader').mockImplementationOnce(() => {
      throw new Error('untrusted internal failure details')
    })
    assert.strictEqual((await fetch(`${started.url}/wallet/getnowblock`)).status, 500)
    assert.deepEqual(messages(), ['ERROR GET /wallet/getnowblock status=500'])
  })

  it('distinguishes HTTP verbs and reports refusal statuses without redundant descriptions', async () => {
    for (const method of ['GET', 'POST']) {
      lines.length = 0
      assert.strictEqual((await fetch(`${started.url}/wallet/getnowblock`, { method })).status, 200)
      assert.deepEqual(messages(), [`INFO ${method} /wallet/getnowblock`])
    }
    for (const [method, path, status] of [
      ['GET', '/wallet/getnowblok', 404],
      ['POST', '/admin/accounts-json', 405],
      ['PUT', '/wallet/getnowblock', 405],
      ['PATCH', '/wallet/getnowblock', 501],
      ['POST', '/wallet/getblockbalance', 501],
    ] as const) {
      lines.length = 0
      assert.strictEqual((await fetch(`${started.url}${path}`, { method })).status, status)
      assert.deepEqual(messages(), [
        `INFO ${method} ${path}`,
        `WARN ${method} ${path} status=${status}`,
      ])
    }
  })

  it('escapes and bounds request names without changing dispatch', async () => {
    const method = 'tre_missing\n\x1b[31m\u2028'
    const response = await rpc(method)
    assert.strictEqual((await response.json()).error.code, -32601)
    assert.deepEqual(messages(), [
      'INFO POST tre_missing\\n\\u001b[31m\\u{2028}',
      'WARN POST tre_missing\\n\\u001b[31m\\u{2028}: Method not found',
    ])
    lines.length = 0
    await rejects(provider.request({ method: 'missing_method' }))
    assert.deepEqual(messages(), ['INFO missing_method', 'WARN missing_method: Method not found'])
    lines.length = 0
    const longName = 'x'.repeat(500)
    await rpc(longName)
    await fetch(`${started.url}/${longName}?privateKey=not-for-logs`)
    assert.include(messages()[0], `${'x'.repeat(160)}…`)
    assert.include(messages()[2], `/${'x'.repeat(159)}…`)
    assert.isTrue(lines.every((line) => line.length < 240 && !/[\r\n\u2028]/.test(line)))
    assert.notInclude(lines.join('\n'), 'not-for-logs')
  })

  it('isolates concurrent requests and keeps logging after HTTP closes', async () => {
    const otherLines: string[] = []
    const other = await TronNode.create({
      runtime: { logger: { log: (line) => otherLines.push(line) } },
    })
    otherLines.length = 0
    await Promise.all([
      provider.request({ method: 'wallet/getnowblock' }),
      node.admin.accounts(),
      node.tre.mine(),
    ])
    assert.sameMembers(messages(), [
      'INFO wallet/getnowblock',
      'INFO admin/accounts-json',
      'INFO tre_mine',
      'INFO Produced block number=2 txs=0',
    ])
    assert.isEmpty(otherLines)
    lines.length = 0
    await node.tre.mine()
    assert.lengthOf(lines, 2)
    await close(started)
    lines.length = 0
    await node.tre.mine()
    assert.lengthOf(lines, 2)
    await other.tre.mine()
    assert.lengthOf(otherLines, 2)
    assert.lengthOf(lines, 2)
  })

  it('queues a write started by a logger callback behind the current write', async () => {
    const holder: { node?: TronNode } = {}
    let nested: Promise<unknown> | undefined
    const reentrant = await TronNode.create({
      runtime: {
        logger: {
          log: (line) => {
            if (nested === undefined && /Produced block number=2\b/.test(line)) {
              const node = holder.node
              if (node !== undefined) nested = node.tre.mine()
            }
          },
        },
      },
    })
    holder.node = reentrant

    await reentrant.tre.mine(2)
    assert.isDefined(nested)
    await nested
    assert.strictEqual(nodeCore(reentrant).head().number, 4n)
  })

  it('keeps one node logger when HTTP startup fails', async () => {
    await rejects(startHttpServer(provider, { port: -1 }))
    await rejects(startHttpServer(provider, { port: started.port }), /EADDRINUSE/)
    await node.tre.mine()
    assert.lengthOf(lines, 2)
  })

  it.each(['throw', 'reject'] as const)(
    'keeps node operations intact when its logger will %s',
    async (mode) => {
      const log = vi.fn(() => {
        if (mode === 'throw') throw new Error('output unavailable')
        return Promise.reject(new Error('output unavailable'))
      })
      const other = await TronNode.create({ runtime: { logger: { log } } })
      assert.strictEqual((await other.tre.mine()).number, 2n)
      assert.strictEqual(log.mock.calls.length, 3)
      assert.isEmpty(lines)
    },
  )

  it('keeps ordinary logs quiet when no logger is configured', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const quiet = await TronNode.create()
    await quiet.tre.mine()
    await new TronProvider(quiet).request({ method: 'wallet/getnowblock' })
    assert.strictEqual(log.mock.calls.length, 0)
    assert.strictEqual(error.mock.calls.length, 0)
  })

  it('uses the same immutable provider binding for requests and HTTP logs', async () => {
    const otherLines: string[] = []
    const other = await TronNode.create({
      runtime: { logger: { log: (line) => otherLines.push(line) } },
    })
    await other.tre.mine(3)
    otherLines.length = 0
    assert.isFalse(Reflect.set(provider, 'node', other))
    assert.strictEqual(provider.node, node)
    // Even shadowing the public getter cannot change the internal association.
    Object.defineProperty(provider, 'node', { value: other })
    const reply = await (await fetch(`${started.url}/wallet/getnowblock`)).json()
    assert.strictEqual(reply.block_header.raw_data.number, 1)
    assert.deepEqual(messages(), ['INFO GET /wallet/getnowblock'])
    assert.isEmpty(otherLines)
  })
})
