import { rejects } from 'node:assert/strict'
import { TronWeb, utils } from 'tronweb'
import { assert, describe, it } from 'vitest'
import { Clock } from '../../src/core/clock.ts'
import { defaultRegistry } from '../../src/dialect/index.ts'
import { TronProvider } from '../../src/index.ts'
import type { ContractCallResult, TronTransaction } from '../../src/index.ts'
import { createNode } from '../createNode.ts'
import { probeState } from '../stateProbe.ts'

async function fixture() {
  const provider = new TronProvider(await createNode({}, new Clock(() => 1_800_000_000_000)))
  const node = provider.node
  const keys = (await node.admin.accounts()).privateKeys
  const addresses = keys.map((key) =>
    TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string),
  )
  const request = <T = Record<string, unknown>>(method: string, params: object = {}) =>
    provider.request({ method, params }) as Promise<T>
  const commit = async (method: string, params: object) => {
    const tx = await request<TronTransaction>(method, { owner_address: addresses[0], ...params })
    assert.isString(tx.txID, method)
    const signed = utils.crypto.signTransaction(keys[0], tx)
    assert.isTrue((await request('wallet/broadcasttransaction', signed)).result)
    return tx
  }
  return { provider, node, addresses, request, commit }
}

describe('provider normalization and confirmed-state aliases', () => {
  for (const method of [
    'wallet/triggerconstantcontract',
    'walletsolidity/triggerconstantcontract',
    'wallet/estimateenergy',
    'walletsolidity/estimateenergy',
  ] as const) {
    it(`${method} normalizes every handler integer and rejects malformed values`, async () => {
      const f = await fixture()
      const before = await probeState(f.node)
      for (const field of ['call_value', 'call_token_value', 'token_id', 'fee_limit']) {
        for (const value of [0, 0n, '0', '0x0']) {
          const params = {
            owner_address: TronWeb.address.fromHex(f.addresses[0]),
            data: '60006000f3',
            [field]: value,
          }
          const original = structuredClone(params)
          const result = await f.request<ContractCallResult>(method, params)
          assert.isTrue(result.result?.result, `${field} ${typeof value} ${String(value)}`)
          assert.deepEqual(params, original)
        }
        for (const value of [
          true,
          0.5,
          Number.MAX_SAFE_INTEGER + 1,
          'no',
          1n << 63n,
          -(1n << 63n) - 1n,
        ]) {
          await rejects(
            f.request(method, {
              owner_address: f.addresses[0],
              data: '60006000f3',
              [field]: value,
            }),
            new RegExp(field),
          )
        }
      }
      assert.deepEqual(await probeState(f.node), before)
    })
  }

  it('normalizes address formats and visible output through actual query handlers', async () => {
    const f = await fixture()
    const hex = f.addresses[0]
    const base58 = TronWeb.address.fromHex(hex)
    const formats = [hex, base58, `0x${hex.slice(2)}`, `0x${hex}`]
    const queries: [string, string][] = [
      ['wallet/getaccount', 'address'],
      ['wallet/getaccountnet', 'address'],
      ['wallet/getaccountresource', 'address'],
      ['wallet/getReward', 'address'],
      ['wallet/getBrokerage', 'address'],
      ['wallet/getmarketorderbyaccount', 'value'],
      ['wallet/getavailableunfreezecount', 'owner_address'],
      ['wallet/getcanwithdrawunfreezeamount', 'owner_address'],
    ]
    for (const [method, field] of queries) {
      for (const visible of [false, true]) {
        const expected = await f.request(method, { [field]: hex, visible })
        assert.notProperty(expected, 'Error', method)
        for (const address of formats) {
          const params = { [field]: address, visible }
          assert.deepEqual(
            await f.request(method, params),
            expected,
            `${method} ${address} ${visible}`,
          )
          assert.strictEqual(params[field], address)
        }
        await rejects(f.request(method, { [field]: 'bad-address', visible }), /address/)
      }
    }
    const account = await f.request('wallet/getaccount', { address: base58 })
    assert.strictEqual(account.address, hex.toLowerCase())
    assert.strictEqual(typeof account.balance, 'bigint')
    assert.strictEqual(
      (await f.request('wallet/getaccount', { address: hex, visible: true })).address,
      base58,
    )
    assert.strictEqual((await f.request('wallet/getBrokerage', { address: base58 })).brokerage, 20)
  })

  it('validates range and pagination inputs before dispatch without mutating the caller', async () => {
    const f = await fixture()
    const tables: [string, object, string][] = [
      ['wallet/getblockbylimitnext', { startNum: 0n, endNum: '0x2' }, 'startNum'],
      ['walletsolidity/getblockbylimitnext', { startNum: '0', endNum: 2n }, 'endNum'],
      ['wallet/getblockbylatestnum', { num: '0x1' }, 'num'],
      ['wallet/getpaginatedproposallist', { offset: 0n, limit: '0x1' }, 'limit'],
      ['wallet/getpaginatedexchangelist', { offset: '0x0', limit: 1n }, 'offset'],
      ['wallet/getpaginatednowwitnesslist', { offset: '0', limit: '0x1' }, 'limit'],
      ['walletsolidity/getpaginatednowwitnesslist', { offset: 0n, limit: '1' }, 'offset'],
      ['wallet/getpaginatedassetissuelist', { offset: 0n, limit: '0x1' }, 'offset'],
    ]
    for (const [method, params, field] of tables) {
      const original = structuredClone(params)
      const result = await f.request(method, params)
      assert.notProperty(result, 'Error', method)
      assert.deepEqual(params, original)
      if (method.includes('getblock')) assert.isArray(result.block)
      else if (method.includes('witness')) assert.lengthOf(result.witnesses as unknown[], 1)
      else assert.deepEqual(result, {})
      for (const invalid of [true, '1.5', 1n << 63n])
        await rejects(f.request(method, { ...params, [field]: invalid }), new RegExp(field))
    }
  })

  it('exercises all confirmed-state aliases on the same committed transfer and query inputs', async () => {
    const f = await fixture()
    const tx = await f.commit('wallet/createtransaction', {
      to_address: f.addresses[1],
      amount: '0x7',
    })
    const head = await f.provider.request({ method: 'wallet/getnowblock' })
    const address = { address: TronWeb.address.fromHex(f.addresses[1]) }
    const owner = { owner_address: TronWeb.address.fromHex(f.addresses[0]) }
    const value = { value: tx.txID }
    const height = { num: head.block_header.raw_data.number }
    const params: Record<string, object> = {
      getnowblock: {},
      getblock: { detail: true },
      getblockbynum: height,
      getblockbyid: { value: head.blockID },
      getblockbylimitnext: { startNum: 0n, endNum: '0x2' },
      getblockbylatestnum: { num: '0x1' },
      getaccount: address,
      getaccountbyid: { account_id: '616263' },
      getdelegatedresource: { fromAddress: f.addresses[0], toAddress: f.addresses[1] },
      getdelegatedresourcev2: { fromAddress: f.addresses[0], toAddress: f.addresses[1] },
      getdelegatedresourceaccountindex: { value: f.addresses[0] },
      getdelegatedresourceaccountindexv2: { value: f.addresses[0] },
      getcandelegatedmaxsize: { ...owner, type: '0x1' },
      getavailableunfreezecount: owner,
      getcanwithdrawunfreezeamount: { ...owner, timestamp: 0n },
      getReward: address,
      getBrokerage: address,
      listexchanges: {},
      getexchangebyid: { id: 1n },
      getmarketpairlist: {},
      getmarketorderbyaccount: { value: f.addresses[0] },
      getmarketorderbyid: { value: '' },
      getmarketorderlistbypair: { sell_token_id: '5f', buy_token_id: '31' },
      getmarketpricebypair: { sell_token_id: '5f', buy_token_id: '31' },
      getburntrx: {},
      getassetissuebyid: { value: '1000001' },
      getassetissuebyname: { value: '616263' },
      getassetissuelistbyname: { value: '616263' },
      getassetissuelist: {},
      getpaginatedassetissuelist: { offset: 0n, limit: '0x1' },
      triggerconstantcontract: {
        owner_address: f.addresses[0],
        data: '60006000f3',
        call_value: '0x0',
      },
      estimateenergy: { owner_address: f.addresses[0], data: '60006000f3', call_value: '0' },
      gettransactionbyid: value,
      gettransactioninfobyid: value,
      gettransactioninfobyblocknum: height,
      gettransactioncountbyblocknum: height,
      getnodeinfo: {},
      listwitnesses: {},
      getpaginatednowwitnesslist: { offset: 0n, limit: '0x1' },
      getenergyprices: {},
      getbandwidthprices: {},
    }
    const aliases = defaultRegistry
      .methods()
      .filter((method) => method.startsWith('walletsolidity/'))
      .sort()
    assert.deepEqual(
      Object.keys(params)
        .map((name) => `walletsolidity/${name}`)
        .sort(),
      aliases,
    )
    for (const alias of aliases) {
      const name = alias.slice('walletsolidity/'.length)
      if (name === 'getexchangebyid') {
        await rejects(f.request(alias, params[name]), /./)
        await rejects(f.request(`wallet/${name}`, params[name]), /./)
      } else {
        const result = await f.request(alias, params[name])
        const canonical = await f.request(`wallet/${name}`, params[name])
        if (name === 'getnodeinfo') {
          const { machineInfo, ...chain } = result
          const { machineInfo: canonicalMachine, ...canonicalChain } = canonical
          assert.deepEqual(chain, canonicalChain)
          for (const machine of [machineInfo, canonicalMachine] as Record<string, unknown>[]) {
            assert.isNumber(machine.cpuRate)
            assert.isNumber(machine.processCpuRate)
            assert.isNumber(machine.jvmFreeMemory)
          }
        } else assert.deepEqual(result, canonical, alias)
      }
    }
    const confirmed = await f.request('walletsolidity/gettransactioninfobyid', value)
    assert.strictEqual(confirmed.id, tx.txID)
    const info = await f.request<{
      configNodeInfo: { versionName: string }
      currentConnectCount: number
    }>('walletsolidity/getnodeinfo')
    assert.isObject(info)
  })
})

