import { TronWeb, utils } from 'tronweb'
import { assert, describe, it } from 'vitest'

import { DEFAULT_BALANCE_SUN, TronNode, TronProvider, startHttpServer } from '../../src/index.ts'

import type { AccountConfigInput, InitialConfigInput, NodeAccounts } from '../../src/index.ts'

const extraKey = utils.accounts.generateAccount().privateKey.toLowerCase()
const phrase = utils.accounts.generateRandom().mnemonic!.phrase

async function fixture(input: InitialConfigInput = {}) {
  const node = await TronNode.create(input)
  const config = node.config
  const provider = new TronProvider(node)
  const started = await startHttpServer(provider, { port: 0 })
  return {
    config,
    node,
    provider,
    async readHTTP(): Promise<NodeAccounts> {
      const response = await fetch(`${started.url}/admin/accounts-json`)
      assert.strictEqual(response.status, 200)
      return response.json()
    },
    async close() {
      started.server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        started.server.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    },
  }
}

function addressOf(privateKey: string) {
  return TronWeb.address.fromPrivateKey(privateKey) as string
}

async function balanceOf(provider: TronProvider, address: string) {
  return (
    (await provider.request({ method: 'wallet/getaccount', params: { address } })).balance ?? 0n
  )
}

describe('public development account discovery', () => {
  const cases: { name: string; input: InitialConfigInput; count: number; extraKeys: string[] }[] = [
    { name: 'default accounts', input: {}, count: 10, extraKeys: [] },
    {
      name: 'a custom mnemonic and one additional account',
      input: {
        mnemonic: { phrase, count: 2, balance: '5000000' },
        accounts: [{ privateKey: extraKey, balance: '250000000' }],
      },
      count: 2,
      extraKeys: [extraKey],
    },
    {
      name: 'duplicate additional accounts',
      input: {
        mnemonic: { phrase, count: 1 },
        accounts: [
          { privateKey: extraKey, balance: 2 },
          { privateKey: extraKey.toUpperCase(), balance: 3 },
        ],
      },
      count: 1,
      extraKeys: [extraKey.toUpperCase()],
    },
  ]

  for (const { name, input, count, extraKeys } of cases) {
    it(`returns funded keys consistently through node, provider and HTTP for ${name}`, async () => {
      const { node, config, provider, readHTTP, close } = await fixture(input)
      try {
        const accounts = await node.admin.accounts()
        assert.hasAllKeys(accounts, ['mnemonic', 'hdPath', 'privateKeys', 'more'])
        assert.strictEqual(accounts.mnemonic, config.mnemonic.phrase)
        assert.strictEqual(accounts.hdPath, "m/44'/195'/0'/0/")
        assert.lengthOf(accounts.privateKeys, count)
        assert.strictEqual(new Set(accounts.privateKeys).size, count)
        for (const key of accounts.privateKeys) {
          assert.match(key, /^[0-9a-f]{64}$/)
          assert.strictEqual(await balanceOf(provider, addressOf(key)), config.mnemonic.balance)
        }
        assert.deepEqual(
          accounts.more,
          extraKeys.length === 0 ? [] : [{ privateKeys: extraKeys, more: [] }],
        )
        for (const account of config.accounts) {
          assert.strictEqual(
            await balanceOf(provider, addressOf(account.privateKey)),
            account.balance,
          )
        }
        assert.deepEqual(accounts, await provider.request({ method: 'admin/accounts-json' }))
        assert.deepEqual(accounts, await readHTTP())
        assert.deepEqual(node.config.mnemonic, config.mnemonic)
        assert.deepEqual(node.config.accounts, config.accounts)
      } finally {
        await close()
      }
    })
  }

  for (const withExtra of [false, true]) {
    it(`includes newly generated groups ${withExtra ? 'after' : 'without'} additional accounts`, async () => {
      const accounts: AccountConfigInput[] = withExtra ? [{ privateKey: extraKey }] : []
      const { node, provider, readHTTP, close } = await fixture({ accounts })
      try {
        const before = await node.admin.accounts()
        const generating = provider.request({
          method: 'admin/temporary-accounts-generation',
          params: { accounts: 2 },
        })
        const reading = node.admin.accounts()
        await generating
        const after = await reading
        assert.deepEqual(after.privateKeys, before.privateKeys)
        assert.deepEqual(after.more.slice(0, before.more.length), before.more)
        assert.lengthOf(after.more, before.more.length + 1)
        const batch = after.more[before.more.length]
        assert.hasAllKeys(batch, ['mnemonic', 'hdPath', 'privateKeys', 'more'])
        assert.isString(batch.mnemonic)
        assert.notStrictEqual(batch.mnemonic, after.mnemonic)
        assert.strictEqual(batch.hdPath, after.hdPath)
        assert.lengthOf(batch.privateKeys, 2)
        assert.deepEqual(batch.more, [])
        for (const key of batch.privateKeys) {
          assert.strictEqual(await balanceOf(provider, addressOf(key)), DEFAULT_BALANCE_SUN)
        }
        assert.deepEqual(after, await provider.request({ method: 'admin/accounts-json' }))
        assert.deepEqual(after, await readHTTP())
        assert.lengthOf(before.more, withExtra ? 1 : 0)
      } finally {
        await close()
      }
    })
  }

  it('returns independently mutable snapshots, including nested groups', async () => {
    const { node, provider, readHTTP, close } = await fixture({
      accounts: [{ privateKey: extraKey }],
    })
    try {
      await provider.request({
        method: 'admin/temporary-accounts-generation',
        params: { accounts: 1 },
      })
      const snapshot = await node.admin.accounts()
      const expected = structuredClone(snapshot)
      snapshot.mnemonic = 'changed'
      snapshot.hdPath = 'changed'
      snapshot.privateKeys[0] = 'changed'
      snapshot.more[0].privateKeys.length = 0
      snapshot.more[0].more.push({ privateKeys: [], more: [] })
      snapshot.more[1].mnemonic = 'changed'
      snapshot.more[1].hdPath = 'changed'
      snapshot.more[1].privateKeys[0] = 'changed'
      snapshot.more.length = 0
      assert.deepEqual(await node.admin.accounts(), expected)
      assert.deepEqual(await provider.request({ method: 'admin/accounts-json' }), expected)
      assert.deepEqual(await readHTTP(), expected)
    } finally {
      await close()
    }
  })
})
