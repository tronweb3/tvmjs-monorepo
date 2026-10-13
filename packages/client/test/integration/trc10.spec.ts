import { TronWeb, utils } from 'tronweb'
import { assert, afterAll, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'
import { probeState } from '../stateProbe.ts'

import type { Server } from 'node:http'
import type {
  BroadcastResult,
  TransactionInfo,
  TronAccount,
  TronTransaction,
} from '../../src/index.ts'

const actuatorMessage = (value: unknown): string => String(value ?? '')

describe('legacy TRC-10 asset stores', () => {
  it('uses the current token balance for native transfers after a token-funded deployment', async () => {
    const node = await TronNode.create({ chainParameters: { allowSameTokenName: 0 } })
    const provider = new TronProvider(node)
    const [key, peerKey] = (await node.admin.accounts()).privateKeys
    const owner = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string)
    const peer = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(peerKey) as string)
    const start = nodeCore(node).head().timestampMs + 60_000
    const issue = (await provider.request({
      method: 'wallet/createassetissue',
      params: {
        owner_address: owner,
        name: TronWeb.fromUtf8('1000001').slice(2),
        total_supply: 1000,
        trx_num: 1,
        num: 1,
        start_time: start,
        end_time: start + 86_400_000,
        url: '66',
      },
    })) as TronTransaction
    assert.isTrue(
      (
        await provider.request({
          method: 'wallet/broadcasttransaction',
          params: utils.crypto.signTransaction(key, issue),
        })
      ).result,
    )
    const deployment = (await provider.request({
      method: 'wallet/deploycontract',
      params: {
        owner_address: owner,
        bytecode: '60006000f3',
        abi: [],
        consume_user_resource_percent: 100,
        origin_energy_limit: 1,
        fee_limit: 100_000_000,
        token_id: 1_000_001,
        call_token_value: 100,
      },
    })) as TronTransaction
    assert.isTrue(
      (
        await provider.request({
          method: 'wallet/broadcasttransaction',
          params: utils.crypto.signTransaction(key, deployment),
        })
      ).result,
    )
    const account = await provider.request({
      method: 'wallet/getaccount',
      params: { address: owner },
    })
    for (const field of ['asset', 'assetV2'] as const)
      assert.strictEqual(Number(account[field]![0].value), 900)
    const rejected = await provider.request({
      method: 'wallet/transferasset',
      params: {
        owner_address: owner,
        to_address: peer,
        asset_name: TronWeb.fromUtf8('1000001').slice(2),
        amount: 1000,
      },
    })
    assert.property(rejected, 'Error')
  })

  it('does not resolve odd hex by falling back to a literal asset name', async () => {
    const node = await TronNode.create({ chainParameters: { allowSameTokenName: 0 } })
    const provider = new TronProvider(node)
    const [key, peerKey] = (await node.admin.accounts()).privateKeys
    const owner = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string)
    const peer = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(peerKey) as string)
    const start = nodeCore(node).head().timestampMs + 60_000
    const issue = (await provider.request({
      method: 'wallet/createassetissue',
      params: {
        owner_address: owner,
        name: '343134',
        total_supply: 1000,
        trx_num: 1,
        num: 1,
        start_time: start,
        end_time: start + 86_400_000,
        url: '66',
      },
    })) as TronTransaction
    assert.isTrue(
      (
        await provider.request({
          method: 'wallet/broadcasttransaction',
          params: utils.crypto.signTransaction(key, issue),
        })
      ).result,
    )
    const reply = await provider.request({
      method: 'wallet/transferasset',
      params: { owner_address: owner, to_address: peer, asset_name: '414', amount: 1 },
    })
    assert.property(reply, 'Error')
    const valid = await provider.request({
      method: 'wallet/transferasset',
      params: { owner_address: owner, to_address: peer, asset_name: '343134', amount: 1 },
    })
    assert.property(valid, 'txID')
  })

  it.each([0, 10])(
    'applies the signed-long expiry rule before the overflow guard activates at %i',
    async (activation) => {
      const node = await TronNode.create({
        runtime: { assetFrozenSupplyOverflowActivationBlock: activation },
      })
      const provider = new TronProvider(node)
      const key = (await node.admin.accounts()).privateKeys[0]
      const owner = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string)
      const max = (1n << 63n) - 1n
      const reply = await provider.request({
        method: 'wallet/createassetissue',
        params: {
          owner_address: owner,
          name: '4f766572666c6f77',
          total_supply: 1000,
          trx_num: 1,
          num: 1,
          start_time: max - 100n,
          end_time: max,
          url: '66',
          frozen_supply: [{ frozen_amount: 10, frozen_days: 1 }],
        },
      })
      if (activation === 0) {
        assert.deepEqual(reply, {
          Error: 'Start time and frozen days would cause expire time overflow',
        })
        return
      }
      assert.isTrue(
        (
          await provider.request({
            method: 'wallet/broadcasttransaction',
            params: utils.crypto.signTransaction(key, reply as TronTransaction),
          })
        ).result,
      )
      const account = await provider.request({
        method: 'wallet/getaccount',
        params: { address: owner },
      })
      assert.strictEqual(
        account.frozen_supply![0].expire_time,
        max - 100n + 86_400_000n - (1n << 64n),
      )
    },
  )

  it('keeps legacy names, V2 ids, precision, zero holdings and bandwidth views consistent', async () => {
    const node = await TronNode.create({ chainParameters: { allowSameTokenName: 0 } })
    const provider = new TronProvider(node)
    const core = nodeCore(node)
    const started = await startHttpServer(provider, { port: 0 })
    const { privateKeys } = await node.admin.accounts()
    const addresses = privateKeys.map((key) =>
      TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string),
    )
    const request = async (method: string, params: object = {}): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${started.url}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
        })
      ).json()) as Record<string, unknown>
    try {
      const execute = async (method: string, params: object, signer = 0) => {
        const tx = await request(method, { owner_address: addresses[signer], ...params })
        assert.isString(tx.txID)
        assert.isTrue(
          (
            await request(
              'wallet/broadcasttransaction',
              utils.crypto.signTransaction(privateKeys[signer], tx as never),
            )
          ).result,
        )
        return tx
      }
      const hex = (text: string) => TronWeb.fromUtf8(text).slice(2)
      const start = core.head().timestampMs + 60_000
      const fields = {
        total_supply: 1000,
        trx_num: 1,
        num: 1,
        precision: 3,
        start_time: start,
        end_time: start + 86_400_000,
        url: hex('https://example.invalid'),
        free_asset_net_limit: 1000,
        public_free_asset_net_limit: 1000,
      }
      await execute('wallet/createassetissue', { ...fields, name: hex('Zebra') })
      await execute('wallet/createassetissue', { ...fields, name: hex('Alpha') }, 1)
      const id = '1000001'
      const byName = await request('wallet/getassetissuebyname', { value: hex('Zebra') })
      assert.strictEqual(byName.precision, 3)
      assert.isUndefined((await request('wallet/getassetissuebyid', { value: id })).precision)
      assert.deepEqual(await request('wallet/getassetissuebyname', { value: hex(id) }), {})
      const list = await request('wallet/getassetissuelist')
      assert.deepEqual(
        (list.assetIssue as { id: string }[]).map((asset) => asset.id),
        ['1000002', id],
      )
      const transfer = await execute('wallet/transferasset', {
        to_address: addresses[1],
        asset_name: hex('Zebra'),
        amount: 1000,
      })
      assert.isString(transfer.txID)
      for (const prefix of ['wallet', 'walletsolidity']) {
        for (const visible of [false, true]) {
          const address = visible ? TronWeb.address.fromHex(addresses[0]) : addresses[0]
          const account = await request(`${prefix}/getaccount`, { address, visible })
          assert.deepEqual(account.asset, [{ key: 'Zebra', value: 0 }])
          assert.deepEqual(account.assetV2, [{ key: id, value: 0 }])
          assert.strictEqual(account.asset_issued_name, visible ? 'Zebra' : hex('Zebra'))
          assert.deepEqual(account.free_asset_net_usageV2, [{ key: id, value: 0 }])
        }
      }
      const issuer = parseTronAddress(addresses[0])
      const holder = parseTronAddress(addresses[1])
      await core.freezeV2(issuer, 100_000_000n, 'BANDWIDTH')
      await node.tre.increaseTime(12)
      await node.tre.mine()
      const meta = core.assets.byId(Number(id))!
      assert.isTrue(core.consumeAssetNet(holder, meta, 100))
      const stamp = Math.floor(
        (core.assetNetLedgerOf(holder)[Number(id)].lastMs -
          core.blocks.getByNumber(0n)!.timestampMs) /
          3000,
      )
      const held = await request('wallet/getaccount', { address: addresses[1] })
      assert.deepEqual(held.latest_asset_operation_timeV2, [{ key: id, value: stamp }])
      await node.tre.increaseTime(86_400)
      await node.tre.mine()
      const net = await request('wallet/getaccountnet', { address: addresses[1] })
      assert.deepEqual(net.assetNetUsed, [
        { key: 'Zebra', value: 0 },
        { key: 'Alpha', value: 0 },
      ])
      assert.strictEqual(await core.getAssetBalance(holder, Number(id)), 1000n)
      await core.transferAsset(holder, issuer, Number(id), 1n)
      assert.strictEqual((await core.getAccount(holder))!.asset![Number(id)], 999n)
    } finally {
      await new Promise<void>((resolve, reject) =>
        started.server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})

