import { rejects } from 'node:assert/strict'

import { hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, afterAll, afterEach, beforeAll, describe, it, vi } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { DEFAULT_BALANCE_SUN, accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { TronNode } from '../../src/node.ts'
import { InvalidParamsError, TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'
import { probeState } from '../stateProbe.ts'

import type { Server } from 'node:http'

describe('program account queries', () => {
  it('reports malformed address values consistently across request fields', async () => {
    const provider = new TronProvider(await TronNode.create())
    const { privateKeys } = await provider.node.admin.accounts()
    const address = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const cases = [
      { method: 'wallet/getaccount', field: 'address', other: {} },
      { method: 'wallet/getaccountresource', field: 'address', other: {} },
      { method: 'wallet/getcontractinfo', field: 'value', other: {} },
      {
        method: 'wallet/getdelegatedresource',
        field: 'fromAddress',
        other: { toAddress: address },
      },
      {
        method: 'wallet/getdelegatedresourcev2',
        field: 'toAddress',
        other: { fromAddress: address },
      },
    ]
    for (const { method, field, other } of cases) {
      for (const value of ['zz', 123, true, 1n, [], {}, new Uint8Array(20)]) {
        await rejects(provider.request({ method, params: { ...other, [field]: value } }), {
          constructor: InvalidParamsError,
          message: 'invalid address',
        })
      }
    }
  })

  it('accepts address strings directly while visible selects the returned format', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const accounts = await node.admin.accounts()
    const base58 = TronWeb.address.fromPrivateKey(accounts.privateKeys[0]) as string
    const hex = TronWeb.address.toHex(base58)
    for (const address of [base58, hex, `0x${hex.slice(2)}`]) {
      const account = await provider.request({ method: 'wallet/getaccount', params: { address } })
      assert.strictEqual(account.address, hex)
      assert.strictEqual(account.balance, DEFAULT_BALANCE_SUN)
      const visible = await provider.request({
        method: 'wallet/getaccount',
        params: { address, visible: true },
      })
      assert.strictEqual(visible.address, base58)
    }
    await rejects(
      provider.request({ method: 'wallet/getaccount', params: { address: 'invalid' } }),
      /address/,
    )
  })

  it('normalizes program addresses without changing HTTP decoding or validation queries', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const address = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const hex = TronWeb.address.toHex(address)
    const started = await startHttpServer(provider, { port: 0 })
    try {
      const program = await provider.request({ method: 'wallet/getaccount', params: { address } })
      assert.strictEqual(program.balance, DEFAULT_BALANCE_SUN)
      const post = async (params: unknown) =>
        (
          await fetch(`${started.url}/wallet/getaccount`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
          })
        ).json()
      assert.include((await post({ address })).Error, 'INVALID hex String')
      assert.include((await post({ address: 123 })).Error, 'Expected string.')
      assert.strictEqual((await post({ address, visible: true })).address, address)
      assert.strictEqual((await post({ address: hex })).address, hex)
      const query = { address, shadow_address: 'zz' }
      assert.deepEqual(
        await provider.request({ method: 'wallet/getaccount', params: query }),
        program,
      )
      assert.deepEqual(query, { address, shadow_address: 'zz' })
      for (const value of ['zz', address]) {
        const params = { address: value }
        const wire = await (
          await fetch(`${started.url}/wallet/validateaddress`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
          })
        ).json()
        assert.deepEqual(await provider.request({ method: 'wallet/validateaddress', params }), wire)
      }
    } finally {
      started.server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        started.server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})

describe('account-name state', () => {
  let node: TronNode
  let server: Server
  let url: string
  let keys: string[]
  let addresses: string[]

  async function start(allowUpdateAccountName: number): Promise<void> {
    node = await TronNode.create({ chainParameters: { allowUpdateAccountName } })
    keys = (await node.admin.accounts()).privateKeys
    addresses = keys.map((key) => TronWeb.address.fromPrivateKey(key) as string)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    url = started.url
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    await node.tre.blockTime(0)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return (
      await fetch(`${url}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()
  }

  function build(index: number, name: string | undefined, common = false, visible = false) {
    return post(common ? 'wallet/createCommonTransaction' : 'wallet/updateaccount', {
      ...(common ? { contractType: 'AccountUpdateContract' } : {}),
      owner_address: visible ? addresses[index] : TronWeb.address.toHex(addresses[index]),
      account_name: name,
      visible,
    })
  }

  async function send(index: number, tx: Record<string, unknown>): Promise<void> {
    assert.isUndefined(tx.Error)
    assert.isString(tx.txID)
    const signed = utils.crypto.signTransaction(keys[index], tx as never)
    const reply = await post('wallet/broadcasttransaction', signed)
    assert.isTrue(reply.result, JSON.stringify(reply))
  }

  async function names(): Promise<(string | undefined)[]> {
    return Promise.all(
      addresses.slice(0, 2).map(async (address) => {
        const params = { address: TronWeb.address.toHex(address) }
        const account = await post('wallet/getaccount', params)
        const solid = await post('walletsolidity/getaccount', params)
        assert.strictEqual(solid.account_name, account.account_name)
        return account.account_name as string | undefined
      }),
    )
  }

  it.each(
    [false, true].flatMap((common) =>
      [false, true].flatMap((visible) =>
        [undefined, ''].map((empty) => ({ common, visible, empty })),
      ),
    ),
  )('allows naming after an empty update: %j', async ({ common, visible, empty }) => {
    await start(0)
    await send(0, await build(0, empty, common, visible))
    assert.isUndefined((await names())[0])
    const name = visible ? 'named' : 'ff00'
    await send(0, await build(0, name, common, visible))
    assert.strictEqual((await names())[0], visible ? '6e616d6564' : name)
    assert.strictEqual(
      (await build(0, visible ? 'again' : '616761696e', common, visible)).Error,
      'This account name is already existed',
    )
  })

  it('retains each account name when another account claims the same name or renames', async () => {
    await start(1)
    const shared = '736861726564'
    await send(0, await build(0, shared))
    await send(1, await build(1, shared, true))
    assert.deepEqual(await names(), [shared, shared])
    await send(1, await build(1, '6e6577'))
    assert.deepEqual(await names(), [shared, '6e6577'])
    await send(0, await build(0, ''))
    assert.deepEqual(await names(), [undefined, '6e6577'])
    await send(0, await build(0, 'ff00'))
    assert.deepEqual(await names(), ['ff00', '6e6577'])
  })

  it('keeps committed names isolated from pending updates and restores them after a seal failure', async () => {
    await start(1)
    await send(0, await build(0, '61'))
    await send(1, await build(1, '62'))
    await node.tre.blockTime(60)
    const shared = '736861726564'
    await send(0, await build(0, shared))
    await send(1, await build(1, shared))
    assert.deepEqual(await names(), ['61', '62'])
    const before = await probeState(node)
    const seal = vi
      .spyOn(nodeCore(node), 'sealBlock')
      .mockRejectedValueOnce(new Error('seal unavailable'))
    await rejects(node.tre.mine(), /seal unavailable/)
    seal.mockRestore()
    assert.deepEqual(await probeState(node), before)
    assert.deepEqual(await names(), ['61', '62'])
    await node.tre.mine()
    assert.deepEqual(await names(), [shared, shared])
  })
})

/** the account-management and contract-metadata build endpoints */
describe('account and metadata endpoints', () => {
  const config = resolveConfig()
  const ownerKey = accountsFromMnemonic(config.mnemonic)[0].privateKey
  const owner = TronWeb.address.fromPrivateKey(ownerKey) as string
  let node: TronNode
  let server: Server
  let tronWeb: TronWeb
  let baseUrl = ''

  beforeAll(async () => {
    node = await TronNode.create(config)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    tronWeb = new TronWeb({ fullHost: started.url, privateKey: ownerKey })
  })

  afterAll(() => {
    server.close()
  })

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>

  const message = (reply: Record<string, unknown>): string => String(reply.Error ?? '')

  const send = async (built: Record<string, unknown>): Promise<Record<string, unknown>> =>
    post('wallet/broadcasttransaction', await tronWeb.trx.sign(built as never))

  it('claims an account name chain-wide, and closes renaming once it is set', async () => {
    const name = TronWeb.fromUtf8('alice').replace(/^0x/, '')
    const built = await post('wallet/updateaccount', {
      owner_address: TronWeb.address.toHex(owner),
      account_name: name,
    })
    assert.isUndefined(built.Error)
    assert.isTrue((await send(built)).result)

    const other = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[1].privateKey,
    ) as string
    assert.strictEqual(
      message(
        await post('wallet/updateaccount', {
          owner_address: TronWeb.address.toHex(other),
          account_name: name,
        }),
      ),
      'This name is existed',
    )

    const account = (await post('wallet/getaccount', {
      address: TronWeb.address.toHex(owner),
    })) as { account_name?: string }
    assert.strictEqual(account.account_name, name)

    const unclaimed = TronWeb.fromUtf8('rename').replace(/^0x/, '')
    assert.strictEqual(
      message(
        await post('wallet/updateaccount', {
          owner_address: TronWeb.address.toHex(other),
          account_name: unclaimed,
        }),
      ),
      '',
      'the name is free for an account that has none',
    )
    assert.strictEqual(
      message(
        await post('wallet/updateaccount', {
          owner_address: TronWeb.address.toHex(owner),
          account_name: unclaimed,
        }),
      ),
      'This account name is already existed',
    )
  })

  it('an account id is set once, and only once', async () => {
    const holder = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[1].privateKey,
    ) as string
    const id = TronWeb.fromUtf8('alice-id').replace(/^0x/, '')

    // ids run 8..32 printable bytes
    assert.strictEqual(
      message(
        await post('wallet/setaccountid', {
          owner_address: TronWeb.address.toHex(holder),
          account_id: TronWeb.fromUtf8('short').replace(/^0x/, ''),
        }),
      ),
      'Invalid accountId',
    )

    const built = await post('wallet/setaccountid', {
      owner_address: TronWeb.address.toHex(holder),
      account_id: id,
    })
    assert.isTrue(
      (
        await post(
          'wallet/broadcasttransaction',
          await tronWeb.trx.sign(
            built as never,
            accountsFromMnemonic(config.mnemonic)[1].privateKey,
          ),
        )
      ).result,
    )

    assert.strictEqual(
      message(
        await post('wallet/setaccountid', {
          owner_address: TronWeb.address.toHex(holder),
          account_id: TronWeb.fromUtf8('another-id').replace(/^0x/, ''),
        }),
      ),
      'This account id already set',
    )

    // the id resolves back to its holder, and the account carries it
    const byId = (await post('wallet/getaccountbyid', { account_id: id })) as {
      address?: string
      account_id?: string
    }
    assert.strictEqual(byId.address, TronWeb.address.toHex(holder))
    assert.strictEqual(byId.account_id, id)
    // an id nobody claimed is a miss, not an error
    assert.deepEqual(
      await post('wallet/getaccountbyid', {
        account_id: TronWeb.fromUtf8('nobody-here').replace(/^0x/, ''),
      }),
      {},
    )
  })

  it('merges a non-visible account id as bytes before looking it up', async () => {
    const badHex = await post('wallet/getaccountbyid', { account_id: 'zz' })
    assert.include(String(badHex.Error), 'INVALID hex String')

    const wrongType = await post('wallet/getaccountbyid', { account_id: 42 })
    assert.include(String(wrongType.Error), 'Expected string.')
  })

  // one endpoint for every builder, with the type named in the body rather
  // than the path — TronWeb has no method for it, so nothing else exercises it
  it('createCommonTransaction builds supported types but cannot bypass protected 501 routes', async () => {
    const built = await post('wallet/createCommonTransaction', {
      contractType: 'TransferContract',
      owner_address: TronWeb.address.toHex(owner),
      to_address: TronWeb.address.toHex(utils.accounts.generateAccount().address.base58),
      amount: 1_000_000,
    })
    assert.isUndefined(built.Error, JSON.stringify(built))
    const raw = built.raw_data as { contract: { type: string }[] }
    assert.strictEqual(raw.contract[0].type, 'TransferContract')
    assert.isTrue((await send(built)).result)

    // the type is looked up in the enum, and the actuator checks still run
    assert.strictEqual(
      message(
        await post('wallet/createCommonTransaction', {
          contractType: 'NoSuchContract',
          owner_address: TronWeb.address.toHex(owner),
        }),
      ),
      'No enum constant' +
        ' org.tron.protos.Protocol.Transaction.Contract.ContractType.NoSuchContract',
    )
    assert.strictEqual(
      message(
        await post('wallet/createCommonTransaction', {
          owner_address: TronWeb.address.toHex(owner),
        }),
      ),
      'Name is null',
    )
    assert.strictEqual(
      message(
        await post('wallet/createCommonTransaction', {
          contractType: 'TransferContract',
          owner_address: TronWeb.address.toHex(owner),
          to_address: TronWeb.address.toHex(owner),
          amount: 1,
        }),
      ),
      'Cannot transfer TRX to yourself.',
    )

    // every contract type without an actuator, not a hand-kept subset
    for (const contractType of [
      'CustomContract',
      'ExchangeCreateContract',
      'ExchangeInjectContract',
      'ExchangeTransactionContract',
      'ExchangeWithdrawContract',
      'GetContract',
      'MarketCancelOrderContract',
      'MarketSellAssetContract',
      'ProposalApproveContract',
      'ProposalCreateContract',
      'ProposalDeleteContract',
      'ShieldedTransferContract',
      'UpdateBrokerageContract',
      'VoteAssetContract',
      'VoteWitnessContract',
      'WithdrawBalanceContract',
      'WitnessCreateContract',
      'WitnessUpdateContract',
    ]) {
      assert.strictEqual(
        message(await post('wallet/createCommonTransaction', { contractType })),
        `${contractType} is not implemented`,
      )
    }
  })

  // blocks seal on submission, so the pool is always empty — but the id still
  // has to be a transaction id before the pool is consulted
  it('the pending-pool queries answer empty, and screen their input', async () => {
    assert.deepEqual(await post('wallet/gettransactionlistfrompending', {}), {})
    assert.deepEqual(await post('wallet/gettransactionfrompending', { value: 'ab'.repeat(32) }), {})
    assert.strictEqual(
      (await post('wallet/gettransactionfrompending', { value: 'abcd' })).Error,
      'null',
    )
  })

  it('getmemofee reports the price the chain charges for a memo', async () => {
    assert.deepEqual(await post('wallet/getmemofee', {}), {
      prices: `0:${config.chainParameters.memoFee}`,
    })
  })

  it('createaccount pays the create-account fee and refuses an address that exists', async () => {
    const fresh = utils.accounts.generateAccount().address.base58
    const before = await tronWeb.trx.getBalance(owner)

    const built = await post('wallet/createaccount', {
      owner_address: TronWeb.address.toHex(owner),
      account_address: TronWeb.address.toHex(fresh),
    })
    assert.isTrue((await send(built)).result)
    // the bandwidth layer bills a creation outright, replacing per-byte usage,
    // and the actuator charges the system-contract fee on top
    assert.strictEqual(
      before - (await tronWeb.trx.getBalance(owner)),
      config.chainParameters.createAccountFee +
        config.chainParameters.createNewAccountFeeInSystemContract,
    )

    assert.strictEqual(
      message(
        await post('wallet/createaccount', {
          owner_address: TronWeb.address.toHex(owner),
          account_address: TronWeb.address.toHex(fresh),
        }),
      ),
      'Account has existed',
    )
  })

  it('the contract metadata endpoints build and apply', async () => {
    const contract = utils.accounts.generateAccount().address.base58
    await nodeCore(node).setCode(parseTronAddress(contract), hexToBytes('0x6001'))
    // the planted record has no origin, so claim it for this owner
    const planted = nodeCore(node).getContractMeta(parseTronAddress(contract))!
    planted.originAddress = TronWeb.address.toHex(owner)
    planted.abi = [{ name: 'x', type: 'Function' }]
    // each actuator registers a fresh record, so the reading is taken again
    const meta = () => nodeCore(node).getContractMeta(parseTronAddress(contract))!

    const setting = await post('wallet/updatesetting', {
      owner_address: TronWeb.address.toHex(owner),
      contract_address: TronWeb.address.toHex(contract),
      consume_user_resource_percent: 60,
    })
    assert.isTrue((await send(setting)).result)
    assert.strictEqual(meta().consumeUserResourcePercent, 60)

    const limit = await post('wallet/updateenergylimit', {
      owner_address: TronWeb.address.toHex(owner),
      contract_address: TronWeb.address.toHex(contract),
      origin_energy_limit: 12_345,
    })
    assert.isTrue((await send(limit)).result)
    assert.strictEqual(meta().originEnergyLimit, 12_345)

    const cleared = await post('wallet/clearabi', {
      owner_address: TronWeb.address.toHex(owner),
      contract_address: TronWeb.address.toHex(contract),
    })
    assert.isTrue((await send(cleared)).result)
    assert.deepEqual(meta().abi, [])

    // the percent bound is enforced at build time
    assert.strictEqual(
      message(
        await post('wallet/updatesetting', {
          owner_address: TronWeb.address.toHex(owner),
          contract_address: TronWeb.address.toHex(contract),
          consume_user_resource_percent: 150,
        }),
      ),
      'percent not in [0, 100]',
    )
  })

  it('getburntrx accumulates what fees take out of circulation', async () => {
    const before = (await post('wallet/getburntrx', {})) as { burnTrxAmount?: number }
    const receiver = utils.accounts.generateAccount().address.base58
    await send(
      (await post('wallet/createtransaction', {
        owner_address: TronWeb.address.toHex(owner),
        to_address: TronWeb.address.toHex(receiver),
        amount: 1000,
      })) as Record<string, unknown>,
    )
    const after = (await post('wallet/getburntrx', {})) as { burnTrxAmount?: number }
    // creating the receiver burns the create-account fee
    assert.isAbove(after.burnTrxAmount ?? 0, before.burnTrxAmount ?? 0)
    assert.deepEqual(await post('walletsolidity/getburntrx', {}), after)
  })

  it('builds an amount up to what it signs for, and refuses past it', async () => {
    const richKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const rich = TronWeb.address.fromPrivateKey(richKey) as string
    await nodeCore(node).setBalance(parseTronAddress(rich), 10_000_000_000_000_000n)
    const receiver = utils.accounts.generateAccount().address.base58
    const build = async (amount: string): Promise<string> =>
      (
        await fetch(`${baseUrl}/wallet/createtransaction`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: `{"owner_address":"${TronWeb.address.toHex(rich)}","to_address":"${TronWeb.address.toHex(receiver)}","amount":${amount}}`,
        })
      ).text()

    assert.include(await build('9007199254740991'), '"amount":9007199254740991')
    // the id a caller signs is hashed through the bundled encoder, which
    // states an int64 as a double
    assert.include(await build('9007199254740993'), 'the widest this node signs for')
  })

  it('holds an account-activating transaction to its own byte cap', async () => {
    const receiver = utils.accounts.generateAccount().address.base58
    const memo = 'aa'.repeat(1000) // pushes the serialized form past 1000 bytes
    const built = await post('wallet/createtransaction', {
      owner_address: TronWeb.address.toHex(owner),
      to_address: TronWeb.address.toHex(receiver),
      amount: 1000,
      extra_data: memo,
    })
    assert.isUndefined(built.Error)
    const reply = (await post(
      'wallet/broadcasttransaction',
      await tronWeb.trx.sign(built as never),
    )) as { code?: string; message?: string }
    assert.strictEqual(reply.code, 'TOO_BIG_TRANSACTION_ERROR')
    const text = TronWeb.toUtf8(String(reply.message))
    assert.include(text, 'Too big new account transaction')
    assert.include(text, 'maxTxSize 1000')
  })

  it('keeps an account id in its original case, matched without it', async () => {
    const holderKey = accountsFromMnemonic(config.mnemonic)[3].privateKey
    const holder = TronWeb.address.fromPrivateKey(holderKey) as string
    const built = await post('wallet/setaccountid', {
      owner_address: TronWeb.address.toHex(holder),
      account_id: TronWeb.fromUtf8('MixCaseR5').replace(/^0x/, ''),
    })
    assert.isUndefined(built.Error)
    assert.isTrue(
      (await post('wallet/broadcasttransaction', await tronWeb.trx.sign(built as never, holderKey)))
        .result,
    )
    // the account reports the id bytes as they were written
    const account = (await post('wallet/getaccount', {
      address: TronWeb.address.toHex(holder),
    })) as { account_id?: string }
    assert.strictEqual(account.account_id, TronWeb.fromUtf8('MixCaseR5').replace(/^0x/, ''))
    // the lookup matches on the lowered text
    const found = (await post('wallet/getaccountbyid', {
      account_id: 'mixcaser5',
      visible: true,
    })) as { address?: string }
    assert.strictEqual(found.address, holder)
  })

  it('persists the declared account type', async () => {
    const target = utils.accounts.generateAccount().address.base58
    const built = await post('wallet/createaccount', {
      owner_address: TronWeb.address.toHex(owner),
      account_address: TronWeb.address.toHex(target),
      type: 'Contract',
    })
    assert.isUndefined(built.Error)
    assert.isTrue(
      (await post('wallet/broadcasttransaction', utils.crypto.signTransaction(ownerKey, built)))
        .result,
    )
    const account = (await post('wallet/getaccount', {
      address: TronWeb.address.toHex(target),
    })) as { type?: string }
    assert.strictEqual(account.type, 'Contract')
  })
})
