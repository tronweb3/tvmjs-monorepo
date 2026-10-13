import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TronWeb, utils } from 'tronweb'
import { assert, describe, it, vi } from 'vitest'

import { runCli } from '../../src/cli.ts'
import { CLIENT_VERSION, accountsFromMnemonic } from '../../src/config.ts'
import { DEV_MNEMONIC, derivePrivateKeys } from '../../src/hdWallet.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'

import type { ChildProcess } from 'node:child_process'

/** a port nothing holds, taken and released so the CLI can bind it */
async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as { port: number }
  probe.close()
  await once(probe, 'close')
  return port
}

function stopCli(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** run the shipped entry point until it says what it bound, or give up */
async function startCli(
  port: number,
  extra: string[] = [],
): Promise<{ child: ChildProcess; output: () => string }> {
  const child = spawn(
    'npx',
    [
      'tsx',
      '--conditions=typescript',
      'bin/cli.ts',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      ...extra,
    ],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe'],
      // its own process group: the kill must take npx's whole tree (tsx, node)
      detached: true,
    },
  )
  let text = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    text += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    text += chunk.toString()
  })
  const deadline = Date.now() + 30_000
  while (!text.includes('Listening on') && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { child, output: () => text }
}

describe('the command line entry point', () => {
  it('prints its usage and starts nothing when asked for help', async () => {
    const said: string[] = []
    const log = console.log
    console.log = (line: unknown) => said.push(String(line))
    try {
      await runCli(['--help'])
    } finally {
      console.log = log
    }
    assert.include(said.join('\n'), `TVMJS v${CLIENT_VERSION} - a TRON dev node`)
    assert.include(said.join('\n'), 'Usage: tvmjs')
    assert.include(said.join('\n'), '--port')
    assert.include(said.join('\n'), '-v, --version      Print version')
  })

  it('prints its version and starts nothing when asked for it', async () => {
    for (const flag of ['--version', '-v']) {
      const said: string[] = []
      const log = console.log
      console.log = (line: unknown) => said.push(String(line))
      try {
        await runCli([flag])
      } finally {
        console.log = log
      }
      assert.strictEqual(said.join('\n').trim(), CLIENT_VERSION)
    }
  })

  it('refuses a flag it does not know, by message and without a stack', async () => {
    const said: string[] = []
    const error = console.error
    console.error = (line: unknown) => said.push(String(line))
    const previous = process.exitCode
    try {
      await runCli(['--wrong'])
    } finally {
      console.error = error
      process.exitCode = previous
    }
    assert.include(said.join('\n'), "Error: Unknown option '--wrong'")
    assert.include(said.join('\n'), "Try 'tvmjs --help'")
    // every refusal signs off with a blank line and the version
    assert.include(said.join('\n'), `\n\nTVMJS v${CLIENT_VERSION}`)
    assert.notMatch(said.join('\n'), /^\s+at /m)
  })

  it('refuses a port it cannot parse, by message and without a stack', async () => {
    const said: string[] = []
    const error = console.error
    console.error = (line: unknown) => said.push(String(line))
    const previous = process.exitCode
    try {
      await runCli(['--port', 'abc'])
    } finally {
      console.error = error
      process.exitCode = previous
    }
    assert.include(said.join('\n'), 'Error: Invalid value "abc" for --port')
    assert.include(said.join('\n'), `\n\nTVMJS v${CLIENT_VERSION}`)
    assert.notMatch(said.join('\n'), /^\s+at /m)
  })

  it('serves the chain on the port it was given', async () => {
    const port = await freePort()
    const { child, output } = await startCli(port)
    try {
      assert.include(output(), `TVMJS v${CLIENT_VERSION} - a TRON dev node`, output())
      // the banner lists what a caller can sign with before anything is served
      assert.include(output(), 'Available Accounts')
      assert.match(output(), /\(0\) T[1-9A-HJ-NP-Za-km-z]{33} \(\d+ TRX\)/)
      assert.include(output(), `Listening on 127.0.0.1:${port}`)

      const reply = await fetch(`http://127.0.0.1:${port}/wallet/getnowblock`)
      assert.strictEqual(reply.status, 200)
      assert.isString(((await reply.json()) as { blockID?: string }).blockID)
    } finally {
      stopCli(child)
    }
  }, 60_000)

  it('starts with CLZ and Osaka signature-input validation enabled', async () => {
    const port = await freePort()
    const { child, output } = await startCli(port)
    const url = `http://127.0.0.1:${port}`
    const [owner, contract] = derivePrivateKeys(DEV_MNEMONIC, 2).map(
      (key) => TronWeb.address.fromPrivateKey(key) as string,
    )
    const post = async (path: string, body: unknown) =>
      (
        await fetch(`${url}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()
    try {
      assert.include(output(), 'Listening on')
      for (const [code, expected] of [
        ['60011e60005260206000f3', 'ff'.padStart(64, '0')],
        ['60206000606060006009612710fa60005260206000f3', '0'.repeat(64)],
        ['6020600060606000600a612710fa60005260206000f3', '0'.repeat(64)],
      ]) {
        const installed = await post('tre', {
          jsonrpc: '2.0',
          id: 1,
          method: 'tre_setAccountCode',
          params: [contract, `0x${code}`],
        })
        assert.isTrue(installed.result)
        const result = await post('wallet/triggerconstantcontract', {
          owner_address: owner,
          contract_address: contract,
          data: '00',
          visible: true,
        })
        assert.isTrue(result.result?.result)
        assert.deepEqual(result.constant_result, [expected])
      }
    } finally {
      stopCli(child)
    }
  }, 60_000)

  it('logs committed blocks from manual, immediate and interval mining', async () => {
    const port = await freePort()
    const { child, output } = await startCli(port)
    const url = `http://127.0.0.1:${port}`
    const [ownerKey, receiverKey] = derivePrivateKeys(DEV_MNEMONIC, 2)
    const tronWeb = new TronWeb({ fullHost: url, privateKey: ownerKey })
    const receiver = TronWeb.address.fromPrivateKey(receiverKey) as string
    const lines = () =>
      output()
        .split('\n')
        .filter((line) => line.includes('Produced block'))
    const rpc = async (method: string, params: unknown[]) => {
      const response = await fetch(`${url}/tre`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      assert.isUndefined(((await response.json()) as { error?: unknown }).error)
    }
    const send = async (amount: number) => {
      const unsigned = await tronWeb.transactionBuilder.sendTrx(receiver, amount)
      const extended = await tronWeb.transactionBuilder.extendExpiration(unsigned, 120, {
        txLocal: true,
      })
      const signed = await tronWeb.trx.sign(extended)
      assert.isTrue((await tronWeb.trx.sendRawTransaction(signed)).result)
      return signed
    }
    try {
      assert.include(output(), `Listening on 127.0.0.1:${port}`)
      assert.lengthOf(lines(), 1)
      assert.include(lines()[0], 'Produced block number=1 txs=0')
      await rpc('tre_mine', [{ blocks: 2 }])
      await vi.waitFor(() => assert.lengthOf(lines(), 3))
      assert.include(lines()[1], 'Produced block number=2 txs=0')
      assert.include(lines()[2], 'Produced block number=3 txs=0')

      const immediate = await send(100)
      await vi.waitFor(() => assert.lengthOf(lines(), 4))
      assert.include(lines()[3], 'Produced block number=4 txs=1')

      await rpc('tre_blockTime', [60])
      await send(200)
      await send(300)
      assert.lengthOf(lines(), 4)
      await rpc('tre_mine', [{ blocks: 1 }])
      await vi.waitFor(() => assert.lengthOf(lines(), 5))
      assert.include(lines()[4], 'Produced block number=5 txs=2')

      const rejected = await tronWeb.trx.sendRawTransaction({ ...immediate, signature: [] })
      assert.notStrictEqual(rejected.result, true)
      assert.isString(rejected.code)
      await rpc('tre_blockTime', [1])
      await vi.waitFor(() => assert.isAtLeast(lines().length, 6), { timeout: 5_000, interval: 50 })
      await rpc('tre_blockTime', [0])
      assert.include(lines()[5], 'Produced block number=6 txs=0')
      assert.match(lines()[0], /^\[\d{2}-\d{2}\|\d{2}:\d{2}:\d{2}\] INFO /)
      assert.include(output(), 'INFO POST tre_blockTime')
      assert.notInclude(output(), 'POST /tre')
      assert.notInclude(output(), 'status=200')
    } finally {
      stopCli(child)
    }
  }, 60_000)

  it('--init reshapes the chain birth state from a file at any path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmjs-init-'))
    const file = join(dir, 'birth.json')
    const phrase = utils.accounts.generateRandom().mnemonic!.phrase
    const extraAccount = utils.accounts.generateAccount()
    writeFileSync(
      file,
      JSON.stringify({
        chainParameters: { unfreezeDelayDays: 1, freeNetLimit: 5000 },
        accounts: [{ privateKey: `0x${extraAccount.privateKey}`, balance: '123000000' }],
        mnemonic: phrase,
      }),
    )
    const port = await freePort()
    const { child, output } = await startCli(port, ['--init', file])
    try {
      // the mnemonic reseeded the derived roster: ten accounts from the given
      // phrase, and the dev-phrase accounts are gone
      const derived0 = TronWeb.address.fromPrivateKey(derivePrivateKeys(phrase, 1)[0] as string)
      const dev0 = TronWeb.address.fromPrivateKey(derivePrivateKeys(DEV_MNEMONIC, 1)[0] as string)
      assert.include(output(), `(0) ${derived0} (10000 TRX)`)
      assert.include(output(), `Mnemonic:      ${phrase}`)
      assert.match(output(), /\(9\) T/)
      assert.notInclude(output(), String(dev0))
      // the extra account rides its own block, numbered from (0) again
      const extra = extraAccount.address.base58
      assert.include(output(), `(0) ${extra} (123 TRX)`)
      const account = (await (
        await fetch(`http://127.0.0.1:${port}/wallet/getaccount`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: extra, visible: true }),
        })
      ).json()) as { balance?: number }
      assert.strictEqual(account.balance, 123_000_000)
      const reply = (await (
        await fetch(`http://127.0.0.1:${port}/wallet/getchainparameters`)
      ).json()) as { chainParameter: { key: string; value?: number }[] }
      const params = new Map(reply.chainParameter.map((entry) => [entry.key, entry.value]))
      assert.strictEqual(params.get('getUnfreezeDelayDays'), 1)
      assert.strictEqual(params.get('getFreeNetLimit'), 5000)
    } finally {
      stopCli(child)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('--init accounts add to the dev roster instead of replacing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmjs-init-'))
    const file = join(dir, 'birth.json')
    const extraAccount = utils.accounts.generateAccount()
    const defaultBalanceAccount = utils.accounts.generateAccount()
    writeFileSync(
      file,
      JSON.stringify({
        accounts: [
          { privateKey: extraAccount.privateKey, balance: '7000000' },
          { privateKey: defaultBalanceAccount.privateKey },
        ],
      }),
    )
    const port = await freePort()
    const { child, output } = await startCli(port, ['--init', file])
    try {
      const dev0 = TronWeb.address.fromPrivateKey(derivePrivateKeys(DEV_MNEMONIC, 1)[0] as string)
      const extra = extraAccount.address.base58
      const defaulted = defaultBalanceAccount.address.base58
      assert.include(output(), `(0) ${dev0} (10000 TRX)`)
      assert.include(output(), `Mnemonic:      ${DEV_MNEMONIC}`)
      assert.include(output(), `(0) ${extra} (7 TRX)`)
      assert.include(output(), `(1) ${defaulted} (10000 TRX)`)
    } finally {
      stopCli(child)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('--init mnemonic object reseeds with count and balance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmjs-init-'))
    const file = join(dir, 'birth.json')
    const phrase = utils.accounts.generateRandom().mnemonic!.phrase
    writeFileSync(file, JSON.stringify({ mnemonic: { phrase, count: 3, balance: '5000000' } }))
    const port = await freePort()
    const { child, output } = await startCli(port, ['--init', file])
    try {
      const derived0 = TronWeb.address.fromPrivateKey(derivePrivateKeys(phrase, 1)[0] as string)
      assert.include(output(), `(0) ${derived0} (5 TRX)`)
      assert.include(output(), `Mnemonic:      ${phrase}`)
      assert.match(output(), /\(2\) T/)
      assert.notMatch(output(), /\(3\) T/)
    } finally {
      stopCli(child)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('shows the actual balance in both groups when a configured key overlaps the mnemonic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmjs-init-'))
    const file = join(dir, 'birth.json')
    const privateKey = derivePrivateKeys(DEV_MNEMONIC, 1)[0]
    const address = TronWeb.address.fromPrivateKey(privateKey) as string
    writeFileSync(
      file,
      JSON.stringify({
        mnemonic: { phrase: DEV_MNEMONIC, count: 1, balance: '1000000' },
        accounts: [{ privateKey, balance: '250000000' }],
      }),
    )
    const port = await freePort()
    const { child, output } = await startCli(port, ['--init', file])
    try {
      const balanceRows = (text: string) =>
        text.split('\n').filter((line) => line.includes(address) && line.includes('TRX'))
      const expected = [`(0) ${address} (250 TRX)`, `(0) ${address} (250 TRX)`]
      assert.deepEqual(balanceRows(output()), expected)
      const listing = await (await fetch(`http://127.0.0.1:${port}/admin/accounts`)).text()
      assert.deepEqual(balanceRows(listing), expected)
      assert.include(output(), listing.trimEnd())
      const account = await (
        await fetch(`http://127.0.0.1:${port}/wallet/getaccount`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, visible: true }),
        })
      ).json()
      assert.strictEqual(account.balance, 250_000_000)
    } finally {
      stopCli(child)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('applies one JSON birth-state shape identically through the API and --init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmjs-init-'))
    const file = join(dir, 'birth.json')
    const phrase = utils.accounts.generateRandom().mnemonic!.phrase
    const privateKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    // Deliberately deserialize first: this is the JSON value an embedding
    // receives after importing a .json file, not a hand-built bigint config.
    const birthState = JSON.parse(
      JSON.stringify({
        mnemonic: { phrase, count: 1, balance: '5000000' },
        accounts: [{ privateKey, balance: '250000000' }],
        chainParameters: { unfreezeDelayDays: 1 },
      }),
    )
    writeFileSync(file, JSON.stringify(birthState))

    const embedded = await TronNode.create(birthState)
    const derived = derivePrivateKeys(phrase, 1)[0] as string
    const extra = TronWeb.address.fromPrivateKey(privateKey) as string
    assert.deepStrictEqual(accountsFromMnemonic(embedded.config.mnemonic), [
      { privateKey: derived, balance: 5_000_000n },
    ])
    assert.deepStrictEqual(embedded.config.accounts, [{ privateKey, balance: 250_000_000n }])
    assert.strictEqual(
      (
        await new TronProvider(embedded).request({
          method: 'wallet/getaccount',
          params: { address: extra },
        })
      ).balance,
      250_000_000n,
    )
    assert.strictEqual(embedded.config.chainParameters.unfreezeDelayDays, 1)

    const port = await freePort()
    const { child, output } = await startCli(port, ['--init', file])
    try {
      assert.include(output(), `(0) ${TronWeb.address.fromPrivateKey(derived)} (5 TRX)`)
      assert.include(output(), `(0) ${extra} (250 TRX)`)
      const account = (await (
        await fetch(`http://127.0.0.1:${port}/wallet/getaccount`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: extra, visible: true }),
        })
      ).json()) as { balance?: number }
      assert.strictEqual(account.balance, 250_000_000)
    } finally {
      stopCli(child)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('--init refuses what it cannot honor, with its origin and without a stack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmjs-init-'))
    const typo = join(dir, 'typo.json')
    const said: string[] = []
    const error = console.error
    console.error = (line: unknown) => said.push(String(line))
    const previous = process.exitCode
    const rerun = async (body: string | null): Promise<string> => {
      said.length = 0
      if (body !== null) writeFileSync(typo, body)
      await runCli(['--init', body === null ? join(dir, 'absent.json') : typo])
      return said.join('\n')
    }
    try {
      assert.match(await rerun(null), /no such file or directory \(ENOENT\)/)
      // the origin line names the flag and file; the reason follows on the next line
      assert.include(
        said.join('\n'),
        `Error: --init ${join(dir, 'absent.json')}\nno such file or directory`,
      )

      assert.include(await rerun('{oops'), 'Not valid JSON:')
      assert.include(await rerun('"hi"'), 'The initial configuration must be an object')
      assert.include(await rerun(JSON.stringify({ listenPort: 9090 })), 'Unknown key "listenPort"')
      assert.include(await rerun(JSON.stringify({ runtime: {} })), 'Unknown key "runtime"')
      assert.include(
        await rerun(JSON.stringify({ common: { eips: [7939] } })),
        'Unknown key "common"',
      )
      assert.include(
        await rerun(JSON.stringify({ chainParameters: { unfrezeDelayDays: 1 } })),
        'Unknown chain parameter "unfrezeDelayDays"',
      )
      assert.include(
        await rerun(JSON.stringify({ chainParameters: { energyFee: 0 } })),
        'chainParameters.energyFee must be an integer of at least 1, got 0',
      )
      assert.include(
        await rerun(JSON.stringify({ chainParameters: { freeNetLimit: 200_000 } })),
        'chainParameters.freeNetLimit must be an integer between 0 and 100000, got 200000',
      )
      assert.include(
        await rerun('{"chainParameters":{"transactionFee":9007199254740993}}'),
        'chainParameters.transactionFee must be a safe integer, got 9007199254740992',
      )
      assert.strictEqual(process.exitCode, 1)
      assert.include(
        await rerun(JSON.stringify({ accounts: [{ privateKey: 'xy', balance: 1 }] })),
        'accounts[0].privateKey holds characters that are not hex digits',
      )
      const { privateKey } = utils.accounts.generateAccount()
      for (const balance of ['', '  ']) {
        assert.include(
          await rerun(JSON.stringify({ accounts: [{ privateKey, balance }] })),
          'accounts[0].balance must be an integer in sun',
        )
        assert.include(
          await rerun(JSON.stringify({ mnemonic: { phrase: DEV_MNEMONIC, balance } })),
          'mnemonic.balance must be an integer in sun',
        )
      }
      assert.include(
        await rerun(JSON.stringify({ accounts: [{ privateKey, balance: null }] })),
        'accounts[0].balance must be an integer in sun',
      )
      assert.include(
        await rerun(
          JSON.stringify({
            mnemonic: {
              phrase: utils.accounts.generateRandom().mnemonic!.phrase,
              balance: null,
            },
          }),
        ),
        'mnemonic.balance must be an integer in sun',
      )
      assert.include(
        await rerun(
          JSON.stringify({
            accounts: [{ privateKey, balance: '9223372036854775808' }],
          }),
        ),
        'accounts[0].balance must be at most 9223372036854775807, got 9223372036854775808',
      )
      assert.include(
        await rerun(
          `{"accounts":[{"privateKey":"${'00'.repeat(32)}","balance":9007199254740993}]}`,
        ),
        'accounts[0].balance is past what a JSON number states exactly; write it as a string',
      )
      // The string preserves every digit, reaching the invalid-key check.
      // The zero key keeps this refusal test from starting an HTTP server.
      assert.include(
        await rerun(
          JSON.stringify({
            accounts: [{ privateKey: '00'.repeat(32), balance: '9007199254740993' }],
          }),
        ),
        'accounts[0].privateKey is not a key this wallet accepts',
      )
      assert.include(
        await rerun(JSON.stringify({ mnemonic: 'hello world' })),
        'mnemonic is not a valid BIP-39 phrase',
      )
      assert.include(
        await rerun(JSON.stringify({ mnemonic: { phrase: 'x', count: 0 } })),
        'mnemonic.count must be an integer of at least 1, got 0',
      )
      for (const count of [-1, 1.5, null, '1']) {
        assert.include(
          await rerun(JSON.stringify({ mnemonic: { phrase: DEV_MNEMONIC, count } })),
          `mnemonic.count must be an integer of at least 1, got ${String(count)}`,
        )
      }
      const text = said.join('\n')
      assert.include(text, `\n\nTVMJS v${CLIENT_VERSION}`)
      assert.notMatch(text, /^\s+at /m)
    } finally {
      console.error = error
      process.exitCode = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a port it cannot take, without a stack', async () => {
    const held = createServer()
    held.listen(0, '127.0.0.1')
    await once(held, 'listening')
    const { port } = held.address() as { port: number }
    try {
      const said: string[] = []
      const error = console.error
      console.error = (line: unknown) => said.push(String(line))
      const previous = process.exitCode
      try {
        await runCli(['--port', String(port), '--host', '127.0.0.1'])
      } finally {
        console.error = error
        process.exitCode = previous
      }
      assert.match(said.join('\n'), /Error: .*EADDRINUSE/)
      assert.include(said.join('\n'), `\n\nTVMJS v${CLIENT_VERSION}`)
      // the message alone; a dev node prints no stack for this
      assert.notMatch(said.join('\n'), /^\s+at /m)
    } finally {
      held.close()
      await once(held, 'close')
    }
  })
})
