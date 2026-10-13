import { rejects } from 'node:assert/strict'

import { TronWeb, utils } from 'tronweb'
import { assert, afterAll, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { WITNESS_ADDRESS, WITNESS_PRIVATE_KEY } from '../../src/core/witness.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { TronNode } from '../../src/node.ts'
import { InvalidParamsError, TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'
import { probeState } from '../stateProbe.ts'

import type { Server } from 'node:http'
import type { ProviderMethodParams } from '../../src/index.ts'

describe('program permission updates', () => {
  it('normalizes nested signing addresses without changing caller input or signed transactions', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const [owner, signer] = privateKeys.map((key) => TronWeb.address.fromPrivateKey(key) as string)
    const params = {
      owner_address: owner,
      owner: {
        type: 0,
        permission_name: 'owner',
        threshold: 1,
        keys: [{ address: owner, weight: 1 }],
      },
      actives: [
        {
          type: 2,
          permission_name: 'active',
          threshold: 1,
          operations: '7fff1fc0033ec30f000000000000000000000000000000000000000000000000',
          keys: [{ address: `0x${TronWeb.address.toHex(signer).slice(2)}`, weight: 1 }],
        },
      ],
    } satisfies ProviderMethodParams<'wallet/accountpermissionupdate'>
    const before = structuredClone(params)
    const transaction = await provider.request({ method: 'wallet/accountpermissionupdate', params })
    assert.isObject(transaction)
    assert.notProperty(transaction, 'Error')
    assert.deepEqual(params, before)
    const signed = utils.crypto.signTransaction(privateKeys[0], transaction)
    const signedBefore = structuredClone(signed)
    const sent = await provider.request({ method: 'wallet/broadcasttransaction', params: signed })
    assert.isTrue(sent.result)
    assert.deepEqual(signed, signedBefore)
    const account = await provider.request({
      method: 'wallet/getaccount',
      params: { address: owner },
    })
    assert.deepNestedInclude(account, {
      'owner_permission.keys': [{ address: TronWeb.address.toHex(owner), weight: 1n }],
      'active_permission[0].keys': [{ address: TronWeb.address.toHex(signer), weight: 1n }],
    })
    for (const address of ['zz', 123, true, [], {}]) {
      const invalid = structuredClone(params)
      Reflect.set(invalid.actives[0].keys[0], 'address', address)
      await rejects(
        provider.request({ method: 'wallet/accountpermissionupdate', params: invalid }),
        { constructor: InvalidParamsError, message: 'invalid address' },
      )
    }
  })
})

/**
 * A permission set lives on the account, so a genuine 2-of-2 can exist: the
 * account is reshaped, and from then on one signature is no longer enough.
 */
describe('multi-signature accounts', () => {
  const config = resolveConfig()
  const ownerKey = accountsFromMnemonic(config.mnemonic)[0].privateKey
  const ownerBase58 = TronWeb.address.fromPrivateKey(ownerKey) as string
  const keyA = utils.accounts.generateAccount().privateKey.toLowerCase()
  const keyB = utils.accounts.generateAccount().privateKey.toLowerCase()
  const signerA = TronWeb.address.fromPrivateKey(keyA) as string
  const signerB = TronWeb.address.fromPrivateKey(keyB) as string
  const receiver = utils.accounts.generateAccount().address.base58
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

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await response.json()) as Record<string, unknown>
  }

  const ACTIVE_OPS = '7fff1fc0033ec30f000000000000000000000000000000000000000000000000'

  /** the same transaction with its address fields written in base58 — the
   *  form a visible=true request must state them in */
  function inVisibleForm(tx: Record<string, unknown>): Record<string, unknown> {
    const clone = JSON.parse(JSON.stringify(tx)) as {
      raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] }
    }
    const value = clone.raw_data.contract[0].parameter.value
    for (const field of ['owner_address', 'to_address']) {
      if (typeof value[field] === 'string') {
        value[field] = TronWeb.address.fromHex(String(value[field]))
      }
    }
    return clone as unknown as Record<string, unknown>
  }

  it('rejects a permission set that cannot reach its own threshold', async () => {
    const reply = await post('wallet/accountpermissionupdate', {
      owner_address: TronWeb.address.toHex(ownerBase58),
      owner: {
        // the protobuf enum, the form a client sends
        type: 0,
        permission_name: 'owner',
        threshold: 1,
        keys: [{ address: TronWeb.address.toHex(ownerBase58), weight: 1 }],
      },
      actives: [
        {
          type: 2,
          permission_name: 'active',
          threshold: 5,
          operations: ACTIVE_OPS,
          keys: [{ address: TronWeb.address.toHex(signerA), weight: 1 }],
        },
      ],
    })
    assert.strictEqual(
      reply.Error,
      "sum of all key's weight should not be less than threshold in permission Active",
    )
  })

  it('rejects duplicate keys and zero weights', async () => {
    const withKeys = async (keys: { address: string; weight: number }[]): Promise<string> => {
      const reply = await post('wallet/accountpermissionupdate', {
        owner_address: TronWeb.address.toHex(ownerBase58),
        owner: {
          type: 'Owner',
          permission_name: 'owner',
          threshold: 1,
          keys: [{ address: TronWeb.address.toHex(ownerBase58), weight: 1 }],
        },
        actives: [
          { type: 2, permission_name: 'active', threshold: 1, operations: ACTIVE_OPS, keys },
        ],
      })
      return String(reply.Error ?? '')
    }
    const a = TronWeb.address.toHex(signerA)
    assert.strictEqual(
      await withKeys([
        { address: a, weight: 1 },
        { address: a, weight: 1 },
      ]),
      'address should be distinct in permission Active',
    )
    assert.strictEqual(
      await withKeys([{ address: a, weight: 0 }]),
      "key's weight should be greater than 0",
    )
  })

  it('a 2-of-2 active permission takes two signatures and no fewer', async () => {
    const built = (await post('wallet/accountpermissionupdate', {
      owner_address: TronWeb.address.toHex(ownerBase58),
      owner: {
        // the protobuf enum, the form a client sends
        type: 0,
        permission_name: 'owner',
        threshold: 1,
        keys: [{ address: TronWeb.address.toHex(ownerBase58), weight: 1 }],
      },
      actives: [
        {
          type: 2,
          permission_name: 'active',
          threshold: 2,
          operations: ACTIVE_OPS,
          keys: [
            { address: TronWeb.address.toHex(signerA), weight: 1 },
            { address: TronWeb.address.toHex(signerB), weight: 1 },
          ],
        },
      ],
    })) as Record<string, unknown>
    assert.isUndefined(built.Error)

    const balanceBefore = await tronWeb.trx.getBalance(ownerBase58)
    const applied = await post(
      'wallet/broadcasttransaction',
      await tronWeb.trx.sign(built as never),
    )
    assert.isTrue(applied.result)
    // the reshape burns the permission-update fee
    assert.strictEqual(
      balanceBefore - (await tronWeb.trx.getBalance(ownerBase58)),
      config.chainParameters.updateAccountPermissionFee,
    )

    // the account now reports the real set
    const account = (await tronWeb.trx.getAccount(ownerBase58)) as unknown as {
      active_permission?: { threshold: number; keys: { weight: number }[] }[]
    }
    assert.strictEqual(account.active_permission?.[0]?.threshold, 2)
    assert.strictEqual(account.active_permission?.[0]?.keys.length, 2)

    // a transfer under permission 2 signed by one key falls short
    const transfer = (await tronWeb.transactionBuilder.sendTrx(
      receiver,
      1000,
      ownerBase58,
    )) as unknown as { raw_data: { contract: { Permission_id?: number }[] } }
    transfer.raw_data.contract[0].Permission_id = 2
    const pb = utils.transaction.txJsonToPb(transfer as never)
    const record = transfer as unknown as Record<string, unknown>
    record.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '')
    record.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).replace(/^0x/, '').toLowerCase()

    const before = await probeState(node)
    const oneSig = utils.crypto.signTransaction(keyA, record as never) as unknown as Record<
      string,
      unknown
    >
    const short = await post('wallet/broadcasttransaction', oneSig)
    assert.strictEqual(short.code, 'SIGERROR')
    assert.strictEqual(TronWeb.toUtf8(String(short.message)), 'Validate signature error: sig error')
    assert.deepEqual(await probeState(node), before)

    // the weight endpoint agrees, and names the one signer it has
    const weight = (await post('wallet/getsignweight', {
      ...inVisibleForm(oneSig),
      visible: true,
    })) as {
      result?: { code?: string }
      current_weight?: number
      approved_list?: string[]
    }
    assert.strictEqual(weight.result?.code, 'NOT_ENOUGH_PERMISSION')
    assert.strictEqual(weight.current_weight, 1)
    assert.deepEqual(weight.approved_list, [signerA])

    // both signatures clear the threshold
    const bothSigs = utils.crypto.signTransaction(keyB, oneSig as never) as unknown as Record<
      string,
      unknown
    >
    assert.strictEqual((bothSigs.signature as string[]).length, 2)
    const accepted = await post('wallet/broadcasttransaction', bothSigs)
    assert.isTrue(accepted.result, JSON.stringify(accepted))
    assert.strictEqual(await tronWeb.trx.getBalance(receiver), 1000)

    const full = (await post('wallet/getsignweight', {
      ...inVisibleForm(bothSigs),
      visible: true,
    })) as {
      result?: { code?: string }
      current_weight?: number
    }
    // ENOUGH_PERMISSION is the first member of the enum, so it is not printed
    assert.isUndefined(full.result?.code)
    assert.strictEqual(full.current_weight, 2)

    // a signature the recovery cannot resolve names its own failure, and the
    // permission is already attached by the time the weighing starts
    const forged = { ...oneSig, signature: [`${'11'.repeat(64)}05`] }
    const unrecoverable = (await post('wallet/getsignweight', forged)) as {
      result?: { code?: string }
      permission?: { threshold?: number }
    }
    assert.strictEqual(unrecoverable.result?.code, 'COMPUTE_ADDRESS_ERROR')
    assert.strictEqual(unrecoverable.permission?.threshold, 2)

    // a short signature is a format error, not a recovery one
    const stunted = (await post('wallet/getsignweight', { ...oneSig, signature: ['00'] })) as {
      result?: { code?: string; message?: string }
    }
    assert.strictEqual(stunted.result?.code, 'SIGNATURE_FORMAT_ERROR')
    assert.strictEqual(stunted.result?.message, 'Signature size is 1')

    // past the chain-wide cap the reply is the verdict alone
    const flooded = (await post('wallet/getsignweight', {
      ...oneSig,
      signature: Array.from({ length: 6 }, () => `${'11'.repeat(64)}05`),
    })) as Record<string, unknown>
    assert.deepEqual(flooded, {
      result: { code: 'OTHER_ERROR', message: 'too many signatures' },
    })
  })

  it('accepts the permission set this node itself reports', async () => {
    const account = (await tronWeb.trx.getAccount(ownerBase58)) as unknown as {
      owner_permission?: Record<string, unknown>
      active_permission?: Record<string, unknown>[]
    }
    // getaccount omits `type` on the owner permission (proto3 zero value), so
    // feeding its own output back must work
    assert.isUndefined(account.owner_permission?.type)
    const reply = await post('wallet/accountpermissionupdate', {
      owner_address: TronWeb.address.toHex(ownerBase58),
      owner: account.owner_permission,
      actives: account.active_permission,
    })
    assert.isUndefined(reply.Error, JSON.stringify(reply))
  })
})

