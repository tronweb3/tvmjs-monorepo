import { assert, beforeAll, describe, it } from 'vitest'
import { createNode } from '../createNode.ts'

import { rejects } from 'node:assert/strict'
import { TronWeb, utils } from 'tronweb'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { defaultRegistry } from '../../src/dialect/index.ts'
import { HTTP_METHOD, RAW_BODY } from '../../src/dialect/registry.ts'
import { DEFAULT_ACTIVE_OPERATIONS } from '../../src/dialect/tron/permission.ts'
import { randomMnemonic } from '../../src/hdWallet.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider, requestWire } from '../../src/provider.ts'
import { requestInput } from '../../src/requestInput.ts'

import type { HandlerParams } from '../../src/dialect/registry.ts'
import type { TronTransaction } from '../../src/index.ts'

// the builders validate against live state, so the owner has to be an account
// the chain actually carries
let OWNER = ''
let OTHER = ''
let OWNER58 = ''

let provider: TronProvider

const actuatorMessage = (value: unknown): string => String(value ?? '')

/** a POST whose fields were read off this body text, as the merge sees it */
const post = async (
  method: string,
  fields: Record<string, unknown>,
  target = provider,
): Promise<Record<string, unknown>> => {
  const params: HandlerParams = { ...fields }
  params[HTTP_METHOD] = 'POST'
  params[RAW_BODY] = JSON.stringify(fields)
  return (await requestWire(target, { method, params })) as Record<string, unknown>
}

const failure = async (method: string, fields: Record<string, unknown>): Promise<string> => {
  try {
    const reply = await post(method, fields)
    return actuatorMessage(reply.Error ?? `no failure: ${JSON.stringify(reply)}`)
  } catch (err) {
    return (err as Error).message
  }
}

beforeAll(async () => {
  const config = resolveConfig()
  provider = new TronProvider(await TronNode.create(config))
  OWNER58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
  OWNER = TronWeb.address.toHex(OWNER58)
  OTHER = TronWeb.address.toHex(
    TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[1].privateKey) as string,
  )
})

