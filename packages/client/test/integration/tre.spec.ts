import { request as httpRequest } from 'node:http'
import { hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CLIENT_NAME,
  CLIENT_VERSION,
  accountsFromMnemonic,
  resolveConfig,
} from '../../src/config.ts'
import { HD_PATH, derivePrivateKeys } from '../../src/hdWallet.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

import type { Server } from 'node:http'
import type { TransactionTrace } from '../../src/development/debug.ts'
import type { SignedTronTx } from '../../src/dialect/tron/wallet/types.ts'
import type { ProviderParams, TransactionInfo } from '../../src/rpc.ts'

const INC_RUNTIME = '6000546001018060005560005260206000f3'
const INC_INITCODE = `601280600b6000396000f3${INC_RUNTIME}`
const INC_ABI = [
  {
    inputs: [],
    name: 'inc',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
]

// the tre.js expectation list, verbatim
const STRUCT_LOG_KEYS = [
  'depth',
  'error',
  'gas',
  'gasCost',
  'memory',
  'op',
  'pc',
  'stack',
  'storage',
]

describe('tre_* / debug_* over POST /tre (JSON-RPC 2.0)', () => {
  const config = resolveConfig()
  const ownerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
  let node: TronNode
  let server: Server
  let tronWeb: TronWeb
  let baseUrl = ''
  let rpcId = 0

  /** mirrors the caller-side unwrap: `if (result) return result; if (error) throw` */
  async function treSend(method: string, params: unknown[] = []): Promise<unknown> {
    const response = await fetch(`${baseUrl}/tre`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    })
    const data = (await response.json()) as { result?: unknown; error?: { message?: string } }
    if (data.result !== undefined && data.result !== null && data.result !== false) {
      return data.result
    }
    if (data.error) throw new Error(data.error.message ?? String(data.error))
    return undefined
  }

  const postAdmin = (path: string): Promise<Response> =>
    fetch(`${baseUrl}/${path}`, { method: 'POST' })

  it('names itself in the Server header on every reply, product/version form', async () => {
    const replies = await Promise.all([
      fetch(`${baseUrl}/wallet/getnowblock`, { method: 'POST' }),
      fetch(`${baseUrl}/wallet/nosuchroute`),
      fetch(`${baseUrl}/tre`, {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"tre_mine","params":[]}',
      }),
      fetch(`${baseUrl}/wallet/getnowblock`, { method: 'OPTIONS' }),
    ])
    for (const reply of replies) {
      assert.match(reply.headers.get('server') ?? '', /^tvmjs\/\d+\.\d+\.\d+$/, reply.url)
      await reply.text()
    }
  })

  it('answers JSON-RPC, result or error, as application/json', async () => {
    for (const method of ['tre_mine', 'tre_noSuchMethod']) {
      const response = await fetch(`${baseUrl}/tre`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: [] }),
      })
      assert.strictEqual(response.headers.get('content-type'), 'application/json', method)
      await response.json()
    }
  })

  it('keeps browser CORS on the TRON surface and isolates development controls', async () => {
    const origin = 'https://attacker.example'
    const publicReply = await fetch(`${baseUrl}/wallet/getnowblock`, {
      headers: { origin },
    })
    assert.strictEqual(publicReply.status, 200)
    assert.strictEqual(publicReply.headers.get('access-control-allow-origin'), '*')

    const accountsBefore = await node.admin.accounts()
    const headBefore = (await tronWeb.trx.getCurrentBlock()).block_header.raw_data.number
    for (const [label, response] of [
      ['origin', await fetch(`${baseUrl}/admin/accounts-json`, { headers: { origin } })],
      [
        'preflight',
        await fetch(`${baseUrl}/tre`, {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST' },
        }),
      ],
      [
        'fetch metadata',
        await fetch(`${baseUrl}/admin/accounts-generation`, {
          method: 'POST',
          headers: { 'sec-fetch-site': 'cross-site' },
        }),
      ],
    ] as const) {
      assert.strictEqual(response.status, 403, label)
      assert.isNull(response.headers.get('access-control-allow-origin'))
      assert.strictEqual(await response.text(), 'Forbidden\n')
    }

    const invalidHost = await new Promise<{ status: number; cors?: string; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          new URL('/admin/accounts-json', baseUrl),
          { headers: { host: 'attacker.example' } },
          (response) => {
            response.setEncoding('utf8')
            let body = ''
            response.on('data', (chunk: string) => {
              body += chunk
            })
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                ...(response.headers['access-control-allow-origin'] === undefined
                  ? {}
                  : { cors: response.headers['access-control-allow-origin'] }),
                body,
              }),
            )
          },
        )
        request.once('error', reject)
        request.end()
      },
    )
    assert.deepEqual(invalidHost, { status: 403, body: 'Forbidden\n' })

    for (const path of [
      'admin/accounts-generation',
      'admin/temporary-accounts-generation?accounts=1',
    ]) {
      assert.strictEqual((await fetch(`${baseUrl}/${path}`)).status, 405)
    }
    assert.deepEqual(await node.admin.accounts(), accountsBefore)
    assert.strictEqual(
      (await tronWeb.trx.getCurrentBlock()).block_header.raw_data.number,
      headBefore,
    )

    const local = await fetch(`${baseUrl}/admin/accounts-json`)
    assert.strictEqual(local.status, 200)
    assert.isNull(local.headers.get('access-control-allow-origin'))
    assert.deepEqual(await local.json(), accountsBefore)
  })

  beforeAll(async () => {
    node = await TronNode.create(config)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    tronWeb = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    })
  })

  afterAll(async () => {
    await node.tre.blockTime(0)
    server.close()
  })

  it('tre_setAccountBalance accepts number and 0x-hex forms', async () => {
    const account = utils.accounts.generateAccount().address.base58
    assert.strictEqual(await treSend('tre_setAccountBalance', [account, 100]), true)
    assert.strictEqual(await tronWeb.trx.getBalance(account), 100)

    const hexBalance = `0x${Number(1000 * 1e6).toString(16)}`
    assert.strictEqual(await treSend('tre_setAccountBalance', [account, hexBalance]), true)
    assert.strictEqual(await tronWeb.trx.getBalance(account), 1000 * 1e6)
  })

  it('tre_setAccountCode sets and replaces runtime code', async () => {
    const account = utils.accounts.generateAccount().address.base58
    const getRuntimeCode = async () => {
      const info = (await tronWeb.solidityNode.request(
        'wallet/getcontractinfo',
        { value: TronWeb.address.toHex(account) },
        'post',
      )) as { runtimecode?: string }
      return `0x${info.runtimecode ?? ''}`
    }

    assert.strictEqual(await getRuntimeCode(), '0x')
    assert.strictEqual(await treSend('tre_setAccountCode', [account, '0xbaddad42']), true)
    assert.strictEqual(await getRuntimeCode(), '0xbaddad42')
    assert.strictEqual(await treSend('tre_setAccountCode', [account, `0x${INC_RUNTIME}`]), true)
    assert.strictEqual(await getRuntimeCode(), `0x${INC_RUNTIME}`)
  })

  it('tre_setAccountStorageAt makes the slot visible to contract reads', async () => {
    const account = utils.accounts.generateAccount().address.base58
    await treSend('tre_setAccountCode', [account, `0x${INC_RUNTIME}`])
    const slot = `0x${'00'.repeat(32)}`
    const value = `0x${'00'.repeat(31)}07`
    assert.strictEqual(await treSend('tre_setAccountStorageAt', [account, slot, value]), true)

    // the inc runtime returns sload(0)+1 for any selector; expose it as a
    // view function so .call() is allowed
    const viewAbi = [
      {
        inputs: [],
        name: 'total',
        outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
      },
    ]
    const instance = tronWeb.contract(viewAbi, account)
    assert.strictEqual(await instance.total().call(), 8n)
  })

  it('tre_blockTime toggles interval mining; tre_mine seals on demand', async () => {
    const heightOf = async () =>
      (await tronWeb.trx.getCurrentBlock()).block_header.raw_data.number as number

    assert.strictEqual(await treSend('tre_blockTime', [0]), true)
    const paused = await heightOf()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.strictEqual(await heightOf(), paused)

    assert.strictEqual(await treSend('tre_blockTime', [1]), true)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    assert.strictEqual(await treSend('tre_blockTime', [0]), true)
    assert.isAbove(await heightOf(), paused)

    const before = await heightOf()
    assert.strictEqual(await treSend('tre_mine', [{ blocks: 3 }]), '0x0')
    assert.strictEqual(await heightOf(), before + 3)
  })

  it('tre_unlockedAccounts lets unsigned broadcasts through; others stay rejected', async () => {
    const unlocked = utils.accounts.generateAccount().address.base58
    const contract = utils.accounts.generateAccount().address.base58
    await treSend('tre_setAccountBalance', [unlocked, 10_000_000_000])
    await treSend('tre_setAccountCode', [contract, `0x${INC_RUNTIME}`])

    const buildUnsigned = async () => {
      const { transaction } = await tronWeb.transactionBuilder.triggerSmartContract(
        TronWeb.address.toHex(contract),
        'inc()',
        { feeLimit: 100_000_000 },
        [],
        TronWeb.address.toHex(unlocked),
      )
      return { ...transaction, signature: [] }
    }

    // not unlocked yet → SIGERROR
    const rejected = await tronWeb.trx.sendRawTransaction((await buildUnsigned()) as never)
    assert.strictEqual((rejected as unknown as { code?: string }).code, 'SIGERROR')

    assert.strictEqual(await treSend('tre_unlockedAccounts', [[unlocked]]), true)
    const accepted = await tronWeb.trx.sendRawTransaction((await buildUnsigned()) as never)
    assert.isTrue(accepted.result)
  })

  it('debug_traceTransaction replays a deploy with reference-shaped structLogs', async () => {
    const unsigned = await tronWeb.transactionBuilder.createSmartContract(
      { abi: INC_ABI, bytecode: INC_INITCODE, feeLimit: 1_000_000_000, callValue: 0, name: 'Inc' },
      ownerBase58,
    )
    const signed = await tronWeb.trx.sign(unsigned)
    await tronWeb.trx.sendRawTransaction(signed)

    const trace = (await treSend('debug_traceTransaction', [`0x${signed.txID}`])) as {
      failed: boolean
      gas: string
      returnValue: string
      structLogs: { depth: number; gas: string; gasCost: number }[]
    }
    // the field order the trace message declares
    assert.deepEqual(Object.keys(trace), ['failed', 'gas', 'structLogs', 'returnValue'])
    assert.deepEqual(await node.debug.traceTransaction(`0x${signed.txID}`), trace)
    assert.strictEqual(trace.failed, false)
    // a gas figure is an unsigned 64-bit quantity, all sixteen digits
    assert.match(trace.gas, /^0x[0-9a-f]{16}$/)
    assert.isArray(trace.structLogs)
    // the deploy runs seven instructions: PUSH1 PUSH1 MSTORE PUSH1 PUSH1 RETURN, and the
    // frame the return closes
    assert.strictEqual(trace.structLogs.length, 7)
    for (const key of STRUCT_LOG_KEYS) {
      assert.property(trace.structLogs[0], key)
    }
    for (const log of trace.structLogs) {
      assert.match(log.gas, /^0x[0-9a-f]{16}$/, JSON.stringify(log))
      assert.strictEqual(typeof log.gasCost, 'number')
    }
    // the outermost frame is the first, so a top-level deploy is all depth 1
    assert.deepEqual([...new Set(trace.structLogs.map((log) => log.depth))], [1])
    // each entry states what is left before that step is charged for, so the
    // figure never climbs
    const left = trace.structLogs.map((log) => BigInt(log.gas))
    assert.isAbove(Number(left[0]), 0)
    assert.deepEqual(
      left,
      [...left].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)),
    )

    // trigger tx traces carry SSTORE-touched slots in `storage`
    const txid = (await tronWeb
      .contract(INC_ABI, unsigned.contract_address)
      .inc()
      .send({ feeLimit: 100_000_000 })) as string
    const triggerTrace = (await treSend('debug_traceTransaction', [`0x${txid}`])) as {
      failed: boolean
      structLogs: { op: string; storage: Record<string, string> }[]
    }
    assert.strictEqual(triggerTrace.failed, false)
    assert.deepEqual(await node.debug.traceTransaction(`0x${txid}`), triggerTrace)
    const last = triggerTrace.structLogs[triggerTrace.structLogs.length - 1]
    // `inc` writes slot 0 and nothing else
    assert.deepEqual(Object.keys(last.storage), ['00'.repeat(32)])
  })

  it('debug_storageRangeAt returns {storage, nextKey} from the live state', async () => {
    const contract = utils.accounts.generateAccount().address.base58
    await treSend('tre_setAccountCode', [contract, `0x${INC_RUNTIME}`])
    await treSend('tre_setAccountStorageAt', [
      contract,
      `0x${'00'.repeat(32)}`,
      `0x${'00'.repeat(31)}05`,
    ])

    // call shape: [block, txIndex, address, startKey, limit] — only the head
    // is queryable, under any of its names
    const result = (await treSend('debug_storageRangeAt', ['latest', 0, contract, '0x01', 1])) as {
      storage: Record<string, { key: unknown; value: unknown }>
      nextKey?: unknown
    }
    assert.isObject(result.storage)
    assert.strictEqual(Object.keys(result.storage).length, 1)
    assert.notStrictEqual(result.nextKey, undefined)
    const [first] = Object.keys(result.storage)

    // a row key is the first half of the account hash, then the low half of
    // the slot — written bare, as is every other hex on this route
    const accountHash = utils.ethersUtils
      .keccak256(hexToBytes(`0x${TronWeb.address.toHex(contract) as string}`))
      .slice(2)
    assert.strictEqual(first, `${accountHash.slice(0, 32)}${'00'.repeat(16)}`)
    // an entry states the key it is filed under
    assert.strictEqual(result.storage[first].key, first)
    // a value is the full word, leading zeros and all
    assert.strictEqual(result.storage[first].value, `${'00'.repeat(31)}05`)
    // one entry fits under the limit, so there is no page after it
    assert.strictEqual(result.nextKey, null)
    assert.deepEqual(await node.debug.storageRangeAt('latest', 0, contract, '0x01', 1), result)
  })

  // The wallet surface's code version names no implementation on purpose, so
  // nothing there names this node. This route does.
  it('says which node is answering, on its own route only', async () => {
    // the slash is optional at the root of the namespace, so both forms answer
    for (const path of ['/admin', '/admin/']) {
      const manifest = await fetch(`${baseUrl}${path}`)
      assert.strictEqual(manifest.headers.get('content-type'), 'text/plain; charset=utf-8')
      assert.strictEqual((await manifest.text()).trim(), `${CLIENT_NAME} ${CLIENT_VERSION}`)
    }

    // below the root it is part of the path, as everywhere else on this node
    assert.strictEqual((await fetch(`${baseUrl}/admin/accounts`)).status, 200)
    assert.strictEqual((await fetch(`${baseUrl}/admin/accounts/`)).status, 404)

    // every response names the server in the product/version form of RFC 9110
    const ordinary = await fetch(`${baseUrl}/wallet/getnowblock`)
    assert.strictEqual(ordinary.headers.get('server'), `tvmjs/${CLIENT_VERSION}`)

    const info = (await (await fetch(`${baseUrl}/wallet/getnodeinfo`)).json()) as {
      configNodeInfo: { codeVersion: string }
    }
    assert.strictEqual(info.configNodeInfo.codeVersion, '4.8.2')
  })

  it('serves one block per wallet, each numbered from its own zero', async () => {
    const roster = async (): Promise<string> => (await fetch(`${baseUrl}/admin/accounts`)).text()

    const res = await fetch(`${baseUrl}/admin/accounts`)
    assert.strictEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8')
    const text = await res.text()
    // a rule is followed by a blank line, and the two sections number alike
    assert.include(text, `Available Accounts\n==================\n\n(0) `)
    assert.include(text, `Private Keys\n==================\n\n(0) `)
    assert.include(text, `HD Wallet\n==================\nMnemonic:      ${config.mnemonic.phrase}`)
    assert.include(text, `Base HD Path:  ${HD_PATH}{account_index}`)

    // minting adds a block rather than extending the first one
    await postAdmin('admin/temporary-accounts-generation?accounts=2')
    const grouped = await roster()
    const blocks = grouped.split('\n\nAvailable Accounts\n')
    const listed = (await (await fetch(`${baseUrl}/admin/accounts-json`)).json()) as {
      mnemonic: string
      privateKeys: string[]
      more: { mnemonic: string; privateKeys: string[] }[]
    }
    const wallets = [
      { mnemonic: listed.mnemonic, keys: listed.privateKeys },
      ...listed.more.map((batch) => ({ mnemonic: batch.mnemonic, keys: batch.privateKeys })),
    ]
    assert.strictEqual(blocks.length, wallets.length)

    // the whole point: within a block, the listed index IS the derivation
    // index, so `{account_index}` on the path line tells the truth
    blocks.forEach((block, position) => {
      const wallet = wallets[position]
      assert.include(block, `Mnemonic:      ${wallet.mnemonic}`)
      assert.include(block, `Base HD Path:  ${HD_PATH}{account_index}`)
      assert.deepEqual(derivePrivateKeys(wallet.mnemonic, wallet.keys.length), wallet.keys)
      wallet.keys.forEach((key, index) => {
        assert.include(block, `(${index}) ${key}`)
        assert.include(block, `(${index}) ${TronWeb.address.fromPrivateKey(key) as string} (`)
      })
      // a block never numbers past its own wallet
      assert.notInclude(block, `(${wallet.keys.length}) `)
    })

    // minting replies with the whole roster, and a fresh read matches it
    const generated = await postAdmin('admin/temporary-accounts-generation?accounts=1')
    assert.strictEqual(generated.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.strictEqual(await generated.text(), await roster())
  })

  it('renders addresses the three ways the format parameter names', async () => {
    const roster = async (query = ''): Promise<string> =>
      (await fetch(`${baseUrl}/admin/accounts${query}`)).text()
    const base58 = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const hex = TronWeb.address.toHex(base58) as string

    assert.include(await roster(), `(0) ${base58} (`)
    assert.include(await roster('?format=hex'), `(0) ${hex} (`)
    // both, the balance riding the indented hex line
    assert.match(await roster('?format=all'), new RegExp(`\\(0\\) ${base58}\\n {4}${hex} \\(`))
    // anything else is the default
    assert.include(await roster('?format=nonsense'), `(0) ${base58} (`)
  })

  it('reports balances as the chain holds them, not as they were funded', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    await treSend('tre_setAccountBalance', [owner, 1_500_000])
    const roster = await (await fetch(`${baseUrl}/admin/accounts`)).text()
    // fromSun keeps the fraction, so 1.5 TRX prints as 1.5
    assert.include(roster, `(0) ${owner} (1.5 TRX)`)
  })

  it('deduplicates configured accounts before listing them as a separate group', async () => {
    const phrase = utils.accounts.generateRandom().mnemonic!.phrase
    const derived = derivePrivateKeys(phrase, 1)[0] as string
    const explicit = utils.accounts.generateAccount().privateKey.toLowerCase()
    const configured = resolveConfig({
      mnemonic: { phrase, count: 1, balance: 1 },
      accounts: [
        { privateKey: derived, balance: 2 },
        { privateKey: explicit, balance: 3 },
        { privateKey: explicit.toUpperCase(), balance: 4 },
      ],
    })
    assert.deepEqual(configured.accounts, [
      { privateKey: derived, balance: 2n },
      { privateKey: explicit.toUpperCase(), balance: 4n },
    ])
    const duplicateNode = await TronNode.create(configured)
    const provider = new TronProvider(duplicateNode)
    const started = await startHttpServer(provider, { port: 0 })
    try {
      const listed = (await (await fetch(`${started.url}/admin/accounts-json`)).json()) as {
        privateKeys: string[]
        more: { privateKeys: string[]; more: unknown[] }[]
      }
      assert.deepEqual(listed.privateKeys, [derived])
      assert.deepEqual(listed.more, [
        {
          privateKeys: [derived, explicit.toUpperCase()],
          more: [],
        },
      ])
      assert.deepEqual(await duplicateNode.admin.accounts(), listed)
      assert.strictEqual(
        (
          await provider.request({
            method: 'wallet/getaccount',
            params: { address: TronWeb.address.fromPrivateKey(derived) as string },
          })
        ).balance,
        2n,
      )
      assert.strictEqual(
        (
          await provider.request({
            method: 'wallet/getaccount',
            params: { address: TronWeb.address.fromPrivateKey(explicit) as string },
          })
        ).balance,
        4n,
      )
      const text = await (await fetch(`${started.url}/admin/accounts`)).text()
      assert.strictEqual(text.split(derived).length - 1, 2)
      assert.strictEqual(text.split(explicit.toUpperCase()).length - 1, 1)
    } finally {
      started.server.close()
    }
  })

  it('mints and funds a batch of accounts, and lists it under more', async () => {
    const listing = async (): Promise<{
      privateKeys: string[]
      mnemonic: string
      hdPath: string
      more: { mnemonic: string; hdPath: string; privateKeys: string[]; more: unknown[] }[]
    }> => (await (await fetch(`${baseUrl}/admin/accounts-json`)).json()) as never

    const before = (await listing()).more.length

    await postAdmin('admin/temporary-accounts-generation?accounts=3')
    const minted = (await listing()).more.at(-1) as {
      mnemonic: string
      hdPath: string
      privateKeys: string[]
    }
    assert.strictEqual(minted.privateKeys.length, 3)
    // a batch is its own wallet, and its keys derive from that phrase
    assert.strictEqual(minted.mnemonic.split(' ').length, 12)
    assert.notStrictEqual(minted.mnemonic, config.mnemonic.phrase)
    assert.deepEqual(derivePrivateKeys(minted.mnemonic, 3), minted.privateKeys)
    assert.strictEqual(minted.hdPath, HD_PATH)

    // batches are append-only, so the new one lands at the end
    const after = await listing()
    assert.strictEqual(after.more.length, before + 1)
    assert.deepEqual(after.more[before], { ...minted, more: [] })
    // the genesis allocation is untouched by a minting run
    assert.deepEqual(
      after.privateKeys,
      accountsFromMnemonic(config.mnemonic).map((account) => account.privateKey),
    )

    // every minted key holds the same balance the genesis accounts got
    for (const privateKey of minted.privateKeys) {
      const address = TronWeb.address.fromPrivateKey(privateKey) as string
      assert.strictEqual(
        await tronWeb.trx.getBalance(address),
        Number(accountsFromMnemonic(config.mnemonic)[0].balance),
      )
    }
  })

  it('answers healthcheck in the media type the request asked for', async () => {
    const plain = await fetch(`${baseUrl}/healthcheck`)
    assert.strictEqual(plain.status, 200)
    assert.strictEqual(plain.headers.get('content-type'), 'text/plain; charset=utf-8')
    // written whole, with no line of its own
    assert.strictEqual(await plain.text(), 'OK')

    const asJSON = await fetch(`${baseUrl}/healthcheck`, {
      headers: { accept: 'application/json' },
    })
    assert.strictEqual(asJSON.headers.get('content-type'), 'application/json')
    assert.deepEqual(await asJSON.json(), { ok: true })

    // one servlet behind both verbs, and it reads no body
    const posted = await fetch(`${baseUrl}/healthcheck`, { method: 'POST' })
    assert.strictEqual(posted.status, 200)
    assert.strictEqual(await posted.text(), 'OK')
  })

  it('puts the whole roster on one balance, minted batches included', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const funded = Number(accountsFromMnemonic(config.mnemonic)[0].balance)
    await postAdmin('admin/temporary-accounts-generation?accounts=2')
    const minted = (
      (await (await fetch(`${baseUrl}/admin/accounts-json`)).json()) as {
        more: { privateKeys: string[] }[]
      }
    ).more.at(-1) as { privateKeys: string[] }
    const mintedAddress = TronWeb.address.fromPrivateKey(minted.privateKeys[0]) as string

    // one account below its funding, one above
    await treSend('tre_setAccountBalance', [owner, 7])
    await treSend('tre_setAccountBalance', [mintedAddress, 999_999_999_999])
    const height = async () =>
      (await tronWeb.trx.getCurrentBlock()).block_header.raw_data.number as number
    const before = await height()

    const reply = await postAdmin('admin/accounts-generation')
    assert.strictEqual(reply.status, 200)
    // the roster goes to the log; the reply carries nothing
    assert.strictEqual(await reply.text(), '')

    assert.strictEqual(await tronWeb.trx.getBalance(owner), funded)
    assert.strictEqual(await tronWeb.trx.getBalance(mintedAddress), funded)
    assert.strictEqual(await height(), before + 1)
  })

  it('funds the whole roster on a minting run, at the balance the request names', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    await treSend('tre_setAccountBalance', [owner, 7])

    // minting is a funding pass too: an account that is not part of the batch
    // still lands on the run's balance
    await postAdmin('admin/temporary-accounts-generation?accounts=1&defaultBalance=5')
    assert.strictEqual(await tronWeb.trx.getBalance(owner), 5_000_000)

    const listed = (await (await fetch(`${baseUrl}/admin/accounts-json`)).json()) as {
      more: { privateKeys: string[] }[]
    }
    const minted = TronWeb.address.fromPrivateKey(
      (listed.more.at(-1) as { privateKeys: string[] }).privateKeys[0],
    ) as string
    assert.strictEqual(await tronWeb.trx.getBalance(minted), 5_000_000)

    // with no balance named, the roster's own funding stands in
    await postAdmin('admin/temporary-accounts-generation?accounts=1')
    assert.strictEqual(
      await tronWeb.trx.getBalance(owner),
      Number(accountsFromMnemonic(config.mnemonic)[0].balance),
    )
    assert.strictEqual(
      await tronWeb.trx.getBalance(minted),
      Number(accountsFromMnemonic(config.mnemonic)[0].balance),
    )
  })

  it('takes a named balance only as far as the int64 the sun go into', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    // read as text: the sun at this scale are past what a double states exactly
    const balanceOf = async (): Promise<string> => {
      const text = await (
        await fetch(
          `${baseUrl}/wallet/getaccount?address=${owner}&visible=true&int64_as_string=true`,
        )
      ).text()
      return (/"balance":"(-?\d+)"/.exec(text) ?? [])[1] ?? ''
    }
    const named = async (trx: number): Promise<void> => {
      await postAdmin(`admin/temporary-accounts-generation?accounts=0&defaultBalance=${trx}`)
    }

    await named(9_223_372_036_854)
    assert.strictEqual(await balanceOf(), '9223372036854000000')

    await named(9_223_372_036_855)
    assert.strictEqual(await balanceOf(), String(accountsFromMnemonic(config.mnemonic)[0].balance))
  })

  it('answers the admin namespace and the rpc route only on the verbs they take', async () => {
    // Credential reads use GET; state-changing admin operations use POST.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const refused = await fetch(`${baseUrl}/admin/accounts`, { method })
      assert.strictEqual(refused.status, 405, method)
    }
    const posted = await fetch(`${baseUrl}/admin/accounts`, { method: 'POST' })
    assert.include(await posted.text(), `"servlet":"${CLIENT_NAME}:admin/accounts"`)
    for (const path of ['admin/accounts-generation', 'admin/temporary-accounts-generation']) {
      assert.strictEqual((await fetch(`${baseUrl}/${path}`)).status, 405)
      assert.strictEqual((await postAdmin(path)).status, 200)
    }

    // the JSON-RPC route declares doPost alone
    const got = await fetch(`${baseUrl}/tre`)
    assert.strictEqual(got.status, 405)
    assert.include(await got.text(), `"servlet":"${CLIENT_NAME}:tre"`)

    // one servlet answers for the whole namespace, so a path it does not name
    // is its own not-found rather than the wallet surface's
    const missing = await fetch(`${baseUrl}/admin/nosuchthing`)
    assert.strictEqual(missing.status, 404)
    assert.deepEqual(await missing.json(), { success: false, error: 'Not found' })
    // and the verb is judged before the path, so a POST there is still 405
    assert.strictEqual(
      (await fetch(`${baseUrl}/admin/nosuchthing`, { method: 'POST' })).status,
      405,
    )
  })

  it('traces a call into code a cheat write planted', async () => {
    // PUSH1 1 PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN — six steps and a return
    const contract = utils.accounts.generateAccount().address.base58
    const heightOf = async () =>
      (await tronWeb.trx.getCurrentBlock()).block_header.raw_data.number as number

    const before = await heightOf()
    await treSend('tre_setAccountCode', [contract, '0x600160005260206000f3'])
    // a cheat write lands in a block, so what it changed is part of the history
    // every later state root is read from
    assert.strictEqual(await heightOf(), before + 1)

    const unsigned = await tronWeb.transactionBuilder.triggerSmartContract(
      TronWeb.address.toHex(contract),
      'x()',
      { feeLimit: 100_000_000 },
      [],
      TronWeb.address.toHex(ownerBase58),
    )
    const signed = await tronWeb.trx.sign(unsigned.transaction)
    await tronWeb.trx.sendRawTransaction(signed)

    const trace = (await treSend('debug_traceTransaction', [`0x${signed.txID}`])) as {
      structLogs: { op: string }[]
      returnValue: string
    }
    assert.deepEqual(
      trace.structLogs.map((log) => log.op),
      ['PUSH1', 'PUSH1', 'MSTORE', 'PUSH1', 'PUSH1', 'RETURN'],
    )
    assert.strictEqual(trace.returnValue, `${'00'.repeat(31)}01`)
  })

  it('unknown methods yield a JSON-RPC error object', async () => {
    await expect(treSend('tre_nonsense', [])).rejects.toThrow(/does not exist/)
  })
})

