import { rejects } from 'node:assert/strict'
import { Clock } from '../../src/core/clock.ts'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { TronWeb, utils } from 'tronweb'
import { assert, afterEach, beforeEach, describe, it, vi } from 'vitest'

import { MAX_ACCOUNT_COUNT } from '../../src/config.ts'
import { DEFAULT_BALANCE_SUN, TronNode, TronProvider, startHttpServer } from '../../src/index.ts'

import type { IntegerInput, StartedServer } from '../../src/index.ts'

const SLOT = `0x${'00'.repeat(32)}`
const CODE = '0x600160005500'
const extraKey = utils.accounts.generateAccount().privateKey.toLowerCase()

describe('namespaced development APIs', () => {
  let node: TronNode
  let provider: TronProvider
  let started: StartedServer
  let owner: string
  let receiver: string

  beforeEach(async () => {
    node = await createNode(
      { accounts: [{ privateKey: extraKey, balance: 7 }] },
      new Clock(() => 1_800_000_000_000),
    )
    provider = new TronProvider(node)
    started = await startHttpServer(provider, { port: 0 })
    const { privateKeys } = await node.admin.accounts()
    ;[owner, receiver] = privateKeys.map((key) => TronWeb.address.fromPrivateKey(key) as string)
  })

  afterEach(async () => {
    await node.tre.blockTime(0)
    started.server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      started.server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  })

  async function rpc(method: string, params: unknown[]) {
    const response = await fetch(`${started.url}/tre`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const reply = (await response.json()) as { result?: unknown; error?: { message: string } }
    if (reply.error !== undefined) throw new Error(reply.error.message)
    return reply.result
  }

  const request = (method: string, params: unknown[]) => provider.request({ method, params })

  const balance = async (address: string) =>
    (await provider.request({ method: 'wallet/getaccount', params: { address } })).balance ?? 0n
  const head = () => provider.request({ method: 'wallet/getnowblock' })
  const height = async () => (await head()).block_header.raw_data.number

  async function traceCode(code: string, feeLimit = 100_000_000) {
    await node.tre.setAccountCode(receiver, code)
    await node.tre.unlockedAccounts([owner])
    const built = await provider.request({
      method: 'wallet/triggersmartcontract',
      params: {
        owner_address: owner,
        contract_address: receiver,
        data: '00',
        fee_limit: feeLimit,
      },
    })
    const tx = built.transaction!
    assert.isDefined(tx)
    assert.isTrue(
      (await provider.request({ method: 'wallet/broadcasttransaction', params: tx })).result,
    )
    const info = await provider.request({
      method: 'wallet/gettransactioninfobyid',
      params: { value: tx.txID },
    })
    const trace = await node.debug.traceTransaction(tx.txID)
    assert.strictEqual(BigInt(trace.gas), BigInt(info.receipt?.energy_usage_total as bigint))
    assert.deepEqual(await request('debug_traceTransaction', [tx.txID]), trace)
    assert.deepEqual(await rpc('debug_traceTransaction', [`0x${tx.txID}`]), trace)
    return trace
  }

  it('traces existing storage reads at the pre-op boundary', async () => {
    await node.tre.setAccountStorageAt(receiver, '00', '2a')
    const trace = await traceCode('6000545000')
    const load = trace.structLogs.find((step) => step.op === 'SLOAD')!
    const pop = trace.structLogs.find((step) => step.op === 'POP')!
    assert.deepEqual(load.storage, {})
    assert.strictEqual(pop.stack.at(-1), '2a'.padStart(64, '0'))
    assert.strictEqual(pop.storage[SLOT.slice(2)], '2a'.padStart(64, '0'))
  })

  it('distinguishes an absent storage read from an explicit zero write', async () => {
    const trace = await traceCode('60005450600060005500')
    const pop = trace.structLogs.find((step) => step.op === 'POP')!
    assert.strictEqual(pop.stack.at(-1), '0'.repeat(64))
    assert.deepEqual(pop.storage, {})
    assert.deepEqual(trace.structLogs.at(-1)!.storage, { [SLOT.slice(2)]: '0'.repeat(64) })
  })

  it.each(['call', 'delegate', 'reverted delegate'] as const)(
    'isolates storage for %s frames',
    async (kind) => {
      const child = utils.accounts.generateAccount().address.hex
      await node.tre.setAccountCode(
        child,
        `60026000556003600155${kind === 'reverted delegate' ? '60006000fd' : '00'}`,
      )
      const args = `6000600060006000${kind === 'call' ? '6000' : ''}73${child.slice(2)}61ffff`
      const call = `${args}${kind === 'call' ? 'f1' : 'f4'}50`
      const trace = await traceCode(`6001600055${call}6000545000`)
      const pop = [...trace.structLogs]
        .reverse()
        .find((step) => step.depth === 1 && step.op === 'POP')!
      const expected = kind === 'delegate' ? 2 : 1
      assert.strictEqual(BigInt(`0x${pop.stack.at(-1)}`), BigInt(expected))
      assert.strictEqual(BigInt(`0x${pop.storage[SLOT.slice(2)]}`), BigInt(expected))
      const secondSlot = '1'.padStart(64, '0')
      if (kind === 'delegate') assert.strictEqual(BigInt(`0x${pop.storage[secondSlot]}`), 3n)
      else assert.notProperty(pop.storage, secondSlot)
      const store = trace.structLogs.find((step) => step.op === 'SSTORE')!
      assert.deepEqual(store.storage, {})
    },
  )

  it('does not print an unexecuted SSTORE value as stored state', async () => {
    const trace = await traceCode('600160005500', 1000)
    assert.isTrue(trace.failed)
    assert.deepEqual(trace.structLogs.at(-1)!.storage, {})
  })

  it('rejects a trace storage-read failure without hanging or changing node state', async () => {
    await traceCode('600160005500')
    const block = await head()
    const txid = block.transactions![0].txID
    const state = () => node.debug.storageRangeAt('latest', 0, receiver, null, 10)
    const before = await state()
    const core = nodeCore(node)
    const copy = await core.vm.shallowCopy()
    let readingSnapshot = false
    copy.tvm.events?.on('step', (step) => {
      readingSnapshot = step.opcode.name === 'STOP'
    })
    const getStorage = copy.stateManager.getStorage.bind(copy.stateManager)
    const failedRead = vi
      .spyOn(copy.stateManager, 'getStorage')
      .mockImplementation(async (...args) => {
        if (readingSnapshot) throw new Error('trace storage unavailable')
        return getStorage(...args)
      })
    const replay = vi.spyOn(core.vm, 'shallowCopy').mockResolvedValueOnce(copy)
    try {
      await rejects(node.debug.traceTransaction(txid), /trace storage unavailable/)
      assert.deepEqual(await head(), block)
      assert.deepEqual(await state(), before)
    } finally {
      replay.mockRestore()
      failedRead.mockRestore()
    }
    assert.isFalse((await node.debug.traceTransaction(txid)).failed)
  })

  it.each(['f1', 'f2', 'f4', 'fa', 'd0'])(
    'traces reserved CALL energy for opcode %s without charging it',
    async (opcode) => {
      const child = utils.accounts.generateAccount().address.hex
      await node.tre.setAccountCode(child, '00')
      const extra = opcode === 'd0' ? '60006000' : opcode === 'f1' || opcode === 'f2' ? '6000' : ''
      const args = `6000600060006000${extra}73${child.slice(2)}`
      const overhead = 40
      for (const reserved of [0, 1000]) {
        const trace = await traceCode(
          `${args}61${reserved.toString(16).padStart(4, '0')}${opcode}5000`,
        )
        const call = trace.structLogs.find(
          (step) => step.depth === 1 && step.op !== 'POP' && !step.op.startsWith('PUSH'),
        )!
        assert.strictEqual(call.gasCost, overhead + reserved)
        // STOP consumes none of the reserved amount. PUSHes cost 3; the caller POP costs 2.
        const pushes = opcode === 'd0' ? 8 : opcode === 'f1' || opcode === 'f2' ? 7 : 6
        assert.strictEqual(BigInt(trace.gas), BigInt(overhead + pushes * 3 + 2))
      }
      const capped = await traceCode(`${args}63ffffffff${opcode}5000`, 1_000_000)
      const call = capped.structLogs.find(
        (step) => step.depth === 1 && step.op !== 'POP' && !step.op.startsWith('PUSH'),
      )!
      assert.strictEqual(BigInt(call.gasCost), BigInt(call.gas))
    },
  )

  it('excludes the value stipend and covers calls rejected before child execution', async () => {
    const child = utils.accounts.generateAccount().address.hex
    await node.tre.setAccountCode(child, '00')
    for (const funded of [false, true]) {
      await node.tre.setAccountBalance(receiver, funded ? 1 : 0)
      const trace = await traceCode(`6000600060006000600173${child.slice(2)}6103e8f15000`)
      const call = trace.structLogs.find((step) => step.op === 'CALL')!
      assert.strictEqual(call.gasCost, 40 + 9000 + 1000)
      assert.strictEqual(
        trace.structLogs.some((step) => step.depth === 2),
        funded,
      )
      // The producer adds the 2,300 stipend after computing the traced reservation.
      if (funded)
        assert.strictEqual(BigInt(trace.structLogs.find((step) => step.depth === 2)!.gas), 3300n)
    }
  })

  it('includes CALL memory expansion while keeping precompile billing separate', async () => {
    const child = utils.accounts.generateAccount().address.hex
    await node.tre.setAccountCode(child, '00')
    const expanded = await traceCode(`6020600060006000600073${child.slice(2)}6103e8f15000`)
    const call = expanded.structLogs.find((step) => step.op === 'CALL')!
    assert.strictEqual(call.gasCost, 40 + 3 + 1000)
    assert.strictEqual(BigInt(expanded.gas), 40n + 3n + 21n + 2n)
    // Identity consumes 15 energy for empty input; the second address access is warm.
    const identity = '6000600060006000600060046103e8f150'
    const precompile = await traceCode(`${identity}${identity}00`)
    assert.deepEqual(
      precompile.structLogs.filter((step) => step.op === 'CALL').map((step) => step.gasCost),
      [40 + 1000, 40 + 1000],
    )
    assert.strictEqual(BigInt(precompile.gas), 2n * (40n + 15n + 21n + 2n))
  })

  it('reuses code, bytes, current block heights and storage cursors', async () => {
    const target = receiver
    const code = new Uint8Array([0x60, 0x00, 0x54, 0x00])
    const writing = node.tre.setAccountCode(owner, code)
    code.fill(0xff)
    await writing
    const contract = await provider.request({
      method: 'wallet/getcontractinfo',
      params: { value: owner },
    })
    assert.strictEqual(contract.runtimecode, '60005400')
    await provider.request({
      method: 'tre_setAccountCode',
      params: [target, contract.runtimecode!],
    })
    assert.strictEqual(
      (await provider.request({ method: 'wallet/getcontractinfo', params: { value: target } }))
        .runtimecode,
      contract.runtimecode,
    )
    const slot = new Uint8Array([0])
    const value = new Uint8Array([5])
    const storing = node.tre.setAccountStorageAt(owner, slot, value)
    slot[0] = 10
    value[0] = 9
    await storing
    await provider.request({
      method: 'tre_setAccountStorageAt',
      params: [owner, new Uint8Array([1]), '0X06'],
    })
    const block = await node.tre.mine()
    const first = await node.debug.storageRangeAt(block.number, 0, owner, null, 1)
    assert.strictEqual(Object.values(first.storage)[0].value, `${'00'.repeat(31)}05`)
    assert.isString(first.nextKey)
    for (const ref of [
      Number(block.number),
      String(block.number),
      `0x${block.number.toString(16)}`,
      block.blockID,
    ]) {
      assert.deepEqual(await node.debug.storageRangeAt(ref, 0, owner, null, 1), first)
    }
    assert.deepEqual(
      await provider.request({
        method: 'debug_storageRangeAt',
        params: [block.number, 0, owner, null, 1],
      }),
      first,
    )
    const second = await node.debug.storageRangeAt(block.number, 0, owner, first.nextKey, 1)
    const row = Object.values(second.storage)[0]
    assert.strictEqual(row.value, `${'00'.repeat(31)}06`)
    assert.isNull(second.nextKey)
    // A range key is a pagination key, not a raw slot; reuse the value with the original slot.
    await node.tre.setAccountStorageAt(target, '01', row.value)
    assert.strictEqual(
      Object.values((await node.debug.storageRangeAt('latest', 0, target, null, 1)).storage)[0]
        .value,
      row.value,
    )
    await rejects(node.debug.storageRangeAt('bad', 0, owner, null, 1), /block/)
    await rejects(node.debug.storageRangeAt(block.number, 0, owner, null, 1), /current state/)
  })

  it('rejects bad temporary-account inputs before creating accounts or resetting balances', async () => {
    const accounts = await node.admin.accounts()
    await node.tre.setAccountBalance(owner, 123)
    const before = await head()
    const invalid = [
      null,
      { accounts: -1 },
      { count: 1 },
      { accounts: null },
      { accounts: '' },
      { accounts: MAX_ACCOUNT_COUNT + 1 },
      { defaultBalance: 0.5 },
      { defaultBalance: 'wrong' },
      { defaultBalance: Number.MAX_SAFE_INTEGER },
    ]
    for (const options of invalid) {
      await rejects(Reflect.apply(node.admin.temporaryAccountsGeneration, node.admin, [options]))
      await rejects(
        provider.request({
          method: String('admin/temporary-accounts-generation'),
          params: options!,
        }),
      )
      assert.deepEqual(await node.admin.accounts(), accounts)
      assert.strictEqual(await balance(owner), 123n)
      assert.deepEqual(await head(), before)
    }
    const generated = await node.admin.temporaryAccountsGeneration({
      accounts: '1',
      defaultBalance: 2n,
    })
    assert.lengthOf(generated.more[1].privateKeys, 1)
    assert.strictEqual(
      await balance(TronWeb.address.fromPrivateKey(generated.more[1].privateKeys[0]) as string),
      2_000_000n,
    )
    assert.strictEqual(await balance(owner), 2_000_000n)
    const legacy = await fetch(
      `${started.url}/admin/temporary-accounts-generation?accounts=-1&defaultBalance=bad`,
      { method: 'POST' },
    )
    assert.strictEqual(legacy.status, 200)
    assert.lengthOf((await node.admin.accounts()).more[2].privateKeys, 10)
    assert.strictEqual(await balance(owner), DEFAULT_BALANCE_SUN)
  })

  it('rejects rounded numbers and preserves exact large balances', async () => {
    const before = await head()
    await rejects(node.tre.setAccountBalance(owner, Number.MAX_SAFE_INTEGER + 1), /string/)
    await rejects(
      provider.request({
        method: 'tre_setAccountBalance',
        params: [owner, Number.MAX_SAFE_INTEGER + 1],
      }),
      /string/,
    )
    assert.strictEqual(await balance(owner), DEFAULT_BALANCE_SUN)
    assert.deepEqual(await head(), before)
    for (const amount of [
      9007199254740993n,
      '9007199254740993',
      '0x20000000000001',
    ] satisfies IntegerInput[]) {
      await node.tre.setAccountBalance(owner, amount)
      assert.strictEqual(await balance(owner), 9007199254740993n)
      await provider.request({ method: 'tre_setAccountBalance', params: [owner, amount] })
      assert.strictEqual(await balance(owner), 9007199254740993n)
    }
  })

  it('mines each state change and exposes its result through all query paths', async () => {
    const before = await height()
    assert.isTrue(await node.tre.setAccountBalance(receiver, '250000000'))
    assert.strictEqual(await balance(receiver), 250_000_000n)
    assert.isTrue(await node.tre.setAccountCode(receiver, CODE))
    assert.strictEqual(
      (await provider.request({ method: 'wallet/getcontractinfo', params: { value: receiver } }))
        .runtimecode,
      CODE.slice(2),
    )
    assert.isTrue(await node.tre.setAccountStorageAt(receiver, SLOT, '0x05'))
    assert.strictEqual(await height(), before + 3)

    const args = ['latest', 0, receiver, '0x', 1] as const
    const range = await node.debug.storageRangeAt(...args)
    assert.lengthOf(Object.keys(range.storage), 1)
    assert.strictEqual(Object.values(range.storage)[0].value, `${'00'.repeat(31)}05`)
    assert.isNull(range.nextKey)
    assert.deepEqual(range, await request('debug_storageRangeAt', [...args]))
    assert.deepEqual(range, await rpc('debug_storageRangeAt', [...args]))
    Object.values(range.storage)[0].value = 'changed'
    assert.strictEqual(
      Object.values((await node.debug.storageRangeAt(...args)).storage)[0].value,
      `${'00'.repeat(31)}05`,
    )
  })

  it('unlocks an account for unsigned broadcasts', async () => {
    const tx = await provider.request({
      method: 'wallet/createtransaction',
      params: {
        owner_address: TronWeb.address.toHex(owner),
        to_address: TronWeb.address.toHex(receiver),
        amount: 123,
      },
    })
    if ('Error' in tx) throw new Error(tx.Error)
    const broadcast = () => provider.request({ method: 'wallet/broadcasttransaction', params: tx })
    assert.isFalse((await broadcast()).result)
    const before = await balance(receiver)
    assert.isTrue(await node.tre.unlockedAccounts([owner]))
    assert.isTrue((await broadcast()).result)
    assert.strictEqual(await balance(receiver), before + 123n)
  })

  it.each([
    { name: 'fixed-cost ADD', code: '600160020100', costs: [3, 3, 3, 0] },
    { name: 'EXP with exponent 0', code: '600060020a00', costs: [3, 3, 10, 0] },
    { name: 'EXP with exponent 1', code: '600160020a00', costs: [3, 3, 20, 0] },
    { name: 'EXP with exponent 256', code: '61010060020a00', costs: [3, 3, 30, 0] },
    {
      name: 'MSTORE with and without memory expansion',
      code: '6001600052600160005200',
      costs: [3, 3, 4, 3, 3, 1, 0],
    },
  ])('reports each opcode cost once when tracing $name', async ({ code, costs }) => {
    await node.tre.setAccountCode(receiver, code)
    await node.tre.unlockedAccounts([owner])
    const built = await provider.request({
      method: 'wallet/triggersmartcontract',
      params: {
        owner_address: owner,
        contract_address: receiver,
        data: '00',
        fee_limit: 100_000_000,
      },
    })
    assert.isDefined(built.transaction)
    const transaction = built.transaction!
    const sent = await provider.request({
      method: 'wallet/broadcasttransaction',
      params: transaction,
    })
    assert.isTrue(sent.result)
    const receipt = await provider.request({
      method: 'wallet/gettransactioninfobyid',
      params: { value: transaction.txID },
    })
    const trace = await node.debug.traceTransaction(transaction.txID)
    assert.isFalse(trace.failed)
    assert.deepEqual(
      trace.structLogs.map((step) => step.gasCost),
      costs,
    )
    for (let i = 0; i < trace.structLogs.length - 1; i++) {
      assert.strictEqual(
        BigInt(trace.structLogs[i].gas) - BigInt(trace.structLogs[i + 1].gas),
        BigInt(costs[i]),
      )
    }
    const total = BigInt(costs.reduce((sum, cost) => sum + cost, 0))
    assert.strictEqual(BigInt(trace.gas), total)
    assert.strictEqual(receipt.receipt?.energy_usage_total, total)
    const args = [`0x${transaction.txID}`]
    assert.deepEqual(await request('debug_traceTransaction', args), trace)
    assert.deepEqual(await rpc('debug_traceTransaction', args), trace)
  })

  it.each(['node', 'provider', 'http'] as const)(
    'leaves every account locked when an unlock batch fails through %s',
    async (transport) => {
      const unlock = (accounts: string[]) =>
        transport === 'node'
          ? node.tre.unlockedAccounts(accounts)
          : transport === 'provider'
            ? request('tre_unlockedAccounts', [accounts])
            : rpc('tre_unlockedAccounts', [accounts])
      const transactions = await Promise.all(
        [owner, receiver].map((address) =>
          provider.request({
            method: 'wallet/createtransaction',
            params: {
              owner_address: address,
              to_address: address === owner ? receiver : owner,
              amount: 17,
            },
          }),
        ),
      )
      const before = await head()
      const balances = await Promise.all([balance(owner), balance(receiver)])
      for (const index of [0, 1, 2]) {
        const accounts = [owner, receiver]
        accounts.splice(index, 0, 'not-an-address')
        await rejects(unlock(accounts), /address/)
        for (const tx of transactions) {
          if ('Error' in tx) throw new Error(tx.Error)
          const reply = await provider.request({
            method: 'wallet/broadcasttransaction',
            params: tx,
          })
          assert.deepInclude(reply, { result: false, code: 'SIGERROR' })
        }
        assert.deepEqual(await head(), before)
        assert.deepEqual(await Promise.all([balance(owner), balance(receiver)]), balances)
      }
      assert.isTrue(await unlock([owner, owner, receiver]))
      for (const tx of transactions) {
        if ('Error' in tx) throw new Error(tx.Error)
        assert.isTrue(
          (await provider.request({ method: 'wallet/broadcasttransaction', params: tx })).result,
        )
      }
    },
  )

  it('creates temporary accounts and resets the complete account list', async () => {
    const outside = utils.accounts.generateAccount().address.base58
    await node.tre.setAccountBalance(outside, 777n)
    const before = await node.admin.accounts()
    const beforeHeight = await height()
    const generated = await node.admin.temporaryAccountsGeneration({
      accounts: 2,
      defaultBalance: 3,
    })
    assert.strictEqual(await height(), beforeHeight + 1)
    assert.deepEqual(generated.privateKeys, before.privateKeys)
    assert.lengthOf(generated.more, 2)
    assert.deepEqual(generated.more[0], before.more[0])
    assert.lengthOf(generated.more[1].privateKeys, 2)
    assert.isString(generated.more[1].mnemonic)
    assert.deepEqual(generated, await node.admin.accounts())
    assert.deepEqual(generated, await provider.request({ method: 'admin/accounts-json' }))
    assert.deepEqual(generated, await (await fetch(`${started.url}/admin/accounts-json`)).json())
    const keys = [...generated.privateKeys, ...generated.more.flatMap((group) => group.privateKeys)]
    for (const key of keys) {
      assert.strictEqual(await balance(TronWeb.address.fromPrivateKey(key) as string), 3_000_000n)
    }

    await node.admin.accountsGeneration()
    assert.strictEqual(await height(), beforeHeight + 2)
    for (const key of keys) {
      assert.strictEqual(
        await balance(TronWeb.address.fromPrivateKey(key) as string),
        DEFAULT_BALANCE_SUN,
      )
    }
    assert.strictEqual(await balance(outside), 777n)
    generated.more[1].privateKeys.length = 0
    assert.lengthOf((await node.admin.accounts()).more[1].privateKeys, 2)
    assert.deepEqual(node.config.accounts, [{ privateKey: extraKey, balance: 7n }])
  })

  it('uses the same temporary-account defaults and retains the existing zero-count behavior', async () => {
    const generated = await node.admin.temporaryAccountsGeneration()
    assert.lengthOf(generated.more[1].privateKeys, 10)
    await node.tre.setAccountBalance(owner, 1)
    const empty = await node.admin.temporaryAccountsGeneration({ accounts: 0 })
    assert.lengthOf(empty.more, 3)
    assert.deepEqual(empty.more[2].privateKeys, [])
    assert.isString(empty.more[2].mnemonic)
    assert.strictEqual(await balance(owner), DEFAULT_BALANCE_SUN)
    assert.deepEqual(empty, await provider.request({ method: 'admin/accounts-json' }))
  })

  it('rejects invalid state and debug operations through node, provider and HTTP', async () => {
    const cases: [string, unknown[], () => Promise<unknown>][] = [
      ['tre_setAccountBalance', [receiver, -1], () => node.tre.setAccountBalance(receiver, -1)],
      [
        'tre_setAccountBalance',
        [receiver, '1.5'],
        () => node.tre.setAccountBalance(receiver, '1.5'),
      ],
      ['tre_setAccountCode', [receiver, 'zz'], () => node.tre.setAccountCode(receiver, 'zz')],
      ['tre_setAccountCode', ['bad', CODE], () => node.tre.setAccountCode('bad', CODE)],
      [
        'tre_setAccountStorageAt',
        [receiver, SLOT, `0x${'01'.repeat(33)}`],
        () => node.tre.setAccountStorageAt(receiver, SLOT, `0x${'01'.repeat(33)}`),
      ],
      ['tre_unlockedAccounts', [{}], () => node.tre.unlockedAccounts({} as never)],
      ['debug_traceTransaction', ['0x01'], () => node.debug.traceTransaction('0x01')],
      [
        'debug_storageRangeAt',
        ['latest', 1, receiver, '0x', 1],
        () => node.debug.storageRangeAt('latest', 1, receiver, '0x', 1),
      ],
      [
        'debug_storageRangeAt',
        ['latest', 0, receiver, '0x', 0],
        () => node.debug.storageRangeAt('latest', 0, receiver, '0x', 0),
      ],
    ]
    const before = await head()
    const beforeBalance = await balance(receiver)
    for (const [method, params, direct] of cases) {
      await rejects(direct)
      await rejects(request(method, params))
      await rejects(rpc(method, params))
    }
    assert.deepEqual(await head(), before)
    assert.strictEqual(await balance(receiver), beforeBalance)
    await rejects(rpc('debug_traceTransaction', ['ab'.repeat(32)]), /hex must begin with 0x/)
  })

  it('keeps facade changes away from provider dispatch and other nodes', async () => {
    const other = await TronNode.create()
    assert.strictEqual(node.tre, node.tre)
    assert.strictEqual(node.admin, node.admin)
    assert.strictEqual(node.debug, node.debug)
    assert.notStrictEqual(node.tre, other.tre)
    assert.notStrictEqual(node.admin, other.admin)
    assert.notStrictEqual(node.debug, other.debug)
    const identity = node.admin.info()
    assert.strictEqual(
      await (await fetch(`${started.url}/admin`)).text(),
      `${identity.name} ${identity.version}`,
    )
    identity.name = 'changed'
    assert.notStrictEqual(node.admin.info().name, identity.name)

    const fail = () => {
      throw new Error('public facade was invoked')
    }
    node.tre.setAccountBalance = fail
    node.admin.accounts = fail
    node.debug.storageRangeAt = fail
    assert.isTrue(await rpc('tre_setAccountBalance', [receiver, 99]))
    assert.strictEqual(await balance(receiver), 99n)
    assert.lengthOf((await provider.request({ method: 'admin/accounts-json' })).privateKeys, 10)
    assert.deepEqual(await rpc('debug_storageRangeAt', ['latest', 0, receiver, '0x', 1]), {
      storage: {},
      nextKey: null,
    })
    assert.lengthOf((await other.admin.accounts()).privateKeys, 10)
  })
})