describe('previously uncovered provider workflows', () => {
  it('builds and queries account, contract, asset and stake mutations through the program boundary', async () => {
    const f = await fixture()
    const owner = TronWeb.address.fromHex(f.addresses[0])
    const receiver = TronWeb.address.fromHex(f.addresses[1])
    await f.commit('wallet/setaccountid', { account_id: '616363657074616e6365' })
    for (const prefix of ['wallet', 'walletsolidity']) {
      const account = await f.request(`${prefix}/getaccountbyid`, {
        account_id: 'acceptance',
        visible: true,
      })
      assert.strictEqual(account.address, owner)
    }
    const deployed = await f.commit('wallet/deploycontract', {
      bytecode: '600060005360016000f3',
      fee_limit: '0x5f5e100',
      origin_energy_limit: '0x1',
      consume_user_resource_percent: '100',
      abi: [{ name: 'x', type: 'function', outputs: [] }],
    })
    await f.commit('wallet/updateenergylimit', {
      contract_address: TronWeb.address.fromHex(deployed.contract_address!),
      origin_energy_limit: '0x2a',
    })
    assert.strictEqual(
      (await f.request('wallet/getcontract', { value: deployed.contract_address }))
        .origin_energy_limit,
      42,
    )
    await f.commit('wallet/clearabi', {
      contract_address: TronWeb.address.fromHex(deployed.contract_address!),
    })
    assert.deepEqual(
      (await f.request('wallet/getcontract', { value: deployed.contract_address })).abi,
      {},
    )
    await f.commit('wallet/createassetissue', {
      name: '414343',
      abbr: '41',
      total_supply: '1000',
      trx_num: '0x1',
      num: 1n,
      start_time: 1_800_000_060_000n,
      end_time: 1_800_086_400_000n,
      url: '68747470733a2f2f612e636f6d',
      frozen_supply: [{ frozen_amount: '0xa', frozen_days: 1n }],
    })
    await f.commit('wallet/updateasset', {
      description: 'updated',
      url: 'https://b.com',
      new_limit: '0x2a',
      new_public_limit: 43n,
      visible: true,
    })
    const issued = await f.request('wallet/getassetissuebyaccount', { address: owner })
    assert.isArray(issued.assetIssue)
    const asset = (issued.assetIssue as Record<string, unknown>[])[0]
    assert.strictEqual(asset.free_asset_net_limit, 42)
    assert.strictEqual(asset.public_free_asset_net_limit, 43)
    const list = await f.request('wallet/getassetissuelistbyname', { value: 'ACC', visible: true })
    assert.lengthOf(list.assetIssue as unknown[], 1)
    await f.commit('wallet/freezebalancev2', { frozen_balance: '1000000000', resource: 'ENERGY' })
    await f.commit('wallet/delegateresource', {
      balance: '0x989680',
      resource: 'ENERGY',
      receiver_address: receiver,
    })
    await f.commit('wallet/undelegateresource', {
      balance: 10_000_000n,
      resource: 'ENERGY',
      receiver_address: receiver,
    })
    assert.deepEqual(
      await f.request('wallet/getdelegatedresourcev2', { fromAddress: owner, toAddress: receiver }),
      {},
    )
    await f.commit('wallet/unfreezebalancev2', {
      unfreeze_balance: '100000000',
      resource: 'ENERGY',
    })
    await f.commit('wallet/cancelallunfreezev2', {})
    assert.notProperty(await f.request('wallet/getaccount', { address: owner }), 'unfrozenV2')
    await f.commit('wallet/unfreezebalancev2', {
      unfreeze_balance: 100_000_000n,
      resource: 'ENERGY',
    })
    await f.provider.request({ method: 'tre_increaseTime', params: [15 * 86400] })
    assert.strictEqual(
      (
        await f.request('wallet/getcanwithdrawunfreezeamount', {
          owner_address: owner,
          timestamp: '0x0',
        })
      ).amount,
      100_000_000n,
    )
    await f.commit('wallet/withdrawexpireunfreeze', {})
    await f.commit('wallet/unfreezeasset', {})
    const account = await f.request('wallet/getaccount', { address: owner })
    assert.notProperty(account, 'unfrozenV2')
    assert.notProperty(account, 'frozen_supply')
    assert.isAbove(
      Number((await f.request('wallet/getnextmaintenancetime')).num),
      1_800_000_000_000,
    )
  })

  it('keeps explicit empty-feature and development text responses usable', async () => {
    const f = await fixture()
    for (const method of [
      'wallet/listproposals',
      'wallet/listexchanges',
      'wallet/getmarketpairlist',
      'wallet/totaltransaction',
    ]) {
      assert.deepEqual(await f.request(method), {})
    }
    assert.deepEqual(await f.request('wallet/getproposalbyid', { id: 1n }), {})
    assert.deepEqual(await f.request('wallet/listnodes'), { nodes: [] })
    for (const method of ['admin', 'admin/', 'admin/accounts', 'admin/accounts-generation']) {
      const reply = await f.request<string>(method)
      assert.isString(reply)
      if (method === 'admin/accounts-generation') assert.strictEqual(reply, '')
      else assert.isAbove(reply.length, 0)
    }
  })
})