/** int64 exactness and the configurable signature cap the queries share */
describe('permission boundaries', () => {
  it('judges an int64 threshold against exact key weights', async () => {
    const config = resolveConfig()
    const node = await TronNode.create(config)
    const { server, url } = await startHttpServer(new TronProvider(node), { port: 0 })
    try {
      const owner = TronWeb.address.fromPrivateKey(
        accountsFromMnemonic(config.mnemonic)[0].privateKey,
      ) as string
      const signer = utils.accounts.generateAccount().address.base58
      // threshold one above the single key's weight — a double would round
      // them onto each other and let the policy through
      const body = `{"owner_address":"${TronWeb.address.toHex(owner)}","owner":{"type":0,"permission_name":"owner","threshold":1,"keys":[{"address":"${TronWeb.address.toHex(owner)}","weight":1}]},"actives":[{"type":2,"permission_name":"active","threshold":9007199254740996,"operations":"7fff1fc0033ec30f000000000000000000000000000000000000000000000000","keys":[{"address":"${TronWeb.address.toHex(signer)}","weight":9007199254740995}]}]}`
      const reply = (await (
        await fetch(`${url}/wallet/accountpermissionupdate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).json()) as { Error?: string }
      assert.strictEqual(
        reply.Error,
        "sum of all key's weight should not be less than threshold in permission Active",
      )
    } finally {
      server.close()
    }
  })

  it('the weight queries share the broadcast signature cap', async () => {
    const config = resolveConfig({ chainParameters: { totalSignNum: 1 } })
    const node = await TronNode.create(config)
    const { server, url } = await startHttpServer(new TronProvider(node), { port: 0 })
    try {
      const ownerKey = accountsFromMnemonic(config.mnemonic)[0].privateKey
      const owner = TronWeb.address.fromPrivateKey(ownerKey) as string
      const receiver = utils.accounts.generateAccount().address.base58
      const tronWeb = new TronWeb({ fullHost: url, privateKey: ownerKey })
      const transfer = await tronWeb.transactionBuilder.sendTrx(receiver, 1000, owner)
      const once = utils.crypto.signTransaction(ownerKey, transfer as never)
      const otherSigner = utils.accounts.generateAccount()
      const twice = utils.crypto.signTransaction(otherSigner.privateKey, once as never)
      const post = async (path: string): Promise<Record<string, unknown>> =>
        (await (
          await fetch(`${url}/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(twice),
          })
        ).json()) as Record<string, unknown>
      const weight = await post('wallet/getsignweight')
      assert.strictEqual(
        weight.result === undefined ? weight.code : (weight.result as { code?: string }).code,
        'OTHER_ERROR',
      )
      assert.include(JSON.stringify(weight), 'too many signatures')
      // the broadcast path reads the same parameter and refuses alike
      const cast = await post('wallet/broadcasttransaction')
      assert.notStrictEqual(cast.result, true)
    } finally {
      server.close()
    }
  })
})