describe.each(['provider', 'http'] as const)('TRC-10 exact asset keys through %s', (transport) => {
  it.each([0, 1])(
    'preserves asset key identity in transfer and purchase with interval %s',
    async (seconds) => {
      const node = await TronNode.create()
      const provider = new TronProvider(node)
      const started =
        transport === 'http' ? await startHttpServer(provider, { port: 0 }) : undefined
      const { privateKeys } = await node.admin.accounts()
      const addresses = privateKeys.map((key) =>
        TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string),
      )
      async function request<T>(method: string, params: object = {}): Promise<T> {
        if (started === undefined) return (await provider.request({ method, params })) as T
        return (await (
          await fetch(`${started.url}/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
          })
        ).json()) as T
      }
      const hex = (text: string) => TronWeb.fromUtf8(text).slice(2)
      const sign = (tx: TronTransaction, index: number) => {
        const pb = utils.transaction.txJsonToPb(tx)
        tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).replace(/^0x/, '').toLowerCase()
        tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '')
        tx.signature = []
        return utils.crypto.signTransaction(privateKeys[index], tx)
      }
      try {
        const head = await provider.request({ method: 'wallet/getnowblock' })
        const start = head.block_header.raw_data.timestamp + 60_000
        const issue = await request<TronTransaction>('wallet/createassetissue', {
          owner_address: addresses[0],
          name: hex('ExactKey'),
          total_supply: 1000,
          trx_num: 1,
          num: 1,
          start_time: start,
          end_time: start + 86_400_000,
          url: hex('https://example.com'),
        })
        assert.isTrue(
          (await request<BroadcastResult>('wallet/broadcasttransaction', sign(issue, 0))).result,
        )
        const id = String(
          (await request<TransactionInfo>('wallet/gettransactioninfobyid', { value: issue.txID }))
            .assetIssueID,
        )
        await node.tre.increaseTime(61)
        await node.tre.blockTime(seconds)
        for (const method of ['transferasset', 'participateassetissue']) {
          const index = method === 'transferasset' ? 0 : 1
          const recipient = method === 'transferasset' ? 1 : 0
          for (const visible of [false, true]) {
            const fields = {
              owner_address: visible ? TronWeb.address.fromHex(addresses[index]) : addresses[index],
              to_address: visible
                ? TronWeb.address.fromHex(addresses[recipient])
                : addresses[recipient],
              asset_name: visible ? id : hex(id),
              amount: 7,
              visible,
            }
            const canonical = await request<
              TronTransaction<'TransferAssetContract' | 'ParticipateAssetIssueContract'>
            >(`wallet/${method}`, fields)
            assert.isString(canonical.txID)
            const snapshot = await probeState(node)
            const alias = `0${id}`
            assert.deepEqual(await request('wallet/getassetissuebyid', { value: alias }), {})
            const bad = await request<TronTransaction>(`wallet/${method}`, {
              ...fields,
              asset_name: visible ? alias : hex(alias),
            })
            assert.isUndefined(bad.txID)
            // A valid signature over an alias must be rejected even without using the builder.
            const forged = structuredClone(canonical)
            forged.raw_data.contract[0].parameter.value.asset_name = visible ? alias : hex(alias)
            const rejected = await request<BroadcastResult>(
              'wallet/broadcasttransaction',
              sign(forged, index),
            )
            assert.notStrictEqual(rejected.result, true)
            assert.strictEqual(
              'code' in rejected ? rejected.code : undefined,
              'CONTRACT_VALIDATE_ERROR',
            )
            assert.deepEqual(await probeState(node), snapshot)
            assert.isTrue(
              (
                await request<BroadcastResult>(
                  'wallet/broadcasttransaction',
                  sign(canonical, index),
                )
              ).result,
            )
            if (seconds > 0) await node.tre.mine()
          }
        }
        const buyer = await request<TronAccount>('wallet/getaccount', { address: addresses[1] })
        assert.strictEqual(
          Number(
            (buyer.assetV2 as { key: string; value: number | bigint }[]).find(
              (entry) => entry.key === id,
            )?.value,
          ),
          28,
        )
      } finally {
        await node.tre.blockTime(0)
        if (started !== undefined)
          await new Promise<void>((resolve, reject) => {
            started.server.close((error) => (error ? reject(error) : resolve()))
          })
      }
    },
  )
})

describe('TRC-10 over HTTP (issue → query → transfer → participate)', () => {
  const config = resolveConfig()
  const issuerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
  const buyerKey = accountsFromMnemonic(config.mnemonic)[1].privateKey
  const buyerBase58 = TronWeb.address.fromPrivateKey(buyerKey) as string
  let node: TronNode
  let server: Server
  let tronWeb: TronWeb
  let baseUrl = ''
  let tokenId = ''
  // pinned clock so the code can advance head time past a sale window that
  // TronWeb insists on starting in the future
  const clock = new Clock()

  beforeAll(async () => {
    node = await createNode(config, clock)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    tronWeb = new TronWeb({
      fullHost: started.url,
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    })
  })

  afterAll(() => {
    server.close()
  })

  it('createToken issues the asset, burns the 1024 TRX fee, records assetIssueID', async () => {
    const before = await tronWeb.trx.getBalance(issuerBase58)
    const unsigned = await tronWeb.transactionBuilder.createToken(
      {
        name: 'DevToken',
        abbreviation: 'DVT',
        description: 'trc10 roundtrip',
        url: 'https://devnode.invalid',
        totalSupply: 1_000_000,
        trxRatio: 1,
        tokenRatio: 1,
        saleStart: Date.now() + 5000,
        saleEnd: Date.now() + 3_600_000,
        freeBandwidth: 0,
        freeBandwidthLimit: 0,
        precision: 0,
      },
      issuerBase58,
    )
    const signed = await tronWeb.trx.sign(unsigned)
    const broadcast = await tronWeb.trx.sendRawTransaction(signed)
    assert.isTrue(broadcast.result)

    const info = (await tronWeb.trx.getTransactionInfo(signed.txID)) as {
      fee?: number
      assetIssueID?: string
    }
    assert.strictEqual(info.fee, 1_024_000_000)
    assert.isString(info.assetIssueID)
    tokenId = info.assetIssueID as string
    // ids run from 1000001 on a chain whose first issuance this is
    assert.strictEqual(tokenId, '1000001')

    // fee burned from the issuer
    assert.strictEqual(await tronWeb.trx.getBalance(issuerBase58), before - 1_024_000_000)

    // getaccount mirrors the issuance (plain-digit id)
    const account = (await tronWeb.trx.getUnconfirmedAccount(issuerBase58)) as {
      asset_issued_ID?: string
      assetV2?: { key: string; value: number }[]
    }
    assert.strictEqual(account.asset_issued_ID, tokenId)
    const holding = account.assetV2?.find((entry) => entry.key === tokenId)
    assert.strictEqual(holding?.value, 1_000_000)
  })

  it('the issuance lookups match on exact bytes and honour visible', async () => {
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>

    // the store is keyed by the id's ASCII bytes, so a padded id is a miss
    assert.strictEqual((await post('wallet/getassetissuebyid', { value: tokenId })).id, tokenId)
    assert.deepEqual(await post('wallet/getassetissuebyid', { value: `0${tokenId}` }), {})
    assert.deepEqual(await post('wallet/getassetissuebyid', { value: ` ${tokenId}` }), {})

    // by name: hex on the wire, plain text under visible
    const hexName = TronWeb.fromUtf8('DevToken').replace(/^0x/, '')
    assert.strictEqual((await post('wallet/getassetissuebyname', { value: hexName })).id, tokenId)
    const visible = await post('wallet/getassetissuebyname', {
      value: 'DevToken',
      visible: true,
    })
    assert.strictEqual(visible.id, tokenId)
    assert.strictEqual(visible.name, 'DevToken')
    assert.strictEqual(visible.url, 'https://devnode.invalid')
    assert.strictEqual(visible.owner_address, issuerBase58)
    // without visible the same fields stay hex
    const hex = await post('wallet/getassetissuebyname', { value: hexName })
    assert.strictEqual(hex.name, hexName)
    assert.strictEqual(hex.url, TronWeb.fromUtf8('https://devnode.invalid').replace(/^0x/, ''))

    // an issuer has exactly one TRC-10 issuance; the account lookup still
    // returns the protobuf list wrapper rather than the bare asset message
    const byIssuer = (await post('wallet/getassetissuebyaccount', {
      address: issuerBase58,
      visible: true,
    })) as { assetIssue?: { id?: string; owner_address?: string }[] }
    assert.lengthOf(byIssuer.assetIssue ?? [], 1)
    assert.strictEqual(byIssuer.assetIssue?.[0]?.id, tokenId)
    assert.strictEqual(byIssuer.assetIssue?.[0]?.owner_address, issuerBase58)

    // the name bytes are tried as an id too, so the id form resolves as well
    assert.strictEqual(
      (await post('wallet/getassetissuebyname', { value: tokenId, visible: true })).id,
      tokenId,
    )

    // non-hex input is a decode failure, not an empty name
    assert.deepEqual(await post('wallet/getassetissuebyname', { value: 'zz' }), {
      Error: 'exception decoding Hex string:' + ' invalid characters encountered in Hex string',
    })
  })

  it('getTokenByID / listTokens read the registry', async () => {
    const token = (await tronWeb.trx.getTokenByID(tokenId)) as {
      total_supply?: number
      name?: string
      id?: string
    }
    assert.strictEqual(token.total_supply, 1_000_000)
    assert.strictEqual(token.id, tokenId)
    // bytes fields travel hex-encoded; getTokenByID pre-decodes them
    assert.strictEqual(token.name, 'DevToken')

    const list = await tronWeb.trx.listTokens()
    assert.isAbove(list.length, 0)
  })

  it('sendToken moves balances (assetV2 on both sides)', async () => {
    const response = await tronWeb.trx.sendToken(buyerBase58, 250, tokenId)
    assert.isTrue(response.result)

    const buyer = (await tronWeb.trx.getUnconfirmedAccount(buyerBase58)) as {
      assetV2?: { key: string; value: number }[]
    }
    assert.strictEqual(buyer.assetV2?.find((e) => e.key === tokenId)?.value, 250)

    const issuer = (await tronWeb.trx.getUnconfirmedAccount(issuerBase58)) as {
      assetV2?: { key: string; value: number }[]
    }
    assert.strictEqual(issuer.assetV2?.find((e) => e.key === tokenId)?.value, 1_000_000 - 250)
  })

  it('purchaseToken trades TRX for tokens at trx_num/num', async () => {
    // move head time into the sale window (DevToken opened at now + 5s)
    clock.advanceMs(10_000)
    await node.tre.mine(1)
    const issuerTrxBefore = await tronWeb.trx.getBalance(issuerBase58)
    const unsigned = await tronWeb.transactionBuilder.purchaseToken(
      issuerBase58,
      tokenId,
      1000, // sun spent; ratio 1:1 → 1000 tokens
      buyerBase58,
    )
    const signed = await tronWeb.trx.sign(unsigned, buyerKey)
    const broadcast = await tronWeb.trx.sendRawTransaction(signed)
    assert.isTrue(broadcast.result)

    const buyer = (await tronWeb.trx.getUnconfirmedAccount(buyerBase58)) as {
      assetV2?: { key: string; value: number }[]
    }
    assert.strictEqual(buyer.assetV2?.find((e) => e.key === tokenId)?.value, 250 + 1000)
    assert.strictEqual(await tronWeb.trx.getBalance(issuerBase58), issuerTrxBefore + 1000)
  })

  it('purchaseToken multiplies before dividing, keeping the remainder', async () => {
    // a third account issues at 1000 sun : 3 tokens — a ratio where dividing
    // first would floor the spend to whole units and lose the remainder
    const ratioKey = accountsFromMnemonic(config.mnemonic)[2].privateKey
    const ratioIssuer = TronWeb.address.fromPrivateKey(ratioKey) as string
    const issue = await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.createToken(
        {
          name: 'Ratio',
          abbreviation: 'RAT',
          description: 'remainder check',
          url: 'https://devnode.invalid',
          totalSupply: 1_000_000,
          trxRatio: 1000,
          tokenRatio: 3,
          // sale windows are judged against head time, which earlier cases
          // have already advanced
          saleStart: nodeCore(node).head().timestampMs + 1000,
          saleEnd: nodeCore(node).head().timestampMs + 3_600_000,
        },
        ratioIssuer,
      ),
      ratioKey,
    )
    assert.isTrue((await tronWeb.trx.sendRawTransaction(issue)).result)
    const ratioInfo = (await tronWeb.trx.getTransactionInfo(issue.txID)) as {
      assetIssueID?: string
    }
    const ratioId = ratioInfo.assetIssueID as string

    clock.advanceMs(2000)
    await node.tre.mine(1)

    // 2500 sun: floor(2500 * 3 / 1000) = 7, not floor(2500 / 1000) * 3 = 6
    const buy = await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.purchaseToken(ratioIssuer, ratioId, 2500, buyerBase58),
      buyerKey,
    )
    assert.isTrue((await tronWeb.trx.sendRawTransaction(buy)).result)

    const buyer = (await tronWeb.trx.getUnconfirmedAccount(buyerBase58)) as {
      assetV2?: { key: string; value: number }[]
    }
    assert.strictEqual(buyer.assetV2?.find((entry) => entry.key === ratioId)?.value, 7)
  })

  it('participate rejects a to_address that is not the issuer', async () => {
    // buyer is a token holder but issued nothing; buying "from" buyer must fail
    // rather than move tokens out of that third account
    const unsigned = await tronWeb.transactionBuilder.purchaseToken(
      buyerBase58,
      tokenId,
      1000,
      issuerBase58,
    )
    const signed = await tronWeb.trx.sign(unsigned)
    const reply = (await tronWeb.trx.sendRawTransaction(signed)) as unknown as { code?: string }
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
  })

  it('participate rejects a purchase outside the sale window', async () => {
    // a token whose sale has not opened yet at the current head time
    const laterAccount = utils.accounts.generateAccount()
    const laterAddress = laterAccount.address.base58
    await nodeCore(node).setBalance(parseTronAddress(laterAddress), 2_000_000_000n)
    nodeCore(node).unlockedAccounts.add(laterAddress)
    const laterWeb = new TronWeb({ fullHost: baseUrl, privateKey: laterAccount.privateKey })
    const nowMs = nodeCore(node).head().timestampMs
    const issue = await laterWeb.trx.sign(
      await laterWeb.transactionBuilder.createToken(
        {
          name: 'Later',
          abbreviation: 'LTR',
          description: 'not open yet',
          url: 'https://devnode.invalid',
          totalSupply: 1_000_000,
          trxRatio: 1,
          tokenRatio: 1,
          saleStart: nowMs + 3_600_000, // opens an hour after the current head
          saleEnd: nowMs + 7_200_000,
        },
        laterAddress,
      ),
    )
    assert.isTrue((await tronWeb.trx.sendRawTransaction(issue)).result)
    const laterId = (
      (await tronWeb.trx.getTransactionInfo(issue.txID)) as { assetIssueID?: string }
    ).assetIssueID as string

    const buy = await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.purchaseToken(laterAddress, laterId, 1000, buyerBase58),
      buyerKey,
    )
    const reply = (await tronWeb.trx.sendRawTransaction(buy)) as unknown as { code?: string }
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
  })

  it('issuance field rules match the actuator, and rejects cost nothing', async () => {
    // a fresh funded issuer per case, so "one asset per account" never masks
    // the field rule under test
    let caseIndex = 0
    const attempt = async (overrides: Record<string, unknown>): Promise<string | undefined> => {
      caseIndex += 1
      const issuer = utils.accounts.generateAccount().address.base58
      await nodeCore(node).setBalance(parseTronAddress(issuer), 2_000_000_000n)
      nodeCore(node).unlockedAccounts.add(issuer)
      const headMs = nodeCore(node).head().timestampMs
      const built = await tronWeb.transactionBuilder.createToken(
        {
          name: `FieldRule${caseIndex}`,
          abbreviation: 'OK',
          description: 'field rules',
          url: 'https://devnode.invalid',
          totalSupply: 1_000_000,
          trxRatio: 1,
          tokenRatio: 1,
          saleStart: headMs + 60_000,
          saleEnd: headMs + 3_600_000,
        },
        issuer,
      )
      // rewrite the wire fields directly: TronWeb screens most of these before
      // they can reach the node
      const tx = built as unknown as {
        txID: string
        raw_data_hex: string
        raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] }
      }
      Object.assign(tx.raw_data.contract[0].parameter.value, overrides)
      // the txID covers raw_data, so re-derive it or the signature check trips
      // before any field rule is reached
      const pb = utils.transaction.txJsonToPb(tx as never)
      tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '')
      tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).replace(/^0x/, '').toLowerCase()

      const balanceBefore = await tronWeb.trx.getBalance(issuer)
      const tokensBefore = (await tronWeb.trx.listTokens()).length
      const reply = (await tronWeb.trx.sendRawTransaction({
        ...(tx as unknown as Record<string, unknown>),
        signature: ['00'.repeat(65)],
      } as never)) as unknown as { result?: boolean; code?: string; message?: string }
      if (reply.result === true) return undefined
      assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
      assert.strictEqual(await tronWeb.trx.getBalance(issuer), balanceBefore)
      assert.strictEqual((await tronWeb.trx.listTokens()).length, tokensBefore)
      // the validate-error prefix is pinned in rejections.spec.ts
      return TronWeb.toUtf8(reply.message as string).replace(/^Contract validate error : /, '')
    }

    // the unmodified transaction is accepted, so each failure below is caused
    // by its own override
    assert.isUndefined(await attempt({}))

    assert.strictEqual(
      await attempt({ name: TronWeb.fromUtf8('trx').slice(2) }),
      "assetName can't be trx",
    )
    assert.strictEqual(await attempt({ name: '' }), 'Invalid assetName')
    assert.strictEqual(
      await attempt({ name: TronWeb.fromUtf8('a'.repeat(33)).slice(2) }),
      'Invalid assetName',
    )
    // 0x20 is a space, below the printable floor the actuator enforces
    assert.strictEqual(await attempt({ name: '4120' }), 'Invalid assetName')
    assert.strictEqual(await attempt({ precision: 7 }), 'precision cannot exceed 6')
    assert.strictEqual(await attempt({ url: '' }), 'Invalid url')
    assert.strictEqual(
      await attempt({ description: TronWeb.fromUtf8('d'.repeat(201)).slice(2) }),
      'Invalid description',
    )
    assert.strictEqual(await attempt({ total_supply: 0 }), 'TotalSupply must greater than 0!')
    assert.strictEqual(await attempt({ trx_num: 0 }), 'TrxNum must greater than 0!')
    assert.strictEqual(await attempt({ num: 0 }), 'Num must greater than 0!')
    assert.strictEqual(await attempt({ start_time: 0 }), 'Start time should be not empty')
    assert.strictEqual(await attempt({ end_time: 0 }), 'End time should be not empty')

    const headMs = nodeCore(node).head().timestampMs
    assert.strictEqual(
      await attempt({ start_time: headMs + 60_000, end_time: headMs + 30_000 }),
      'End time should be greater than start time',
    )
    assert.strictEqual(
      await attempt({ start_time: headMs - 1000, end_time: headMs + 3_600_000 }),
      'Start time should be greater than HeadBlockTime',
    )
  })

  it('frozen_supply is validated and withheld from the issuer', async () => {
    const issuerKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const issuerBase58 = TronWeb.address.fromPrivateKey(issuerKey) as string
    await nodeCore(node).setBalance(parseTronAddress(issuerBase58), 2_000_000_000n)
    nodeCore(node).unlockedAccounts.add(issuerBase58)
    const web = new TronWeb({ fullHost: baseUrl, privateKey: issuerKey })

    const issue = async (frozen: unknown[]): Promise<Record<string, unknown>> => {
      const start = nodeCore(node).head().timestampMs + 60_000
      const tx = (await web.transactionBuilder.createToken(
        {
          name: `FZ${frozen.length}${start % 1000}`,
          abbreviation: 'FZ',
          description: 'frozen supply',
          url: 'https://example.com',
          totalSupply: 1_000_000,
          trxRatio: 1,
          tokenRatio: 1,
          saleStart: start,
          saleEnd: start + 600_000,
          freeBandwidth: 0,
          freeBandwidthLimit: 0,
          frozenAmount: 0,
          frozenDuration: 0,
        },
        issuerBase58,
      )) as unknown as Record<string, unknown>
      const value = (
        tx.raw_data as { contract: { parameter: { value: Record<string, unknown> } }[] }
      ).contract[0].parameter.value
      value.frozen_supply = frozen
      const pb = utils.transaction.txJsonToPb(tx as never)
      tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '')
      tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).replace(/^0x/, '').toLowerCase()
      return (await tronWeb.trx.sendRawTransaction({
        ...tx,
        signature: ['00'.repeat(65)],
      } as never)) as unknown as Record<string, unknown>
    }

    const zero = await issue([{ frozen_amount: 0, frozen_days: 1 }])
    assert.strictEqual(
      TronWeb.toUtf8(zero.message as string).replace(/^Contract validate error : /, ''),
      'Frozen supply must be greater than 0!',
    )

    const tooMuch = await issue([{ frozen_amount: 2_000_000, frozen_days: 1 }])
    assert.strictEqual(
      TronWeb.toUtf8(tooMuch.message as string).replace(/^Contract validate error : /, ''),
      'Frozen supply cannot exceed total supply',
    )

    const badDays = await issue([{ frozen_amount: 1000, frozen_days: 4000 }])
    assert.strictEqual(
      TronWeb.toUtf8(badDays.message as string).replace(/^Contract validate error : /, ''),
      'frozenDuration must be less than 3652 days and more than 1 days',
    )

    // a valid tranche: the issuer receives the remainder, not the whole supply
    const ok = await issue([{ frozen_amount: 400_000, frozen_days: 30 }])
    assert.isTrue(ok.result)
    const account = (await web.trx.getAccount(issuerBase58)) as unknown as {
      assetV2?: { key: string; value: number }[]
    }
    const held = account.assetV2?.[0]?.value
    assert.strictEqual(held, 600_000)
  })

  it('frozen supply is held on the issuer and released when its window passes', async () => {
    const issuerKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const issuer = TronWeb.address.fromPrivateKey(issuerKey) as string
    await nodeCore(node).setBalance(parseTronAddress(issuer), 2_000_000_000n)
    nodeCore(node).unlockedAccounts.add(issuer)
    const web = new TronWeb({ fullHost: baseUrl, privateKey: issuerKey })

    const start = nodeCore(node).head().timestampMs + 60_000
    // built through the endpoint a plain HTTP client would call, so the
    // builder's own field handling is under test
    const built = (await (
      await fetch(`${baseUrl}/wallet/createassetissue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_address: TronWeb.address.toHex(issuer),
          name: TronWeb.fromUtf8('FROZEN').replace(/^0x/, ''),
          abbr: TronWeb.fromUtf8('FRZ').replace(/^0x/, ''),
          description: TronWeb.fromUtf8('frozen lifecycle').replace(/^0x/, ''),
          url: TronWeb.fromUtf8('https://example.com').replace(/^0x/, ''),
          total_supply: 1_000_000,
          trx_num: 1,
          num: 1,
          start_time: start,
          end_time: start + 600_000,
          // Request member order must not leak into the protobuf transaction
          // echo: FrozenSupply is field 1 (`frozen_amount`) then field 2.
          frozen_supply: [{ frozen_days: 2, frozen_amount: 400_000 }],
        }),
      })
    ).json()) as Record<string, unknown>
    assert.isUndefined(built.Error, JSON.stringify(built))
    // the field survived the build, which is the point of going through it
    const builtValue = (
      built.raw_data as { contract: { parameter: { value: Record<string, unknown> } }[] }
    ).contract[0].parameter.value
    assert.deepEqual(builtValue.frozen_supply, [{ frozen_amount: 400_000, frozen_days: 2 }])

    const issued = (await (
      await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...built, signature: ['00'.repeat(65)] }),
      })
    ).json()) as { result?: boolean }
    assert.isTrue(issued.result, JSON.stringify(issued))

    // the issuer holds the unfrozen remainder, and the locked part is on record
    const account = (await web.trx.getAccount(issuer)) as unknown as {
      assetV2?: { key: string; value: number }[]
      frozen_supply?: { frozen_balance: number; expire_time: number }[]
    }
    const tokenId = account.assetV2?.[0]?.key as string
    assert.strictEqual(account.assetV2?.[0]?.value, 600_000)
    assert.deepEqual(account.frozen_supply, [
      { frozen_balance: 400_000, expire_time: start + 2 * 86_400_000 },
    ])

    const build = async (): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/unfreezeasset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ owner_address: TronWeb.address.toHex(issuer) }),
        })
      ).json()) as Record<string, unknown>

    // before the window passes the build endpoint already refuses
    assert.strictEqual((await build()).Error, "It's not time to unfreeze asset supply")

    // the window is judged against the head block time, so advance the chain
    clock.advanceMs(3 * 86_400_000)
    await node.tre.mine(1)

    // the whole round trip a plain HTTP client would make: build, sign, broadcast
    const unfreezeTx = await build()
    assert.isUndefined(unfreezeTx.Error)
    const signed = utils.crypto.signTransaction(
      issuerKey,
      unfreezeTx as never,
    ) as unknown as Record<string, unknown>
    const accepted = (await (
      await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
      })
    ).json()) as Record<string, unknown>
    assert.isTrue(accepted.result, JSON.stringify(accepted))

    const after = (await web.trx.getAccount(issuer)) as unknown as {
      assetV2?: { key: string; value: number }[]
      frozen_supply?: unknown
    }
    assert.strictEqual(after.assetV2?.find((a) => a.key === tokenId)?.value, 1_000_000)
    assert.isUndefined(after.frozen_supply)

    // nothing matured means nothing to release
    assert.isUndefined(
      await nodeCore(node).unfreezeAsset(parseTronAddress(issuer), Number(tokenId)),
    )
  })

  it('the participate rules run in the baseline order', async () => {
    const buyerKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const buyer = TronWeb.address.fromPrivateKey(buyerKey) as string
    const ghost = utils.accounts.generateAccount().address.base58

    const build = async (body: Record<string, unknown>): Promise<string> => {
      const reply = (await (
        await fetch(`${baseUrl}/wallet/participateassetissue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visible: true, ...body }),
        })
      ).json()) as { Error?: string }
      return actuatorMessage(reply.Error)
    }

    // an unfunded buyer fails on its own account before the asset is looked up,
    // so a nonexistent token is not what gets reported
    assert.strictEqual(
      await build({ owner_address: ghost, to_address: buyer, asset_name: '9999999', amount: 1 }),
      'Account does not exist!',
    )

    await nodeCore(node).setBalance(parseTronAddress(buyer), 10n)
    assert.strictEqual(
      await build({ owner_address: buyer, to_address: ghost, asset_name: '9999999', amount: 1000 }),
      'No enough balance !',
    )

    await nodeCore(node).setBalance(parseTronAddress(buyer), 1_000_000_000n)
    // now the asset check is reached, and it names the token
    assert.strictEqual(
      await build({ owner_address: buyer, to_address: ghost, asset_name: '9999999', amount: 1000 }),
      'No asset named 9999999',
    )
  })

  it('a second issuance from the same account is rejected and costs nothing', async () => {
    const before = await tronWeb.trx.getBalance(issuerBase58)
    const tokensBefore = (await tronWeb.trx.listTokens()).length
    const unsigned = await tronWeb.transactionBuilder.createToken(
      {
        name: 'Second',
        abbreviation: 'SND',
        description: 'should fail',
        url: 'https://devnode.invalid',
        totalSupply: 10,
        trxRatio: 1,
        tokenRatio: 1,
        saleStart: Date.now() + 5000,
        saleEnd: Date.now() + 3_600_000,
      },
      issuerBase58,
    )
    const signed = await tronWeb.trx.sign(unsigned)
    const response = (await tronWeb.trx.sendRawTransaction(signed)) as unknown as {
      code?: string
    }
    assert.strictEqual(response.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(await tronWeb.trx.getBalance(issuerBase58), before)
    assert.strictEqual((await tronWeb.trx.listTokens()).length, tokensBefore)
  })

  // These two endpoints exist for callers that speak plain HTTP: build here,
  // sign the id the node derived, broadcast it back. TronWeb never touches
  // them — it assembles the protobuf itself — so nothing else covers them.
  it('transferasset builds a signable transfer, in both address forms', async () => {
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>

    const held = async (owner: string): Promise<number> => {
      const account = (await post('wallet/getaccount', { address: owner, visible: true })) as {
        assetV2?: { key: string; value: number }[]
      }
      return account.assetV2?.find((entry) => entry.key === tokenId)?.value ?? 0
    }
    // a third account keeps this out of the balances the sale tests assert on
    const recipient = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[2].privateKey,
    ) as string
    const before = await held(recipient)

    // visible: the id travels as text and comes back decoded, but the bytes
    // the id was computed over are the hex ones
    const built = await post('wallet/transferasset', {
      owner_address: issuerBase58,
      to_address: recipient,
      asset_name: tokenId,
      amount: 7,
      visible: true,
    })
    assert.isUndefined(built.Error, JSON.stringify(built))
    const raw = built.raw_data as { contract: { parameter: { value: Record<string, unknown> } }[] }
    const value = raw.contract[0].parameter.value
    assert.strictEqual(value.asset_name, tokenId)
    // proto field order for this contract puts the asset first
    assert.deepEqual(Object.keys(value), ['asset_name', 'owner_address', 'to_address', 'amount'])

    // the node's own id has to be the one a signature is accepted for
    const signed = await tronWeb.trx.sign(built as never)
    assert.strictEqual((signed as { txID: string }).txID, built.txID)
    const bc = await post('wallet/broadcasttransaction', signed)
    assert.isTrue(bc.result, JSON.stringify(bc))
    assert.strictEqual(await held(recipient), before + 7)

    // hex form: the id is hex on the way in and stays hex on the way out
    const hexBuilt = await post('wallet/transferasset', {
      owner_address: TronWeb.address.toHex(issuerBase58),
      to_address: TronWeb.address.toHex(recipient),
      asset_name: TronWeb.fromUtf8(tokenId).replace(/^0x/, ''),
      amount: 3,
    })
    const hexValue = (
      hexBuilt.raw_data as { contract: { parameter: { value: { asset_name: string } } }[] }
    ).contract[0].parameter.value
    assert.strictEqual(hexValue.asset_name, TronWeb.fromUtf8(tokenId).replace(/^0x/, ''))
    assert.isTrue(
      (await post('wallet/broadcasttransaction', await tronWeb.trx.sign(hexBuilt as never))).result,
    )
    assert.strictEqual(await held(recipient), before + 10)
  })

  // An asset transfer draws on the issuance's free bandwidth, so the asset is
  // looked up while billing — before any actuator. The wording carries an
  // object identity hash that differs between two identical calls, so only the
  // shape around it is fixed.
  it('a transfer of an asset that does not exist is refused while billing', async () => {
    const web = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    })
    const recipient = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[1].privateKey,
    ) as string
    const before = await probeState(node)

    const tx = await web.transactionBuilder.sendToken(recipient, 5, '143234', issuerBase58)
    const reply = (await web.trx.sendRawTransaction(await web.trx.sign(tx))) as unknown as {
      code?: string
      message?: string
    }
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    const message = TronWeb.toUtf8(reply.message ?? '')
    assert.match(
      message,
      /^Contract validate error : asset \[<ByteString@[0-9a-f]{1,8} size=6 contents="143234">\] does not exist$/,
    )
    // billing was refused, so the rejection left no trace
    assert.deepEqual(await probeState(node), before)
  })

  it('updateasset amends the mutable fields and rejects the rest', async () => {
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>

    const built = await post('wallet/updateasset', {
      owner_address: TronWeb.address.toHex(issuerBase58),
      description: TronWeb.fromUtf8('amended').replace(/^0x/, ''),
      url: TronWeb.fromUtf8('https://amended.invalid').replace(/^0x/, ''),
      new_limit: 10,
      new_public_limit: 20,
    })
    assert.isUndefined(built.Error, JSON.stringify(built))
    assert.isTrue(
      (await post('wallet/broadcasttransaction', await tronWeb.trx.sign(built as never))).result,
    )

    const asset = await post('wallet/getassetissuebyid', { value: tokenId, visible: true })
    assert.strictEqual(asset.description, 'amended')
    assert.strictEqual(asset.url, 'https://amended.invalid')
    assert.strictEqual(asset.free_asset_net_limit, 10)
    assert.strictEqual(asset.public_free_asset_net_limit, 20)

    // an empty url is out of range, and the build says so rather than sealing
    const rejected = await post('wallet/updateasset', {
      owner_address: TronWeb.address.toHex(issuerBase58),
      description: '',
      url: '',
      new_limit: 10,
      new_public_limit: 20,
    })
    assert.strictEqual(actuatorMessage(rejected.Error), 'Invalid url')
  })
})

describe('TRC-10 signature integrity, int64 fidelity and asset bandwidth', () => {
  const config = resolveConfig()
  const issuerKey = accountsFromMnemonic(config.mnemonic)[0].privateKey
  const issuerBase58 = TronWeb.address.fromPrivateKey(issuerKey) as string
  const holderKey = accountsFromMnemonic(config.mnemonic)[1].privateKey
  const holderBase58 = TronWeb.address.fromPrivateKey(holderKey) as string
  const otherKey = accountsFromMnemonic(config.mnemonic)[2].privateKey
  const otherBase58 = TronWeb.address.fromPrivateKey(otherKey) as string
  const clock = new Clock()
  let node: TronNode
  let server: Server
  let baseUrl = ''
  let tokenId = ''

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>

  const postText = async (path: string, body: unknown): Promise<string> =>
    (
      await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    ).text()

  // signs the server-computed txID directly: the bundled client-side signer
  // re-encodes raw_data to verify it, and its encoder cannot reproduce a
  // multi-tranche issuance, whatever node it talks to
  const signAndSend = async (built: Record<string, unknown>, key: string): Promise<void> => {
    assert.isUndefined(built.Error, JSON.stringify(built).slice(0, 200))
    const signed = utils.crypto.signTransaction(key, built as never)
    const reply = await post('wallet/broadcasttransaction', signed)
    assert.isTrue(reply.result, JSON.stringify(reply).slice(0, 200))
  }

  /** head time follows the clock only once a block seals at the new time */
  const advanceHead = async (ms: number): Promise<void> => {
    clock.advanceMs(ms)
    await post('tre', { jsonrpc: '2.0', id: 1, method: 'tre_mine', params: [] })
  }

  beforeAll(async () => {
    node = await createNode(config, clock)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    // the issuer's staked bandwidth is the third gate of the asset lane
    await signAndSend(
      await post('wallet/freezebalancev2', {
        owner_address: issuerBase58,
        frozen_balance: 5_000_000_000,
        resource: 'BANDWIDTH',
        visible: true,
      }),
      issuerKey,
    )
  })

  afterAll(() => {
    server.close()
  })

  it('signs a server-built issuance that states the limit fields as zero', async () => {
    const built = await post('wallet/createassetissue', {
      owner_address: TronWeb.address.toHex(otherBase58),
      name: TronWeb.fromUtf8('ZeroLimits').slice(2),
      abbr: TronWeb.fromUtf8('ZL').slice(2),
      total_supply: 1000,
      trx_num: 1,
      num: 1,
      start_time: nodeCore(node).head().timestampMs + 60_000,
      end_time: nodeCore(node).head().timestampMs + 86_400_000,
      url: TronWeb.fromUtf8('https://zero.invalid').slice(2),
      free_asset_net_limit: 0,
      public_free_asset_net_limit: 0,
    })
    assert.isUndefined(built.Error, JSON.stringify(built).slice(0, 200))
    // explicit protobuf defaults stay out of the id, so re-hashing the printed
    // raw_data reproduces it and the signature checks out
    const wallet = new TronWeb({ fullHost: baseUrl, privateKey: otherKey })
    const signed = (await wallet.trx.sign(built as never)) as { signature?: string[] }
    assert.isString(signed.signature?.[0])
  })

  it('issues with two frozen tranches and keeps order; both tranches are signed over', async () => {
    const startTime = nodeCore(node).head().timestampMs + 10_000
    const built = await post('wallet/createassetissue', {
      owner_address: TronWeb.address.toHex(issuerBase58),
      name: TronWeb.fromUtf8('BigToken').slice(2),
      abbr: TronWeb.fromUtf8('BIG').slice(2),
      total_supply: 9_100_000_000_000_000,
      trx_num: 1,
      num: 1,
      start_time: startTime,
      end_time: startTime + 30 * 86_400_000,
      url: TronWeb.fromUtf8('https://big.invalid').slice(2),
      free_asset_net_limit: 2_000,
      public_free_asset_net_limit: 3_000,
      order: 7,
      frozen_supply: [
        { frozen_amount: 100, frozen_days: 1 },
        { frozen_amount: 200, frozen_days: 2 },
      ],
    })
    const value = (
      built.raw_data as { contract: { parameter: { value: Record<string, unknown> } }[] }
    ).contract[0]?.parameter.value as { frozen_supply: unknown[] }
    assert.lengthOf(value.frozen_supply, 2)
    await signAndSend(built, issuerKey)

    const account = (await post('wallet/getaccount', {
      address: issuerBase58,
      visible: true,
    })) as { asset_issued_ID?: string }
    tokenId = account.asset_issued_ID as string
    const asset = await post('wallet/getassetissuebyid', { value: tokenId, visible: true })
    assert.strictEqual(asset.order, 7)
    assert.lengthOf(asset.frozen_supply as unknown[], 2)
    // int64 survives to the wire in full precision
    assert.include(
      await postText('wallet/getassetissuebyid', { value: tokenId }),
      '"total_supply":9100000000000000',
    )
    await advanceHead(15_000)
  })

  it('refuses a signed issuance that grew a frozen tranche afterwards', async () => {
    const built = await post('wallet/createassetissue', {
      owner_address: TronWeb.address.toHex(otherBase58),
      name: TronWeb.fromUtf8('Tamper').slice(2),
      abbr: TronWeb.fromUtf8('TMP').slice(2),
      total_supply: 1000,
      trx_num: 1,
      num: 1,
      start_time: nodeCore(node).head().timestampMs + 60_000,
      end_time: nodeCore(node).head().timestampMs + 86_400_000,
      url: TronWeb.fromUtf8('https://tamper.invalid').slice(2),
      frozen_supply: [{ frozen_amount: 100, frozen_days: 1 }],
    })
    const wallet = new TronWeb({ fullHost: baseUrl, privateKey: otherKey })
    const signed = (await wallet.trx.sign(built as never)) as unknown as {
      raw_data: { contract: { parameter: { value: { frozen_supply: unknown[] } } }[] }
    }
    signed.raw_data.contract[0]?.parameter.value.frozen_supply.push({
      frozen_amount: 400,
      frozen_days: 3,
    })
    const reply = await post('wallet/broadcasttransaction', signed)
    assert.strictEqual(reply.code, 'SIGERROR')
  })

  it('refuses an amount past what it can sign for, and moves one under it', async () => {
    const brim = '9007199254740993'
    // refused where it is built, so no id is ever handed out for it
    assert.include(
      await postText(
        'wallet/transferasset',
        `{"owner_address":"${TronWeb.address.toHex(issuerBase58)}","to_address":"${TronWeb.address.toHex(holderBase58)}","asset_name":"${TronWeb.fromUtf8(tokenId).slice(2)}","amount":${brim}}`,
      ),
      'the widest this node signs for',
    )

    // and refused again where a body states one directly, so an id signed
    // elsewhere cannot carry a figure the encoder would hash as another
    const fits = '9007199254740991'
    const ok = await postText(
      'wallet/transferasset',
      `{"owner_address":"${TronWeb.address.toHex(issuerBase58)}","to_address":"${TronWeb.address.toHex(holderBase58)}","asset_name":"${TronWeb.fromUtf8(tokenId).slice(2)}","amount":${fits}}`,
    )
    const signed = utils.crypto.signTransaction(issuerKey, JSON.parse(ok) as never)
    const tampered = await post(
      'wallet/broadcasttransaction',
      JSON.stringify(signed).replace(`"amount":${fits}`, `"amount":${brim}`),
    )
    assert.strictEqual(tampered.code, 'CONTRACT_VALIDATE_ERROR')
    assert.include(TronWeb.toUtf8(tampered.message as string), 'the widest this node signs for')

    // the widest it does sign for goes through whole
    assert.include(ok, `"amount":${fits}`)
    const sent = await post('wallet/broadcasttransaction', JSON.stringify(signed))
    assert.isTrue(sent.result, JSON.stringify(sent).slice(0, 200))
    assert.include(
      await postText('wallet/getaccount', { address: holderBase58, visible: true }),
      `"value":${fits}`,
    )
  })

  it("bills a holder's transfer to the issuance lanes, not the holder", async () => {
    const built = await post('wallet/transferasset', {
      owner_address: holderBase58,
      to_address: otherBase58,
      asset_name: tokenId,
      amount: 50,
      visible: true,
    })
    await signAndSend(built, holderKey)

    const holderNet = (await post('wallet/getaccountnet', {
      address: holderBase58,
      visible: true,
    })) as { freeNetUsed?: number; assetNetUsed?: { key: string; value: number }[] }
    // the holder's own free allowance is untouched; the per-asset one is drawn
    assert.isUndefined(holderNet.freeNetUsed)
    const assetUsed = holderNet.assetNetUsed?.find((entry) => entry.key === tokenId)
    assert.isAbove(assetUsed?.value ?? 0, 0)

    // the issuer's staked bandwidth paid the bytes
    const issuerNet = (await post('wallet/getaccountresource', {
      address: holderBase58 && issuerBase58,
      visible: true,
    })) as { NetUsed?: number }
    assert.isAbove(issuerNet.NetUsed ?? 0, 0)

    // and the shared pool moved with them
    const asset = await post('wallet/getassetissuebyid', { value: tokenId, visible: true })
    assert.isAbove(Number(asset.public_free_asset_net_usage ?? 0), 0)
  })

  it('refuses a participation whose token product overflows a signed long', async () => {
    const startTime = nodeCore(node).head().timestampMs + 5_000
    await signAndSend(
      await post('wallet/createassetissue', {
        owner_address: TronWeb.address.toHex(otherBase58),
        name: TronWeb.fromUtf8('Ratio').slice(2),
        abbr: TronWeb.fromUtf8('RT').slice(2),
        total_supply: 9_000_000_000_000_000,
        trx_num: 2_147_483_647,
        num: 2_147_483_647,
        start_time: startTime,
        end_time: startTime + 86_400_000,
        url: TronWeb.fromUtf8('https://ratio.invalid').slice(2),
      }),
      otherKey,
    )
    await advanceHead(10_000)
    const otherAccount = (await post('wallet/getaccount', {
      address: otherBase58,
      visible: true,
    })) as { asset_issued_ID?: string }
    const reply = await post('wallet/participateassetissue', {
      owner_address: holderBase58,
      to_address: otherBase58,
      asset_name: otherAccount.asset_issued_ID,
      amount: 5_000_000_000,
      visible: true,
    })
    assert.include(String(reply.Error ?? ''), 'long overflow')
  })

  it('refuses an issuance whose tranche expiry would overflow a signed long', async () => {
    const reply = await post('wallet/createassetissue', {
      owner_address: TronWeb.address.toHex(holderBase58),
      name: TronWeb.fromUtf8('Overflow').slice(2),
      abbr: TronWeb.fromUtf8('OV').slice(2),
      total_supply: 1000,
      trx_num: 1,
      num: 1,
      start_time: 9_223_372_036_800_000_000,
      end_time: 9_223_372_036_850_000_000,
      url: TronWeb.fromUtf8('https://overflow.invalid').slice(2),
      frozen_supply: [{ frozen_amount: 10, frozen_days: 1 }],
    })
    assert.include(
      String(reply.Error ?? ''),
      'Start time and frozen days would cause expire time overflow',
    )
  })

  it('refuses a participation the issuer has no room to be paid for', async () => {
    // an issuer of its own: a TRC-10 is one per account and the roster is spoken for
    const sellerKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const sellerBase58 = TronWeb.address.fromPrivateKey(sellerKey) as string
    await nodeCore(node).setBalance(parseTronAddress(sellerBase58), 2_000_000_000n)
    const startTime = nodeCore(node).head().timestampMs + 5_000
    await signAndSend(
      await post('wallet/createassetissue', {
        owner_address: TronWeb.address.toHex(sellerBase58),
        name: TronWeb.fromUtf8('Brimful').slice(2),
        abbr: TronWeb.fromUtf8('BRM').slice(2),
        total_supply: 1_000_000,
        trx_num: 1,
        num: 1,
        start_time: startTime,
        end_time: startTime + 86_400_000,
        url: TronWeb.fromUtf8('https://brimful.invalid').slice(2),
      }),
      sellerKey,
    )
    await advanceHead(10_000)
    await nodeCore(node).setBalance(parseTronAddress(sellerBase58), 9_223_372_036_854_775_807n)
    const seller = (await post('wallet/getaccount', {
      address: sellerBase58,
      visible: true,
    })) as { asset_issued_ID?: string }
    const built = await post('wallet/participateassetissue', {
      owner_address: TronWeb.address.toHex(holderBase58),
      to_address: TronWeb.address.toHex(sellerBase58),
      asset_name: TronWeb.fromUtf8(String(seller.asset_issued_ID)).slice(2),
      amount: 1_000_000,
    })
    assert.isUndefined(built.Error, JSON.stringify(built).slice(0, 200))
    const reply = await post(
      'wallet/broadcasttransaction',
      utils.crypto.signTransaction(holderKey, built as never),
    )
    assert.strictEqual(reply.code, 'CONTRACT_EXE_ERROR')
    assert.strictEqual(
      TronWeb.toUtf8(String(reply.message)),
      'Contract execute error : long overflow',
    )
  })

  it('refuses an unfreeze the issuer has no room to be paid back into', async () => {
    const lockKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const lockBase58 = TronWeb.address.fromPrivateKey(lockKey) as string
    await nodeCore(node).setBalance(parseTronAddress(lockBase58), 2_000_000_000n)
    const startTime = nodeCore(node).head().timestampMs + 5_000
    await signAndSend(
      await post('wallet/createassetissue', {
        owner_address: TronWeb.address.toHex(lockBase58),
        name: TronWeb.fromUtf8('Thawing').slice(2),
        abbr: TronWeb.fromUtf8('THW').slice(2),
        total_supply: 1_000_000,
        trx_num: 1,
        num: 1,
        start_time: startTime,
        end_time: startTime + 86_400_000,
        url: TronWeb.fromUtf8('https://thawing.invalid').slice(2),
        frozen_supply: [{ frozen_amount: 500_000, frozen_days: 1 }],
      }),
      lockKey,
    )
    await advanceHead(86_400_000 + 10_000)
    const locked = (await post('wallet/getaccount', {
      address: lockBase58,
      visible: true,
    })) as { asset_issued_ID?: string }
    await nodeCore(node).creditAsset(
      parseTronAddress(lockBase58),
      Number(locked.asset_issued_ID),
      9_223_372_036_854_775_807n,
    )
    const built = await post('wallet/unfreezeasset', {
      owner_address: TronWeb.address.toHex(lockBase58),
    })
    assert.isUndefined(built.Error, JSON.stringify(built).slice(0, 200))
    const reply = await post(
      'wallet/broadcasttransaction',
      utils.crypto.signTransaction(lockKey, built as never),
    )
    assert.strictEqual(reply.code, 'CONTRACT_EXE_ERROR')
    assert.strictEqual(
      TronWeb.toUtf8(String(reply.message)),
      'Contract execute error : long overflow',
    )
  })

  it('carries int64 boundaries digit-exact through issue, state and query', async () => {
    const MAX = '9223372036854775807'
    const issue = async (ownerIndex: number, fields: string): Promise<string> => {
      const key = accountsFromMnemonic(config.mnemonic)[ownerIndex]!.privateKey
      const owner = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string)
      const built = await postText(
        'wallet/createassetissue',
        `{"owner_address":"${owner}",${fields}}`,
      )
      const signed = utils.crypto.signTransaction(key, JSON.parse(built) as never) as unknown as {
        signature: string[]
      }
      // the broadcast body must carry the exact digits, which a JSON round
      // trip through the test client would round away — the signature is
      // spliced into the builder's own text instead
      const body = built.trim().replace(/}$/, `,"signature":["${signed.signature[0]}"]}`)
      const reply = (await post('wallet/broadcasttransaction', body)) as { result?: boolean }
      assert.isTrue(reply.result, body.slice(0, 160))
      return built
    }

    const start = nodeCore(node).head().timestampMs + 60_000
    const end = nodeCore(node).head().timestampMs + 86_400_000
    const supplyMax = await issue(
      3,
      `"name":"${TronWeb.fromUtf8('MaxSupply').slice(2)}","abbr":"${TronWeb.fromUtf8('MS').slice(2)}","total_supply":${MAX},"trx_num":1,"num":1,"start_time":${start},"end_time":${end},"url":"${TronWeb.fromUtf8('https://max.invalid').slice(2)}"`,
    )
    assert.include(supplyMax, `"total_supply":${MAX}`)
    const ownerMax = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[3]!.privateKey,
    ) as string
    const accountMax = await postText('wallet/getaccount', { address: ownerMax, visible: true })
    assert.include(accountMax, `"value":${MAX}`)
    const idMax = /"asset_issued_ID":"(\d+)"/.exec(accountMax)?.[1] as string
    assert.include(
      await postText('wallet/getassetissuebyid', { value: idMax }),
      `"total_supply":${MAX}`,
    )

    // nested tranche amounts and the order field keep their digits too
    const nested = await issue(
      4,
      `"name":"${TronWeb.fromUtf8('NestedMax').slice(2)}","abbr":"${TronWeb.fromUtf8('NM').slice(2)}","total_supply":9100000000000000,"trx_num":1,"num":1,"start_time":${start},"end_time":${end},"order":${MAX},"frozen_supply":[{"frozen_amount":9007199254740993,"frozen_days":1}],"url":"${TronWeb.fromUtf8('https://nested.invalid').slice(2)}"`,
    )
    assert.include(nested, '"frozen_amount":9007199254740993')
    assert.include(nested, `"order":${MAX}`)
    const ownerNested = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[4]!.privateKey,
    ) as string
    const accountNested = await postText('wallet/getaccount', {
      address: ownerNested,
      visible: true,
    })
    const idNested = /"asset_issued_ID":"(\d+)"/.exec(accountNested)?.[1] as string
    const queried = await postText('wallet/getassetissuebyid', { value: idNested })
    assert.include(queried, '"frozen_amount":9007199254740993')
    assert.include(queried, `"order":${MAX}`)
  })

  it('judges the tranche-expiry overflow at the exact signed-long boundary', async () => {
    const key = accountsFromMnemonic(config.mnemonic)[5]!.privateKey
    const owner = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string)
    const buildWith = async (startTime: string): Promise<string> =>
      postText(
        'wallet/createassetissue',
        `{"owner_address":"${owner}","name":"${TronWeb.fromUtf8('Edge').slice(2)}","abbr":"${TronWeb.fromUtf8('EG').slice(2)}","total_supply":1000,"trx_num":1,"num":1,"start_time":${startTime},"end_time":9223372036854775807,"frozen_supply":[{"frozen_amount":10,"frozen_days":1}],"url":"${TronWeb.fromUtf8('https://edge.invalid').slice(2)}"}`,
      )
    // start + one day lands exactly on Long.MAX: legal
    const exact = await buildWith('9223372036768375807')
    assert.notInclude(exact, 'expire time overflow')
    assert.include(exact, '"txID"')
    // one past it overflows
    assert.include(
      await buildWith('9223372036768375808'),
      'Start time and frozen days would cause expire time overflow',
    )
  })

  it('carries Permission_id on a built unfreezeasset', async () => {
    await advanceHead(3 * 86_400_000)
    const built = (await post('wallet/unfreezeasset', {
      owner_address: issuerBase58,
      Permission_id: 2,
      visible: true,
    })) as { raw_data?: { contract?: { Permission_id?: number }[] }; Error?: string }
    assert.isUndefined(built.Error, JSON.stringify(built).slice(0, 200))
    assert.strictEqual(built.raw_data?.contract?.[0]?.Permission_id, 2)
  })
})