describe('historical transaction traces', () => {
  async function fixture(http: boolean) {
    const messages: string[] = []
    const node = await TronNode.create({
      chainParameters: { unfreezeDelayDays: 3 },
      runtime: { logger: { log: (message) => messages.push(message) } },
    })
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const addresses = privateKeys.map((key) => TronWeb.address.fromPrivateKey(key) as string)
    const started = http ? await startHttpServer(provider, { port: 0 }) : undefined
    async function request<T = Record<string, unknown>>(
      method: string,
      params: ProviderParams = {},
    ): Promise<T> {
      if (started === undefined) return (await provider.request({ method, params })) as T
      const debug = method.startsWith('debug_')
      const reply = await fetch(`${started.url}/${debug ? 'tre' : method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(debug ? { jsonrpc: '2.0', id: 1, method, params } : params),
      })
      const body = await reply.json()
      if (debug && body.error) throw new Error(body.error.message)
      return debug ? body.result : body
    }
    async function send(tx: SignedTronTx, index = 0) {
      const signed = utils.crypto.signTransaction(privateKeys[index], tx)
      const reply = await request('wallet/broadcasttransaction', signed)
      assert.isTrue(reply.result, JSON.stringify(reply))
      return signed.txID
    }
    async function deploy(runtime: string, feeLimit = 100_000_000, percent = 100) {
      const size = (runtime.length / 2).toString(16).padStart(2, '0')
      return request<SignedTronTx & { contract_address: string }>('wallet/deploycontract', {
        owner_address: TronWeb.address.toHex(addresses[0]),
        abi: '[]',
        bytecode: `60${size}80600b6000396000f3${runtime}`,
        consume_user_resource_percent: percent,
        origin_energy_limit: 1_000_000,
        fee_limit: feeLimit,
      })
    }
    async function trigger(contract: string, index = 0) {
      const built = await request<{ transaction: SignedTronTx }>('wallet/triggersmartcontract', {
        owner_address: TronWeb.address.toHex(addresses[index]),
        contract_address: contract,
        data: '00000001',
        fee_limit: 100_000_000,
      })
      return send(built.transaction, index)
    }
    return {
      node,
      provider,
      addresses,
      request,
      send,
      deploy,
      trigger,
      messages,
      close: async () => {
        await node.tre.blockTime(0)
        if (started !== undefined) {
          await new Promise<void>((resolve, reject) =>
            started.server.close((error) => (error ? reject(error) : resolve())),
          )
        }
      },
    }
  }

  for (const http of [false, true]) {
    it(`${http ? 'HTTP' : 'program'} trace of a plain transfer leaves recipient code unexecuted`, async () => {
      const f = await fixture(http)
      try {
        await f.node.tre.setAccountCode(f.addresses[2], INC_RUNTIME)
        const txid = await f.send(
          await f.request<SignedTronTx>('wallet/createtransaction', {
            owner_address: TronWeb.address.toHex(f.addresses[0]),
            to_address: TronWeb.address.toHex(f.addresses[2]),
            amount: 50,
          }),
        )
        const trace = await f.request<TransactionTrace>('debug_traceTransaction', [`0x${txid}`])
        assert.isFalse(trace.failed)
        assert.strictEqual(BigInt(trace.gas), 0n)
        assert.strictEqual(trace.returnValue, '')
        assert.deepEqual(trace.structLogs, [])
        assert.deepEqual(
          (await f.node.debug.storageRangeAt('latest', 0, f.addresses[2], null, 10)).storage,
          {},
        )
      } finally {
        await f.close()
      }
    })

    for (const scenario of [
      'balance limit',
      'code deposit limit',
      'successful deploy',
      'revert',
    ] as const) {
      it(`${http ? 'HTTP' : 'program'} trace preserves ${scenario} after later state changes`, async () => {
        const f = await fixture(http)
        try {
          const deployment = scenario === 'code deposit limit' || scenario === 'successful deploy'
          const built = await f.deploy(
            scenario === 'revert' ? '60006000fd' : deployment ? '00' : INC_RUNTIME,
            scenario === 'code deposit limit' ? 10_000 : 100_000_000,
          )
          let txid = await f.send(built)
          if (!deployment) {
            await f.node.tre.increaseTime(86_400)
            if (scenario === 'balance limit')
              await f.node.tre.setAccountBalance(f.addresses[0], 1000)
            txid = await f.trigger(built.contract_address)
          }
          const receipt = await f.request<TransactionInfo>('wallet/gettransactioninfobyid', {
            value: txid,
          })
          const expected =
            scenario === 'successful deploy'
              ? 'SUCCESS'
              : scenario === 'revert'
                ? 'REVERT'
                : 'OUT_OF_ENERGY'
          assert.strictEqual(receipt.receipt?.result, expected)
          const original = await f.request<TransactionTrace>('debug_traceTransaction', [
            `0x${txid}`,
          ])
          assert.strictEqual(original.failed, expected !== 'SUCCESS')
          assert.strictEqual(BigInt(original.gas), BigInt(receipt.receipt!.energy_usage_total!))
          assert.strictEqual(original.returnValue, receipt.contractResult?.[0] ?? '')
          assert.isAbove(original.structLogs.length, 0)
          if (scenario === 'balance limit')
            assert.strictEqual(BigInt(original.structLogs[0].gas), 10n)
          if (scenario === 'code deposit limit') assert.strictEqual(BigInt(original.gas), 100n)
          if (scenario === 'successful deploy') assert.strictEqual(BigInt(original.gas), 221n)

          await f.node.tre.setAccountBalance(f.addresses[0], 1_000_000_000)
          await f.node.tre.setAccountCode(built.contract_address, '00')
          await f.node.tre.setAccountStorageAt(built.contract_address, '00', '09')
          await f.node.tre.increaseTime(86_400)
          await f.node.tre.blockTime(60)
          const pending = await f.request<SignedTronTx>('wallet/createtransaction', {
            owner_address: TronWeb.address.toHex(f.addresses[1]),
            to_address: TronWeb.address.toHex(f.addresses[2]),
            amount: 1,
          })
          await f.send(pending, 1)
          const snapshot = async () =>
            Promise.all([
              f.request('wallet/getnowblock'),
              f.request('wallet/getaccount', { address: TronWeb.address.toHex(f.addresses[0]) }),
              f.request('wallet/getaccountresource', {
                address: TronWeb.address.toHex(f.addresses[0]),
              }),
              f.request('wallet/getburntrx'),
              f.request('wallet/gettransactionlistfrompending'),
              f.node.debug.storageRangeAt('latest', 0, built.contract_address, null, 10),
            ])
          const before = await snapshot()
          const produced = () =>
            f.messages.filter((message) => message.includes('Produced block')).length
          const count = produced()
          for (let i = 0; i < 2; i++) {
            assert.deepEqual(
              await f.request<TransactionTrace>('debug_traceTransaction', [`0x${txid}`]),
              original,
            )
            assert.deepEqual(await f.node.debug.traceTransaction(txid), original)
          }
          assert.deepEqual(await snapshot(), before)
          assert.strictEqual(produced(), count)
          assert.deepEqual(
            await f.request<TransactionInfo>('wallet/gettransactioninfobyid', { value: txid }),
            receipt,
          )
        } finally {
          await f.close()
        }
      })
    }

    it(`${http ? 'HTTP' : 'program'} trace retains the origin's historical energy contribution`, async () => {
      const f = await fixture(http)
      try {
        await f.send(
          await f.request<SignedTronTx>('wallet/freezebalancev2', {
            owner_address: TronWeb.address.toHex(f.addresses[0]),
            frozen_balance: 2_000_000_000,
            resource: 'ENERGY',
          }),
        )
        const built = await f.deploy(INC_RUNTIME, 100_000_000, 0)
        await f.send(built)
        await f.node.tre.setAccountBalance(f.addresses[1], 1000)
        const txid = await f.trigger(built.contract_address, 1)
        const receipt = await f.request<TransactionInfo>('wallet/gettransactioninfobyid', {
          value: txid,
        })
        assert.strictEqual(receipt.receipt?.result, 'SUCCESS')
        assert.isAbove(Number(receipt.receipt?.origin_energy_usage), 0)
        const trace = await f.request<TransactionTrace>('debug_traceTransaction', [`0x${txid}`])
        assert.isFalse(trace.failed)
        assert.strictEqual(BigInt(trace.gas), BigInt(receipt.receipt!.energy_usage_total!))
        assert.isAbove(Number(BigInt(trace.structLogs[0].gas)), 10)
        await f.send(
          await f.request<SignedTronTx>('wallet/updatesetting', {
            owner_address: TronWeb.address.toHex(f.addresses[0]),
            contract_address: built.contract_address,
            consume_user_resource_percent: 100,
          }),
        )
        await f.send(
          await f.request<SignedTronTx>('wallet/unfreezebalancev2', {
            owner_address: TronWeb.address.toHex(f.addresses[0]),
            unfreeze_balance: 2_000_000_000,
            resource: 'ENERGY',
          }),
        )
        assert.deepEqual(
          await f.request<TransactionTrace>('debug_traceTransaction', [`0x${txid}`]),
          trace,
        )
      } finally {
        await f.close()
      }
    })
  }
})