/**
 * The producer's account is the one witness on the roll, so it is the one
 * account a witness permission belongs to — and must be stated for.
 */
describe('the witness permission', () => {
  const config = resolveConfig()
  const witnessBase58 = TronWeb.address.fromHex(WITNESS_ADDRESS)
  const otherKey = accountsFromMnemonic(config.mnemonic)[1].privateKey
  const otherBase58 = TronWeb.address.fromPrivateKey(otherKey) as string
  let node: TronNode
  let server: Server
  let baseUrl = ''

  beforeAll(async () => {
    node = await TronNode.create(config)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    // the fee is the only thing the producer's account needs a balance for
    await nodeCore(node).setBalance(parseTronAddress(WITNESS_ADDRESS), 1_000_000_000n)
  })

  afterAll(() => {
    server.close()
  })

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await response.json()) as Record<string, unknown>
  }

  const ACTIVE_OPS = '7fff1fc0033ec30f000000000000000000000000000000000000000000000000'
  const single = (type: number, name: string, address: string, extra = {}) => ({
    type,
    permission_name: name,
    threshold: 1,
    keys: [{ address: TronWeb.address.toHex(address), weight: 1 }],
    ...extra,
  })
  const request = (owner: string, witness?: unknown) => ({
    owner_address: TronWeb.address.toHex(owner),
    owner: single(0, 'owner', owner),
    ...(witness === undefined ? {} : { witness }),
    actives: [single(2, 'active', owner, { operations: ACTIVE_OPS })],
  })

  it('must be stated by the witness account, and by no other', async () => {
    assert.strictEqual(
      (await post('wallet/accountpermissionupdate', request(witnessBase58))).Error,
      'witness permission is missed',
    )
    assert.strictEqual(
      (
        await post(
          'wallet/accountpermissionupdate',
          request(otherBase58, single(1, 'witness', otherBase58)),
        )
      ).Error,
      "account isn't witness can't set witness permission",
    )
  })

  it('is judged by type and key count once it is there', async () => {
    const wrongType = request(witnessBase58, single(2, 'witness', witnessBase58))
    assert.include(
      String((await post('wallet/accountpermissionupdate', wrongType)).Error),
      'witness permission type is error',
    )
    const twoKeys = request(witnessBase58, {
      ...single(1, 'witness', witnessBase58),
      keys: [
        { address: TronWeb.address.toHex(witnessBase58), weight: 1 },
        { address: TronWeb.address.toHex(otherBase58), weight: 1 },
      ],
    })
    assert.include(
      String((await post('wallet/accountpermissionupdate', twoKeys)).Error),
      "Witness permission's key count should be 1",
    )
  })

  it('is stored under id 1 and printed between owner and active', async () => {
    const built = await post(
      'wallet/accountpermissionupdate',
      request(witnessBase58, single(1, 'witness', witnessBase58)),
    )
    assert.isUndefined(built.Error)
    const signed = utils.crypto.signTransaction(WITNESS_PRIVATE_KEY, built as never)
    const applied = await post('wallet/broadcasttransaction', signed)
    assert.isTrue(applied.result, JSON.stringify(applied))
    const account = (await post('wallet/getaccount', { address: WITNESS_ADDRESS })) as {
      witness_permission?: { type: string; id: number; permission_name: string }
    }
    assert.deepEqual(
      Object.keys(account).filter((key) => key.endsWith('_permission')),
      ['owner_permission', 'witness_permission', 'active_permission'],
    )
    assert.strictEqual(account.witness_permission?.type, 'Witness')
    assert.strictEqual(account.witness_permission?.id, 1)
    assert.strictEqual(account.witness_permission?.permission_name, 'witness')
  })
})