describe('transaction builders', () => {
  describe.each(['wallet/updateaccount', 'wallet/createCommonTransaction'])(
    '%s account names',
    (method) => {
      describe.each([false, true])('visible=%s', (visible) => {
        it.each([
          ['omitted', {}],
          ['null', { account_name: null }],
          ['empty', { account_name: '' }],
        ] as const)('builds and broadcasts with account name %s', async (_, fields) => {
          const local = new TronProvider(
            await TronNode.create({ mnemonic: { phrase: randomMnemonic(), count: 1 } }),
          )
          const key = (await local.node.admin.accounts()).privateKeys[0]
          const owner = TronWeb.address.fromPrivateKey(key) as string
          const ownerHex = TronWeb.address.toHex(owner)
          const reply = await post(
            method,
            {
              owner_address: visible ? owner : ownerHex,
              contractType: 'AccountUpdateContract',
              visible,
              ...fields,
            },
            local,
          )
          assert.isUndefined(reply.Error)
          const tx = reply as unknown as TronTransaction
          assert.deepEqual(tx.raw_data.contract[0].parameter.value, {
            owner_address: visible ? owner : ownerHex,
          })
          const hexTx = structuredClone(tx)
          hexTx.visible = false
          hexTx.raw_data.contract[0].parameter.value = {
            owner_address: ownerHex,
            account_name: '',
          }
          const pb = utils.transaction.txJsonToPb(hexTx)
          assert.strictEqual(utils.transaction.txPbToRawDataHex(pb).toLowerCase(), tx.raw_data_hex)
          assert.strictEqual(utils.transaction.txPbToTxID(pb).replace(/^0x/, ''), tx.txID)
          const broadcast = await local.request({
            method: 'wallet/broadcasttransaction',
            params: utils.crypto.signTransaction(key, tx),
          })
          assert.isTrue(broadcast.result)
          const stored = await local.request({
            method: 'wallet/gettransactionbyid',
            params: { value: tx.txID },
          })
          assert.strictEqual(stored.ret?.[0]?.contractRet, 'SUCCESS')
        })
      })
    },
  )

  it.each(['wallet/createaccount', 'wallet/createCommonTransaction'])(
    'normalizes visible account creation through %s before validation and encoding',
    async (method) => {
      const recipient = utils.accounts.generateAccount().address.base58
      const reply = await post(method, {
        owner_address: OWNER58,
        account_address: recipient,
        type: 'Normal',
        contractType: 'AccountCreateContract',
        Permission_id: 2,
        visible: true,
      })
      assert.isUndefined(reply.Error)
      const tx = reply as unknown as TronTransaction<'AccountCreateContract'>
      assert.strictEqual(tx.raw_data.contract[0].Permission_id, 2)
      assert.strictEqual(tx.raw_data.contract[0].parameter.value.account_address, recipient)
      const pb = utils.transaction.txJsonToPb(tx)
      assert.strictEqual(utils.transaction.txPbToRawDataHex(pb).toLowerCase(), tx.raw_data_hex)
      assert.strictEqual(utils.transaction.txPbToTxID(pb).replace(/^0x/, ''), tx.txID)
    },
  )

  it('normalizes nested permission addresses without changing permission identity', async () => {
    const reply = await post('wallet/accountpermissionupdate', {
      owner_address: OWNER58,
      owner: { type: 'Owner', threshold: 1, keys: [{ address: OWNER58, weight: 1 }] },
      actives: [
        {
          type: 'Active',
          threshold: 1,
          operations: DEFAULT_ACTIVE_OPERATIONS,
          keys: [{ address: OWNER58, weight: 1 }],
        },
      ],
      Permission_id: 2,
      visible: true,
    })
    assert.isUndefined(reply.Error)
    const tx = reply as unknown as TronTransaction
    assert.strictEqual(tx.raw_data.contract[0].Permission_id, 2)
    assert.strictEqual(
      utils.transaction.txPbToRawDataHex(utils.transaction.txJsonToPb(tx)).toLowerCase(),
      tx.raw_data_hex,
    )
  })

  it('treats visible account names as text even when the text looks hexadecimal', async () => {
    const local = new TronProvider(await TronNode.create())
    const key = (await local.node.admin.accounts()).privateKeys[0]
    const owner = TronWeb.address.fromPrivateKey(key) as string
    const tx = (await post(
      'wallet/createCommonTransaction',
      {
        contractType: 'AccountUpdateContract',
        owner_address: owner,
        account_name: 'aa',
        visible: true,
      },
      local,
    )) as unknown as TronTransaction<'AccountUpdateContract'>
    assert.strictEqual(tx.raw_data.contract[0].parameter.value.account_name, 'aa')
    // TronWeb's AccountUpdate encoder expects this name in hex even with visible=true.
    const hexTx = structuredClone(tx)
    hexTx.visible = false
    hexTx.raw_data.contract[0].parameter.value = {
      owner_address: TronWeb.address.toHex(owner),
      account_name: '6161',
    }
    assert.strictEqual(
      utils.transaction.txPbToRawDataHex(utils.transaction.txJsonToPb(hexTx)).toLowerCase(),
      tx.raw_data_hex,
    )
    assert.isTrue(
      (
        await local.request({
          method: 'wallet/broadcasttransaction',
          params: utils.crypto.signTransaction(key, tx),
        })
      ).result,
    )
    assert.strictEqual(
      (await post('wallet/getaccount', { address: owner, visible: true }, local)).account_name,
      'aa',
    )
  })

  it('keeps activation and name validation ahead of owner lookup', async () => {
    const local = new TronProvider(
      await TronNode.create({
        chainParameters: { allowMultiSign: 0 },
        runtime: { energyLimitActivationBlock: 10 },
      }),
    )
    assert.strictEqual(
      (await post('wallet/updateenergylimit', {}, local)).Error,
      'contract type error, unexpected type [UpdateEnergyLimitContract]',
    )
    assert.strictEqual(
      (await post('wallet/accountpermissionupdate', {}, local)).Error,
      'multi sign is not allowed, need to be opened by the committee',
    )
    assert.strictEqual(
      (await post('wallet/updateaccount', { account_name: 'a'.repeat(201), visible: true }, local))
        .Error,
      'Invalid accountName',
    )
    assert.include(
      String(
        (await post('wallet/setaccountid', { account_id: '12345678', visible: true }, local)).Error,
      ),
      'ownerAddress',
    )
  })

  it('validates odd-length hex as left-padded bytes for every issuance byte field', async () => {
    const head = await provider.request({ method: 'wallet/getnowblock' })
    const start = head.block_header.raw_data.timestamp + 60_000
    const fields = {
      owner_address: OWNER,
      name: '546f6b656e',
      total_supply: 1000,
      trx_num: 1,
      num: 1,
      start_time: start,
      end_time: start + 86_400_000,
      url: '66',
    }
    assert.strictEqual(
      (await post('wallet/createassetissue', { ...fields, abbr: 'f' })).Error,
      'Invalid abbreviation for token',
    )
    assert.strictEqual(
      (await post('wallet/createassetissue', { ...fields, description: 'f'.repeat(401) })).Error,
      'Invalid description',
    )
    const tx = (await post('wallet/createassetissue', {
      ...fields,
      url: 'f',
    })) as unknown as TronTransaction<'AssetIssueContract'>
    assert.strictEqual(tx.raw_data.contract[0].parameter.value.url, '0f')
    assert.strictEqual(
      utils.transaction.txPbToRawDataHex(utils.transaction.txJsonToPb(tx)).toLowerCase(),
      tx.raw_data_hex,
    )
  })

  it('accepts lowercase 0x-prefixed TRON addresses in construction and account queries', async () => {
    const tx = await post('wallet/createtransaction', {
      owner_address: `0x${OWNER}`,
      to_address: `0x${OTHER}`,
      amount: 1,
    })
    assert.isString(tx.txID)
    assert.deepEqual(
      await post('wallet/getaccount', { address: `0x${OWNER}` }),
      await post('wallet/getaccount', { address: OWNER }),
    )
    assert.isUndefined(
      (
        await post('wallet/createtransaction', {
          owner_address: `0x${OWNER.slice(2)}`,
          to_address: OTHER,
          amount: 1,
        })
      ).txID,
    )
  })

  it('reports fee parsing failures in the trigger response envelope', async () => {
    const deployed = await post('wallet/deploycontract', {
      owner_address: OWNER,
      bytecode: '60006000f3',
      abi: [],
      consume_user_resource_percent: 100,
      origin_energy_limit: 1,
      fee_limit: 100_000_000,
    })
    const key = (await provider.node.admin.accounts()).privateKeys[0]
    const broadcast = await provider.request({
      method: 'wallet/broadcasttransaction',
      params: utils.crypto.signTransaction(key, deployed as never),
    })
    assert.isTrue(broadcast.result)
    const fields = { owner_address: OWNER, contract_address: deployed.contract_address, data: '' }
    for (const fee_limit of ['x', 1.5]) {
      const bad = await post('wallet/triggersmartcontract', { ...fields, fee_limit })
      assert.isUndefined(bad.Error)
      assert.strictEqual((bad.result as { code: string }).code, 'OTHER_ERROR')
      const message = TronWeb.toUtf8((bad.result as { message: string }).message)
      assert.include(message, fee_limit === 'x' ? 'x' : "Couldn't parse integer")
    }
    for (const method of ['wallet/triggerconstantcontract', 'wallet/estimateenergy']) {
      const result = await post(method, fields)
      assert.strictEqual((result.result as { result?: boolean }).result, true, method)
    }
  })

  it('rejects malformed program amounts without changing balances or the head', async () => {
    const head = await provider.request({ method: 'wallet/getnowblock' })
    const owner = await provider.request({
      method: 'wallet/getaccount',
      params: { address: OWNER },
    })
    for (const amount of ['', '0x', '1.5', null, false, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await rejects(
        provider.request({
          method: String('wallet/createtransaction'),
          params: { owner_address: OWNER58, to_address: OTHER, amount },
        }),
        /amount/,
      )
      assert.deepEqual(await provider.request({ method: 'wallet/getnowblock' }), head)
      assert.deepEqual(
        await provider.request({ method: 'wallet/getaccount', params: { address: OWNER } }),
        owner,
      )
    }
    // HTTP still follows its protobuf JSON grammar rather than program input rules.
    assert.include(
      await failure('wallet/createtransaction', {
        owner_address: OWNER,
        to_address: OTHER,
        amount: '17',
      }),
      "Couldn't parse integer",
    )
  })

  it('normalizes direct smart-contract integer inputs before their handlers read them', () => {
    const fields: Record<string, readonly string[]> = {
      'wallet/deploycontract': [
        'call_value',
        'call_token_value',
        'token_id',
        'consume_user_resource_percent',
        'origin_energy_limit',
        'fee_limit',
      ],
      'wallet/triggersmartcontract': ['call_value', 'call_token_value', 'token_id', 'fee_limit'],
      'wallet/triggerconstantcontract': ['call_value', 'call_token_value', 'token_id', 'fee_limit'],
      'wallet/estimateenergy': ['call_value', 'call_token_value', 'token_id', 'fee_limit'],
    }
    for (const [method, names] of Object.entries(fields)) {
      const definition = defaultRegistry.resolve(method)!
      for (const name of names) {
        const parsed = requestInput(definition, { [name]: '0x11' })
        assert.strictEqual(parsed[name], 17n, `${method}.${name}`)
        assert.throws(() => requestInput(definition, { [name]: null }), /must be an integer/)
      }
    }
  })

  it('uses program fields rather than HTTP metadata supplied by the caller', async () => {
    const fields = { owner_address: OWNER, to_address: OTHER, amount: 1 }
    const params = {
      ...fields,
      [HTTP_METHOD]: 'POST',
      [RAW_BODY]: JSON.stringify({ ...fields, amount: 2 }),
    }
    const program = await provider.request({ method: 'wallet/createtransaction', params })
    if ('Error' in program) throw new Error(program.Error)
    assert.strictEqual(BigInt(program.raw_data.contract[0].parameter.value.amount as number), 1n)
    const wire = (await requestWire(provider, {
      method: 'wallet/createtransaction',
      params,
    })) as typeof program
    assert.strictEqual(BigInt(wire.raw_data.contract[0].parameter.value.amount as number), 2n)
  })

  it.each([65_000, 86_400_001])(
    'keeps expiration relative to the head after %s ms idle, while timestamp follows the clock',
    async (idleMs) => {
      let now = 1_800_000_000_000
      const node = await createNode({}, new Clock(() => now))
      const local = new TronProvider(node)
      const head = (await local.request({ method: 'wallet/getnowblock' })) as {
        block_header: { raw_data: { timestamp: number } }
      }
      const headTime = Number(head.block_header.raw_data.timestamp)
      now = headTime + idleMs
      const build = () =>
        local.request({
          method: 'wallet/createtransaction',
          params: { owner_address: OWNER, to_address: OTHER, amount: 1 },
        }) as Promise<{ txID: string; raw_data: { timestamp: number; expiration: number } }>
      const first = await build()
      assert.strictEqual(first.raw_data.timestamp, now)
      assert.strictEqual(first.raw_data.expiration, headTime + 60_000)
      now += 1
      const second = await build()
      assert.strictEqual(second.raw_data.timestamp, now)
      assert.strictEqual(second.raw_data.expiration, first.raw_data.expiration)
      assert.notStrictEqual(second.txID, first.txID)
    },
  )

  it('assemble a transfer into a signable transaction', async () => {
    const reply = await post('wallet/createtransaction', {
      owner_address: OWNER,
      to_address: OTHER,
      amount: 1,
    })
    assert.isString(reply.txID)
    assert.hasAllKeys(reply, ['visible', 'txID', 'raw_data', 'raw_data_hex'])
    const raw = reply.raw_data as Record<string, unknown>
    assert.isNumber(raw.expiration)
    assert.isArray(raw.contract)
  })

  it('state addresses back in the form the request used them', async () => {
    const reply = await post('wallet/createtransaction', {
      owner_address: OWNER58,
      to_address: TronWeb.address.fromHex(OTHER),
      amount: 1,
      visible: true,
    })
    const contract = (
      reply.raw_data as { contract: { parameter: { value: Record<string, string> } }[] }
    ).contract[0]
    assert.strictEqual(contract.parameter.value.owner_address, OWNER58)
  })

  describe('address fields', () => {
    it('name the field a bad owner failed on', async () => {
      // the merge blames the column the value starts at, not the field name
      assert.match(
        await failure('wallet/createtransaction', {
          owner_address: 'zz',
          to_address: OTHER,
          amount: 1,
        }),
        /^\d+:\d+: INVALID hex String$/,
      )
    })

    it('refuse an address stated in the form the request did not claim', async () => {
      // visible=false says 41-hex, so base58 is a merge failure, not a conversion
      assert.match(
        await failure('wallet/createtransaction', {
          owner_address: OWNER58,
          to_address: OTHER,
          amount: 1,
        }),
        /INVALID hex String/,
      )
    })
  })

  describe('unknown and mistyped fields', () => {
    it('refuse a name the request message does not declare', async () => {
      const message = await failure('wallet/createtransaction', {
        owner_address: OWNER,
        to_address: OTHER,
        amount: 1,
        nonsense: {},
      })
      assert.include(message, 'Expected identifier.')
    })

    it('refuse a number where the message declares bytes', async () => {
      const message = await failure('wallet/createtransaction', {
        owner_address: 1,
        to_address: OTHER,
        amount: 1,
      })
      assert.include(message, 'Expected string.')
    })

    it('refuse text where the message declares an integer', async () => {
      const message = await failure('wallet/createtransaction', {
        owner_address: OWNER,
        to_address: OTHER,
        amount: 'lots',
      })
      assert.include(message, "Couldn't parse integer")
    })
  })

  describe('the simple builders', () => {
    // built per test: the addresses are only known once the node is up
    const contractCases = (): [string, Record<string, unknown>][] => [
      [
        'wallet/updatesetting',
        { owner_address: OWNER, contract_address: OTHER, consume_user_resource_percent: 10 },
      ],
      [
        'wallet/updateenergylimit',
        { owner_address: OWNER, contract_address: OTHER, origin_energy_limit: 10 },
      ],
      ['wallet/clearabi', { owner_address: OWNER, contract_address: OTHER }],
    ]
    const accountCases = (): [string, Record<string, unknown>][] => [
      ['wallet/updateaccount', { owner_address: OWNER, account_name: '6e616d65' }],
      ['wallet/setaccountid', { owner_address: OWNER, account_id: '6e616d65' }],
      ['wallet/createaccount', { owner_address: OWNER, account_address: OTHER }],
    ]

    it('assemble a transaction the state allows', async () => {
      const reply = await post(...(accountCases()[0] as [string, Record<string, unknown>]))
      assert.isString(reply.txID)
    })

    it('refuse what the state does not, each in its own words', async () => {
      assert.strictEqual(
        await failure(...(accountCases()[1] as [string, Record<string, unknown>])),
        'Invalid accountId',
      )
      assert.strictEqual(
        await failure(...(accountCases()[2] as [string, Record<string, unknown>])),
        'Account has existed',
      )
      // each actuator words this its own way, and the wording is the contract
      const wording: Record<string, string> = {
        'wallet/updatesetting': 'Contract does not exist',
        'wallet/updateenergylimit': 'Contract does not exist',
        'wallet/clearabi': 'Contract not exists',
      }
      for (const [method, fields] of contractCases()) {
        assert.strictEqual(await failure(method, fields), wording[method], method)
      }
    })

    it('judge an undeclared field at the merge, before any state is read', async () => {
      for (const [method, fields] of [...contractCases(), ...accountCases()]) {
        const message = await failure(method, { ...fields, nonsense: {} })
        assert.include(message, 'Expected identifier.', method)
      }
    })
  })
})

describe('int64 request fields', () => {
  it('normalizes nested program integers and preserves large transaction values through broadcast', async () => {
    const local = new TronProvider(await TronNode.create())
    const { privateKeys } = await local.node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const head = await local.request({ method: 'wallet/getnowblock' })
    const max = 9_223_372_036_854_775_807n
    const large = 9_007_199_254_740_993n
    const fields = {
      owner_address: owner,
      name: TronWeb.fromUtf8('Exact').slice(2),
      abbr: TronWeb.fromUtf8('EX').slice(2),
      total_supply: String(max),
      trx_num: '0x1',
      num: 1n,
      start_time: String(head.block_header.raw_data.timestamp + 60_000),
      end_time: head.block_header.raw_data.timestamp + 86_400_000,
      url: TronWeb.fromUtf8('https://exact.invalid').slice(2),
      order: String(-large),
      frozen_supply: [
        { frozen_amount: String(large), frozen_days: '0x1' },
        { frozen_amount: '1', frozen_days: '2' },
      ],
    }
    const original = structuredClone(fields)
    const result = await local.request({ method: 'wallet/createassetissue', params: fields })
    assert.isObject(result)
    if ('Error' in result) throw new Error(result.Error)
    const tx = result
    assert.isDefined(tx.raw_data)
    const value = tx.raw_data.contract[0].parameter.value
    assert.strictEqual(value.total_supply, max)
    assert.strictEqual(value.trx_num, 1)
    assert.strictEqual(value.num, 1)
    assert.strictEqual(value.order, -large)
    assert.deepEqual(value.frozen_supply, [
      { frozen_amount: large, frozen_days: 1 },
      { frozen_amount: 1, frozen_days: 2 },
    ])
    assert.deepEqual(fields, original)
    const signed = utils.crypto.signTransaction(privateKeys[0], tx)
    const sent = await local.request({ method: 'wallet/broadcasttransaction', params: signed })
    assert.isTrue(sent.result, JSON.stringify(sent))
    const stored = await local.request({
      method: 'wallet/gettransactionbyid',
      params: { value: tx.txID },
    })
    assert.strictEqual(stored.txID, tx.txID)
    assert.strictEqual(stored.raw_data_hex, tx.raw_data_hex)
    assert.deepEqual(stored.raw_data, tx.raw_data)
    const account = await local.request({ method: 'wallet/getaccount', params: { address: owner } })
    assert.deepInclude(account.assetV2!, { key: '1000001', value: max - large - 1n })
    await rejects(
      local.request({
        method: 'wallet/createassetissue',
        params: { ...fields, frozen_supply: [{ frozen_amount: '', frozen_days: 1 }] },
      }),
      /frozen_supply\[0\]\.frozen_amount/,
    )
    await rejects(
      local.request({
        method: 'wallet/createassetissue',
        params: { ...fields, trx_num: 2_147_483_648n },
      }),
      /trx_num must be at most/,
    )
    await rejects(
      local.request({
        method: 'wallet/createassetissue',
        params: { ...fields, total_supply: max + 1n },
      }),
      /total_supply must be at most/,
    )
  })

  // JSON.parse maps a number onto a double, so a value past 2^53 is already
  // rounded by the time the parsed object exists. Roughly a fifth of the
  // TRC-10 tokens on chain declare a supply up there, so the digits are read
  // back off the body text instead.
  const issue = async (supply: string): Promise<Record<string, unknown>> => {
    const name = TronWeb.fromUtf8('BIGT').replace(/^0x/, '')
    const now = Date.now()
    const body =
      `{"owner_address":"${OWNER}","name":"${name}","abbr":"${name}",` +
      `"total_supply":${supply},"trx_num":1,"num":1,` +
      `"start_time":${now + 5_000},"end_time":${now + 600_000},` +
      `"description":"64","url":"68747470733a2f2f652e696f",` +
      `"free_asset_net_limit":0,"public_free_asset_net_limit":0,"precision":0}`
    const params: HandlerParams = JSON.parse(body)
    params[HTTP_METHOD] = 'POST'
    params[RAW_BODY] = body
    return (await requestWire(provider, { method: 'wallet/createassetissue', params })) as Record<
      string,
      unknown
    >
  }
  const supplyOf = (reply: Record<string, unknown>): unknown =>
    (
      reply.raw_data as {
        contract: { parameter: { value: Record<string, unknown> } }[]
      }
    ).contract[0].parameter.value.total_supply

  it('carries a supply the parsed object could not hold', async () => {
    // 2^53 + 1: the first integer a double cannot state
    assert.strictEqual(supplyOf(await issue('9007199254740993')), 9_007_199_254_740_993n)
    assert.strictEqual(supplyOf(await issue('9223372036854775295')), 9_223_372_036_854_775_295n)
  })

  it('leaves a supply a double can hold exactly where it was', async () => {
    assert.strictEqual(supplyOf(await issue('1000000')), 1_000_000)
  })
})
