import { rejects } from 'node:assert/strict'

import { TronWeb, utils } from 'tronweb'
import { assert, describe, expectTypeOf, it } from 'vitest'

import * as api from '../../src/index.ts'

// Only the package entry point is used here: no core access or injected state.
const NODE_MEMBERS = ['config', 'runtime', 'tre', 'admin', 'debug'] as const

function transferAmount(tx: Partial<api.TronTransaction>) {
  const contract = tx.raw_data!.contract[0]
  if (contract.type !== 'TransferContract') assert.fail('Expected a transfer contract')
  return contract.parameter.value.amount
}

async function fixture() {
  const node = await api.TronNode.create()
  const provider = new api.TronProvider(node)
  const { privateKeys } = await node.admin.accounts()
  const ownerKey = privateKeys[0]
  const [owner, receiver] = privateKeys.map((key) => TronWeb.address.fromPrivateKey(key) as string)
  const request = (method: string, params: api.ProviderParams = {}) =>
    provider.request({ method, params })
  const balance = async (address: string) =>
    (await provider.request({ method: 'wallet/getaccount', params: { address } })).balance ?? 0n
  const head = () => provider.request({ method: 'wallet/getnowblock' })
  const transfer = async () => {
    const unsigned = await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: receiver, amount: 1_234 },
    })
    if ('Error' in unsigned) throw new Error(unsigned.Error)
    const signed = utils.crypto.signTransaction(ownerKey, unsigned)
    const reply = await provider.request({ method: 'wallet/broadcasttransaction', params: signed })
    if (!reply.result) throw new Error('transfer failed')
    return reply.txid
  }
  return { node, provider, ownerKey, owner, receiver, request, transfer, balance, head }
}

describe('the public node boundary', () => {
  it.each([0, 60])(
    'uses each transaction ID for TRON CREATE, simulation and replay with block time %s',
    async (blockTime) => {
      const { node, provider, ownerKey, owner, receiver } = await fixture()
      // Create two empty-code children and return both TRON address words.
      await node.tre.setAccountCode(receiver, '600060006000f0600052600060006000f060205260406000f3')
      const params = { owner_address: owner, contract_address: receiver, fee_limit: 100_000_000 }
      const createdWords = (txid: string) =>
        [0, 1]
          .map((nonce) => {
            const hash = utils.ethersUtils.keccak256(
              `0x${txid}${nonce.toString(16).padStart(16, '0')}`,
            )
            return `41${hash.slice(-40)}`.padStart(64, '0')
          })
          .join('')
      const constant = await provider.request({ method: 'wallet/triggerconstantcontract', params })
      assert.isTrue(constant.result?.result)
      assert.strictEqual(constant.constant_result?.[0], createdWords(constant.transaction!.txID))
      const estimate = await provider.request({ method: 'wallet/estimateenergy', params })
      assert.isTrue(estimate.result?.result)
      assert.isAbove(estimate.energy_required!, 0)

      await node.tre.blockTime(blockTime)
      try {
        const txids: string[] = []
        for (const data of ['01', '02']) {
          const built = await provider.request({
            method: 'wallet/triggersmartcontract',
            params: { ...params, data },
          })
          const signed = utils.crypto.signTransaction(ownerKey, built.transaction!)
          const sent = await provider.request({
            method: 'wallet/broadcasttransaction',
            // CREATE uses the canonical hash, not a caller-supplied txID.
            params: data === '02' ? { ...signed, txID: 'ff'.repeat(32) } : signed,
          })
          assert.isTrue(sent.result)
          if (!sent.result) throw new Error('broadcast failed')
          assert.strictEqual(sent.txid, signed.txID)
          const words = createdWords(signed.txID)
          assert.deepEqual(
            sent.internal_transactions?.map((call) => call.transferTo_address),
            [words.slice(22, 64), words.slice(86, 128)],
          )
          txids.push(signed.txID)
        }
        if (blockTime > 0) {
          const block = await node.tre.mine()
          assert.strictEqual(block.txs.length, 2)
        }
        for (const txid of txids) {
          const info = await provider.request({
            method: 'wallet/gettransactioninfobyid',
            params: { value: txid },
          })
          assert.strictEqual(info.receipt?.result, 'SUCCESS')
          assert.strictEqual(info.contractResult?.[0], createdWords(txid))
          const trace = await node.debug.traceTransaction(txid)
          assert.isFalse(trace.failed)
          assert.strictEqual(trace.returnValue, createdWords(txid))
        }
      } finally {
        await node.tre.blockTime(0)
      }
    },
  )

  it('uses the returned transaction ID when simulating a deployment', async () => {
    const { provider, owner } = await fixture()
    // Return ADDRESS from the constructor without installing a contract.
    const result = await provider.request({
      method: 'wallet/triggerconstantcontract',
      params: { owner_address: owner, contract_address: '', data: '3060005260206000f3' },
    })
    assert.isTrue(result.result?.result)
    const address = utils.ethersUtils
      .keccak256(`0x${result.transaction!.txID}${TronWeb.address.toHex(owner)}`)
      .slice(-40)
    assert.strictEqual(result.constant_result?.[0], address.padStart(64, '0'))
  })

  it('passes the deployment transaction ID into constructor CREATE and its trace', async () => {
    const { node, provider, ownerKey, owner } = await fixture()
    const built = (await provider.request({
      method: 'wallet/deploycontract',
      params: {
        owner_address: owner,
        bytecode: '600060006000f060005260206000f3',
        consume_user_resource_percent: 100,
        origin_energy_limit: 1,
        fee_limit: 100_000_000,
      },
    })) as api.TronTransaction
    const signed = utils.crypto.signTransaction(ownerKey, built)
    const sent = await provider.request({ method: 'wallet/broadcasttransaction', params: signed })
    assert.isTrue(sent.result)
    const info = await provider.request({
      method: 'wallet/gettransactioninfobyid',
      params: { value: signed.txID },
    })
    assert.strictEqual(info.receipt?.result, 'SUCCESS')
    const expectedCode =
      `41${utils.ethersUtils.keccak256(`0x${signed.txID}${'00'.repeat(8)}`).slice(-40)}`.padStart(
        64,
        '0',
      )
    const deployed = await provider.request({
      method: 'wallet/getcontractinfo',
      params: { value: built.contract_address! },
    })
    assert.strictEqual(deployed.runtimecode, expectedCode)
    const trace = await node.debug.traceTransaction(signed.txID)
    assert.isFalse(trace.failed)
    assert.strictEqual(trace.returnValue, expectedCode)
  })

  it.each([17, 17n, '17', '0x11'])(
    'builds and signs a transfer from %s without converting the returned transaction',
    async (amount) => {
      const { node, provider, ownerKey, owner, receiver, balance } = await fixture()
      const web = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey: ownerKey })
      const before = await balance(receiver)
      await node.tre.blockTime(60)
      try {
        const tx = await provider.request({
          method: 'wallet/createtransaction',
          params: { owner_address: owner, to_address: receiver, amount },
        })
        if ('Error' in tx) throw new Error(tx.Error)
        expectTypeOf(tx.raw_data.contract[0].parameter.value.amount).toEqualTypeOf<number>()
        assert.strictEqual(tx.raw_data.contract[0].parameter.value.amount, 17)
        const raw = tx.raw_data_hex
        const signed = await web.trx.sign(tx)
        assert.strictEqual(signed.raw_data_hex, raw)
        assert.strictEqual(signed.txID, tx.txID)
        assert.isTrue(
          (await provider.request({ method: 'wallet/broadcasttransaction', params: signed }))
            .result,
        )
        const pending = await provider.request({
          method: 'wallet/gettransactionfrompending',
          params: { value: tx.txID },
        })
        assert.strictEqual(transferAmount(pending), 17)
        const block = await node.tre.mine()
        assert.strictEqual(transferAmount(block.txs[0].transaction), 17)
        for (const method of [
          'wallet/gettransactionbyid',
          'walletsolidity/gettransactionbyid',
        ] as const) {
          const stored = await provider.request({ method, params: { value: tx.txID } })
          assert.strictEqual(transferAmount(stored), 17)
          assert.strictEqual(stored.raw_data_hex, raw)
        }
        const head = await provider.request({ method: 'wallet/getnowblock' })
        assert.strictEqual(transferAmount(head.transactions[0]), 17)
        assert.strictEqual(await balance(receiver), before + 17n)
      } finally {
        await node.tre.blockTime(0)
      }
    },
  )

  it('keeps the transfer encoder boundary and account balances exact', async () => {
    const { node, provider, ownerKey, owner, receiver, balance } = await fixture()
    const funded = 9_223_372_036_854_775_807n
    await node.tre.setAccountBalance(owner, funded)
    const web = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey: ownerKey })
    const amount = BigInt(Number.MAX_SAFE_INTEGER)
    const before = await balance(receiver)
    const tx = await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: receiver, amount },
    })
    if ('Error' in tx) throw new Error(tx.Error)
    assert.strictEqual(tx.raw_data.contract[0].parameter.value.amount, Number.MAX_SAFE_INTEGER)
    const signed = await web.trx.sign(tx)
    assert.isTrue(
      (await provider.request({ method: 'wallet/broadcasttransaction', params: signed })).result,
    )
    assert.strictEqual(await balance(receiver), before + amount)
    assert.strictEqual(typeof (await balance(owner)), 'bigint')
    await rejects(
      provider.request({
        method: 'wallet/createtransaction',
        params: { owner_address: owner, to_address: receiver, amount: amount + 1n },
      }),
      /widest this node signs for/,
    )
  })

  it('exposes only lifecycle, configuration and namespaced controls', async () => {
    expectTypeOf<keyof api.TronNode>().toEqualTypeOf<(typeof NODE_MEMBERS)[number]>()
    expectTypeOf<Parameters<typeof api.TronNode.create>>().toEqualTypeOf<
      [config?: api.ClientConfig]
    >()
    expectTypeOf<keyof api.TronProvider>().toEqualTypeOf<'node' | 'request'>()
    expectTypeOf<ReturnType<api.TronNode['admin']['accounts']>>().toEqualTypeOf<
      Promise<api.NodeAccounts>
    >()
    expectTypeOf<api.TronNode['tre']>().toEqualTypeOf<api.TreApi>()
    expectTypeOf<api.TronNode['admin']>().toEqualTypeOf<api.AdminApi>()
    expectTypeOf<api.TronNode['debug']>().toEqualTypeOf<api.DebugApi>()
    const { node, provider } = await fixture()
    assert.sameMembers(Object.keys(node.tre), [
      'mine',
      'increaseTime',
      'blockTime',
      'setAccountBalance',
      'setAccountCode',
      'setAccountStorageAt',
      'unlockedAccounts',
    ])
    assert.sameMembers(Object.keys(node.admin), [
      'info',
      'accounts',
      'temporaryAccountsGeneration',
      'accountsGeneration',
    ])
    assert.sameMembers(Object.keys(node.debug), ['traceTransaction', 'storageRangeAt'])
    assert.deepEqual(
      Object.getOwnPropertyNames(Object.getPrototypeOf(node)).sort(),
      ['constructor', ...NODE_MEMBERS].sort(),
    )
    assert.deepEqual(Reflect.ownKeys(node), [])
    assert.strictEqual(provider.node, node)
    assert.deepEqual(Reflect.ownKeys(provider), [])
  })

  it('keeps chain parameter changes local to each node and preserves validation', async () => {
    const defaults = (await api.TronNode.create()).config
    const expectedFee = defaults.chainParameters.energyFee
    const config = { chainParameters: { energyFee: expectedFee + 1 } }
    const node = await api.TronNode.create(config)
    config.chainParameters.energyFee = 0
    node.config.chainParameters.energyFee = 0
    defaults.chainParameters.energyFee = 0
    assert.strictEqual(node.config.chainParameters.energyFee, expectedFee + 1)
    const other = await api.TronNode.create()
    assert.strictEqual(other.config.chainParameters.energyFee, expectedFee)
    await rejects(api.TronNode.create(config), RangeError)
  })

  it('serves the same chain through HTTP and program requests', async () => {
    const { provider, head: queryHead } = await fixture()
    const started = await api.startHttpServer(provider, { port: 0 })
    try {
      const head = await (await fetch(`${started.url}/wallet/getnowblock`)).json()
      const direct = await queryHead()
      assert.strictEqual(head.blockID, direct.blockID)
      assert.deepEqual(head.block_header, direct.block_header)
      assert.isEmpty(direct.transactions)
      assert.notProperty(head, 'transactions')
      const identity = await fetch(`${started.url}/admin`)
      assert.include(identity.headers.get('content-type'), 'text/plain')
      assert.strictEqual(await identity.text(), `${api.CLIENT_NAME} ${api.CLIENT_VERSION}`)
      const mined = await fetch(`${started.url}/tre`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tre_mine',
          params: [{ blocks: 2 }],
        }),
      })
      assert.notProperty(await mined.json(), 'error')
      assert.strictEqual(
        (await queryHead()).block_header.raw_data.number,
        head.block_header.raw_data.number + 2,
      )
    } finally {
      started.server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        started.server.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    }
  })

  it('keeps providers on the node they were created for', async () => {
    const first = await fixture()
    const second = await fixture()
    const before = await second.balance(second.owner)
    await first.request('tre_setAccountBalance', [first.owner, '0x7'])
    assert.strictEqual(await first.balance(first.owner), 7n)
    assert.strictEqual(await second.balance(second.owner), before)
    const account = (await first.request('wallet/getaccount', {
      address: first.owner,
    })) as { balance: bigint }
    assert.strictEqual(account.balance, 7n)
  })

  it('returns independent account JSON including nested permissions', async () => {
    const { provider, owner } = await fixture()
    const query = () =>
      provider.request({ method: 'wallet/getaccount', params: { address: owner } })
    const account = await query()
    const before = structuredClone(account)
    account.balance = 0n
    assert.isArray(account.active_permission)
    if (Array.isArray(account.active_permission)) account.active_permission.splice(0)
    assert.deepEqual(await query(), before)
  })

  it('returns independent code and storage query results', async () => {
    const { node, receiver: address, provider } = await fixture()
    const slot = `0x${'00'.repeat(32)}`
    const value = `0x${'00'.repeat(31)}05`
    await node.tre.setAccountCode(address, '0x600160005500')
    await node.tre.setAccountStorageAt(address, slot, value)
    const code = await provider.request({
      method: 'wallet/getcontractinfo',
      params: { value: address },
    })
    code.runtimecode = ''
    assert.strictEqual(
      (await provider.request({ method: 'wallet/getcontractinfo', params: { value: address } }))
        .runtimecode,
      '600160005500',
    )
    const query = () => node.debug.storageRangeAt('latest', 0, address, null, 1)
    const entries = await query()
    const before = structuredClone(entries)
    const keys = Object.keys(entries.storage)
    assert.lengthOf(keys, 1)
    entries.storage[keys[0]].value = 'changed'
    delete entries.storage[keys[0]]
    assert.deepEqual(await query(), before)
  })

  it('returns block and transaction snapshots without execution internals', async () => {
    const { node, provider, transfer, head } = await fixture()
    await node.tre.blockTime(60)
    try {
      const txid = await transfer()
      const block = await node.tre.mine()
      const before = await head()
      assert.isFalse('block' in block)
      assert.isFalse('execution' in block.txs[0])
      const height = block.number
      block.number = 999n
      block.txs[0].blockNumber = 999n
      Reflect.set(block.txs[0].transaction as object, 'raw_data', {})
      Reflect.set(block.txs[0].info as object, 'blockNumber', 999)
      block.txs.splice(0)
      assert.deepEqual(await head(), before)
      const info = await provider.request({
        method: 'wallet/gettransactioninfobyid',
        params: { value: txid },
      })
      assert.strictEqual(BigInt(info.blockNumber!), height)
    } finally {
      await node.tre.blockTime(0)
    }

    const mined = await node.tre.mine()
    const minedID = mined.blockID
    mined.blockID = 'changed'
    assert.strictEqual((await head()).blockID, minedID)
    const advanced = await node.tre.increaseTime(1)
    const timestamp = advanced.timestampMs
    advanced.timestampMs = 0
    assert.strictEqual((await head()).block_header.raw_data.timestamp, timestamp)
  })

  it('does not expose stored transactions or receipts through provider replies', async () => {
    const { request, transfer, head } = await fixture()
    const txid = await transfer()
    const before = await head()
    const queries = [
      ['wallet/gettransactionbyid', { value: txid }],
      ['wallet/gettransactioninfobyid', { value: txid }],
      ['wallet/gettransactionreceiptbyid', { value: txid }],
      ['wallet/gettransactioninfobyblocknum', { num: before.block_header.raw_data.number }],
      ['wallet/getnowblock', {}],
    ] as const
    function overwrite(value: unknown): void {
      if (value === null || typeof value !== 'object') return
      for (const [key, entry] of Object.entries(value)) {
        overwrite(entry)
        Reflect.set(value, key, null)
      }
    }
    for (const [method, params] of queries) {
      const reply = await request(method, params)
      const expected = structuredClone(reply)
      overwrite(reply)
      assert.deepEqual(await request(method, params), expected, method)
      assert.deepEqual(await head(), before, method)
    }
  })
})
