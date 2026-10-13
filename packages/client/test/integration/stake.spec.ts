import { bytesToHex } from '@tvmjs/util'
import { TronWeb } from 'tronweb'
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

const DAY_MS = 86_400_000
const TRX = 1_000_000

const INC_RUNTIME = '6000546001018060005560005260206000f3'
const INC_INITCODE = `601280600b6000396000f3${INC_RUNTIME}`

describe('program delegation queries', () => {
  it('accepts address forms for both delegation versions and their account indexes', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const [owner, peer] = privateKeys.map((key) => TronWeb.address.fromPrivateKey(key) as string)
    await node.tre.unlockedAccounts([owner])
    for (const request of [
      {
        method: 'wallet/freezebalancev2',
        params: { owner_address: owner, frozen_balance: 2_000_000, resource: 'ENERGY' },
      },
      {
        method: 'wallet/delegateresource',
        params: {
          owner_address: owner,
          receiver_address: peer,
          balance: 1_000_000,
          resource: 'ENERGY',
        },
      },
    ]) {
      const transaction = await provider.request(request)
      assert.isObject(transaction)
      const sent = await provider.request({
        method: 'wallet/broadcasttransaction',
        params: transaction as Record<string, unknown>,
      })
      assert.isTrue(sent.result)
    }
    const ownerHex = TronWeb.address.toHex(owner)
    const peerHex = TronWeb.address.toHex(peer)
    for (const prefix of ['wallet', 'walletsolidity']) {
      for (const suffix of ['', 'v2']) {
        const method = `${prefix}/getdelegatedresource${suffix}`
        for (const visible of [false, true]) {
          for (const [fromAddress, toAddress] of [
            [owner, peer],
            [ownerHex, peerHex],
            [`0x${ownerHex.slice(2)}`, `0x${peerHex.slice(2)}`],
            [owner, peerHex],
          ]) {
            const params = { fromAddress, toAddress, visible }
            assert.deepEqual(
              await provider.request({ method, params }),
              suffix === ''
                ? {}
                : {
                    delegatedResource: [
                      {
                        from: visible ? owner : ownerHex,
                        to: visible ? peer : peerHex,
                        frozen_balance_for_energy: 1_000_000n,
                      },
                    ],
                  },
            )
            assert.deepEqual(params, { fromAddress, toAddress, visible })
          }
        }
        const indexMethod = `${prefix}/getdelegatedresourceaccountindex${suffix}`
        const expected = await provider.request({
          method: indexMethod,
          params: { value: ownerHex },
        })
        for (const value of [owner, `0x${ownerHex.slice(2)}`]) {
          assert.deepEqual(
            await provider.request({ method: indexMethod, params: { value } }),
            expected,
          )
        }
      }
    }
  })
})

/**
 * Stake 2.0 over the local clock: maturity windows, lock expiry and the
 * settlement they gate live here — the differential net covers the same
 * operations but cannot wait fourteen days.
 */
describe('Stake 2.0 lifecycle', () => {
  const config = resolveConfig()
  const ownerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
  const owner = parseTronAddress(ownerBase58)
  const peerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[1].privateKey,
  ) as string
  const peer = parseTronAddress(peerBase58)
  const clock = new Clock()
  let node: TronNode
  let server: Server
  let tronWeb: TronWeb
  let peerWeb: TronWeb
  let baseUrl = ''

  beforeAll(async () => {
    node = await createNode(config, clock)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    tronWeb = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    })
    peerWeb = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[1].privateKey,
    })
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

  const settle = async (web: TronWeb, tx: unknown): Promise<Record<string, unknown>> => {
    const signed = await web.trx.sign(tx as never)
    const reply = (await post('wallet/broadcasttransaction', signed)) as {
      result?: boolean
      txid?: string
    }
    if (reply.result !== true) return { broadcast: reply }
    return {
      broadcast: reply,
      info: await post('wallet/gettransactioninfobyid', { value: reply.txid }),
    }
  }

  it('freezing conserves the balance and buys the whole grid for the first staker', async () => {
    const balanceBefore = await tronWeb.trx.getBalance(ownerBase58)

    const frozeEnergy = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.freezeBalanceV2(3_000 * TRX, 'ENERGY', ownerBase58),
    )
    assert.isTrue((frozeEnergy.broadcast as { result?: boolean }).result)
    const frozeBandwidth = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.freezeBalanceV2(2_000 * TRX, 'BANDWIDTH', ownerBase58),
    )
    assert.isTrue((frozeBandwidth.broadcast as { result?: boolean }).result)

    // freezing moves the balance, it does not spend it
    assert.strictEqual(await tronWeb.trx.getBalance(ownerBase58), balanceBefore - 5_000 * TRX)
    assert.deepEqual(nodeCore(node).frozenV2Of(owner), {
      bandwidth: BigInt(2_000 * TRX),
      energy: BigInt(3_000 * TRX),
      tronPower: 0n,
    })
    assert.strictEqual(nodeCore(node).totalNetWeightTrx, 2_000n)
    assert.strictEqual(nodeCore(node).totalEnergyWeightTrx, 3_000n)

    // the only staker holds the entire grid
    const resource = (await post('wallet/getaccountresource', {
      address: ownerBase58,
      visible: true,
    })) as {
      NetLimit?: number
      EnergyLimit?: number
      tronPowerLimit?: number
      TotalNetWeight?: number
      TotalEnergyWeight?: number
    }
    assert.strictEqual(resource.NetLimit, config.chainParameters.totalNetLimit)
    assert.strictEqual(resource.EnergyLimit, config.chainParameters.totalEnergyCurrentLimit)
    assert.strictEqual(resource.tronPowerLimit, 5_000)
    assert.strictEqual(resource.TotalNetWeight, 2_000)
    assert.strictEqual(resource.TotalEnergyWeight, 3_000)
  })

  it('staked bandwidth is consumed ahead of the free allowance', async () => {
    // the free ledger is read raw: a decayed reading recovers between the two
    // samples, so equal readings would not mean an untouched ledger
    const freeLedger = (): string =>
      JSON.stringify(
        nodeCore(node)
          .accountRecordEntries()
          .find(([key]) => key === bytesToHex(owner.bytes).slice(2))?.[1]?.bandwidth ?? null,
      )
    const freeBefore = freeLedger()
    const sent = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.sendTrx(peerBase58, 1_000, ownerBase58),
    )
    assert.isTrue((sent.broadcast as { result?: boolean }).result)
    const info = sent.info as { receipt?: { net_usage?: number; net_fee?: number } }
    assert.isAbove(info.receipt?.net_usage ?? 0, 0)
    assert.isUndefined(info.receipt?.net_fee)
    // the free ledger did not move: the staked quota answered first
    assert.strictEqual(freeLedger(), freeBefore)
    assert.isAbove(nodeCore(node).stakedNetUsedOf(owner), 0)
  })

  it('staked energy pays for execution without burning a sun', async () => {
    const balanceBefore = await tronWeb.trx.getBalance(ownerBase58)
    const deployed = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.createSmartContract(
        {
          abi: [],
          bytecode: INC_INITCODE,
          feeLimit: 1_000 * TRX,
          callValue: 0,
          userFeePercentage: 100,
          originEnergyLimit: 10_000_000,
          name: 'Staked',
        } as never,
        ownerBase58,
      ),
    )
    const info = deployed.info as {
      fee?: number
      receipt?: { energy_usage?: number; energy_fee?: number; energy_usage_total?: number }
    }
    assert.isAbove(info.receipt?.energy_usage ?? 0, 0)
    assert.isUndefined(info.receipt?.energy_fee)
    assert.strictEqual(info.receipt?.energy_usage, info.receipt?.energy_usage_total)
    assert.isUndefined(info.fee)
    // the whole bill came from the stake
    assert.strictEqual(await tronWeb.trx.getBalance(ownerBase58), balanceBefore)
    assert.isAbove(nodeCore(node).stakedEnergyUsedOf(owner), 0)
  })

  it('delegation moves quota to the receiver and usage travels back on undelegate', async () => {
    const granted = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.delegateResource(
        1_000 * TRX,
        peerBase58,
        'BANDWIDTH',
        ownerBase58,
        false,
      ),
    )
    assert.isTrue((granted.broadcast as { result?: boolean }).result)
    assert.deepEqual(nodeCore(node).acquiredDelegatedOf(peer), {
      bandwidth: BigInt(1_000 * TRX),
      energy: 0n,
    })
    // the weight travelled with the delegation, so the total sat still
    assert.strictEqual(nodeCore(node).totalNetWeightTrx, 2_000n)
    assert.strictEqual(
      nodeCore(node).stakedNetLimitOf(peer),
      BigInt(config.chainParameters.totalNetLimit / 2),
    )

    // the receiver spends the delegated quota
    const spent = await settle(
      peerWeb,
      await peerWeb.transactionBuilder.sendTrx(ownerBase58, 1_000, peerBase58),
    )
    assert.isTrue((spent.broadcast as { result?: boolean }).result)
    const receiverUsed = nodeCore(node).stakedNetUsedOf(peer)
    assert.isAbove(receiverUsed, 0)

    // taking the whole delegation back carries the receiver's usage along
    const ownerUsedBefore = nodeCore(node).stakedNetUsedOf(owner)
    const revoked = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.undelegateResource(
        1_000 * TRX,
        peerBase58,
        'BANDWIDTH',
        ownerBase58,
      ),
    )
    assert.isTrue((revoked.broadcast as { result?: boolean }).result)
    assert.deepEqual(nodeCore(node).acquiredDelegatedOf(peer), { bandwidth: 0n, energy: 0n })
    assert.strictEqual(nodeCore(node).stakedNetUsedOf(peer), 0)
    assert.isAbove(nodeCore(node).stakedNetUsedOf(owner), ownerUsedBefore)
    // the pair left the index with its last entry
    assert.deepEqual(nodeCore(node).delegationPairKeys(), [])
  })

  it('a locked delegation refuses early undelegation and unlocks by head time', async () => {
    const locked = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.delegateResource(
        500 * TRX,
        peerBase58,
        'ENERGY',
        ownerBase58,
        true,
      ),
    )
    assert.isTrue((locked.broadcast as { result?: boolean }).result)

    const early = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.undelegateResource(
        500 * TRX,
        peerBase58,
        'ENERGY',
        ownerBase58,
      ),
    )
    const message = TronWeb.toUtf8(String((early.broadcast as { message?: string }).message ?? ''))
    assert.include(message, 'insufficient delegateFrozenBalance(Energy)')

    // the default lock runs 86400 blocks of three seconds
    await node.tre.increaseTime((86_400 * 3_000) / 1000 + 3)
    const late = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.undelegateResource(
        500 * TRX,
        peerBase58,
        'ENERGY',
        ownerBase58,
      ),
    )
    assert.isTrue((late.broadcast as { result?: boolean }).result)
  })

  it('unstaking matures by head time: withdraw refuses early and settles late', async () => {
    const unfroze = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.unfreezeBalanceV2(600 * TRX, 'ENERGY', ownerBase58),
    )
    assert.isTrue((unfroze.broadcast as { result?: boolean }).result)
    assert.strictEqual(nodeCore(node).frozenV2Of(owner).energy, BigInt(2_400 * TRX))
    assert.strictEqual(nodeCore(node).totalEnergyWeightTrx, 2_400n)

    const count = (await post('wallet/getavailableunfreezecount', {
      owner_address: ownerBase58,
      visible: true,
    })) as { count?: number }
    assert.strictEqual(count.count, 31)
    assert.deepEqual(
      await post('walletsolidity/getavailableunfreezecount', {
        owner_address: ownerBase58,
        visible: true,
      }),
      count,
    )

    const early = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.withdrawExpireUnfreeze(ownerBase58),
    )
    assert.strictEqual(
      TronWeb.toUtf8(String((early.broadcast as { message?: string }).message ?? '')),
      'Contract validate error : no unFreeze balance to withdraw ',
    )

    await node.tre.increaseTime((config.chainParameters.unfreezeDelayDays * DAY_MS) / 1000 + 3)
    const withdrawable = (await post('wallet/getcanwithdrawunfreezeamount', {
      owner_address: ownerBase58,
      visible: true,
    })) as { amount?: number }
    assert.strictEqual(withdrawable.amount, 600 * TRX)
    assert.deepEqual(
      await post('walletsolidity/getcanwithdrawunfreezeamount', {
        owner_address: ownerBase58,
        visible: true,
      }),
      withdrawable,
    )

    const balanceBefore = await tronWeb.trx.getBalance(ownerBase58)
    const settled = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.withdrawExpireUnfreeze(ownerBase58),
    )
    assert.isTrue((settled.broadcast as { result?: boolean }).result)
    assert.strictEqual(
      (settled.info as { withdraw_expire_amount?: number }).withdraw_expire_amount,
      600 * TRX,
    )
    assert.strictEqual(await tronWeb.trx.getBalance(ownerBase58), balanceBefore + 600 * TRX)
    assert.deepEqual(nodeCore(node).unfrozenV2Of(owner), [])
  })

  it('cancelling pending unstakes settles the matured and refreezes the rest', async () => {
    const first = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.unfreezeBalanceV2(100 * TRX, 'ENERGY', ownerBase58),
    )
    assert.isTrue((first.broadcast as { result?: boolean }).result)
    await node.tre.increaseTime((config.chainParameters.unfreezeDelayDays * DAY_MS) / 1000 + 3)
    const second = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.unfreezeBalanceV2(200 * TRX, 'BANDWIDTH', ownerBase58),
    )
    // starting another unstake settles the matured one on the way
    assert.strictEqual(
      (second.info as { withdraw_expire_amount?: number }).withdraw_expire_amount,
      100 * TRX,
    )

    const frozenBefore = nodeCore(node).frozenV2Of(owner)
    const balanceBefore = await tronWeb.trx.getBalance(ownerBase58)
    const cancelled = await settle(
      tronWeb,
      (await post('wallet/cancelallunfreezev2', {
        owner_address: ownerBase58,
        visible: true,
      })) as never,
    )
    assert.isTrue((cancelled.broadcast as { result?: boolean }).result)
    const info = cancelled.info as {
      withdraw_expire_amount?: number
      cancel_unfreezeV2_amount?: { key: string; value: number }[]
    }
    // nothing matured since the second unstake, so everything refreezes
    assert.isUndefined(info.withdraw_expire_amount)
    assert.deepEqual(info.cancel_unfreezeV2_amount, [
      { key: 'ENERGY', value: 0 },
      { key: 'TRON_POWER', value: 0 },
      { key: 'BANDWIDTH', value: 200 * TRX },
    ])
    assert.strictEqual(await tronWeb.trx.getBalance(ownerBase58), balanceBefore)
    assert.deepEqual(nodeCore(node).frozenV2Of(owner), {
      bandwidth: frozenBefore.bandwidth + BigInt(200 * TRX),
      energy: frozenBefore.energy,
      tronPower: frozenBefore.tronPower,
    })
    assert.deepEqual(nodeCore(node).unfrozenV2Of(owner), [])
  })

  it('a fault after the stake write takes weights and ledgers back with everything else', async () => {
    const before = await probeState(node)
    const original = nodeCore(node).sealBlock.bind(nodeCore(node))
    nodeCore(node).sealBlock = async () => {
      throw new Error('seal store is down')
    }
    const failed = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.freezeBalanceV2(50 * TRX, 'ENERGY', ownerBase58),
    )
    nodeCore(node).sealBlock = original
    assert.isDefined((failed.broadcast as { Error?: string }).Error)
    assert.deepEqual(await probeState(node), before)

    const retried = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.freezeBalanceV2(50 * TRX, 'ENERGY', ownerBase58),
    )
    assert.isTrue((retried.broadcast as { result?: boolean }).result)
    assert.notDeepEqual(await probeState(node), before)
  })

  it('stake rejections leave no trace anywhere', async () => {
    const attempts: [string, Record<string, unknown>][] = [
      [
        'wallet/freezebalancev2',
        { owner_address: ownerBase58, frozen_balance: 1, resource: 'ENERGY', visible: true },
      ],
      [
        'wallet/unfreezebalancev2',
        { owner_address: peerBase58, unfreeze_balance: TRX, resource: 'ENERGY', visible: true },
      ],
      [
        'wallet/delegateresource',
        {
          owner_address: peerBase58,
          receiver_address: ownerBase58,
          balance: TRX,
          resource: 'ENERGY',
          visible: true,
        },
      ],
      ['wallet/withdrawexpireunfreeze', { owner_address: ownerBase58, visible: true }],
      ['wallet/cancelallunfreezev2', { owner_address: peerBase58, visible: true }],
    ]
    // each actuator words its own refusal, and the wording is the contract
    const refusals: Record<string, string> = {
      'wallet/freezebalancev2': 'frozenBalance must be greater than or equal to 1 TRX',
      'wallet/unfreezebalancev2': 'no frozenBalance(Energy)',
      'wallet/delegateresource':
        'delegateBalance must be less than or equal to available FreezeEnergyV2 balance',
      'wallet/withdrawexpireunfreeze': 'no unFreeze balance to withdraw ',
      'wallet/cancelallunfreezev2': 'No unfreezeV2 list to cancel',
    }
    for (const [path, body] of attempts) {
      const before = await probeState(node)
      const reply = await post(path, body)
      assert.strictEqual(reply.Error, refusals[path as string], path)
      assert.deepEqual(await probeState(node), before, path)
    }
  })

  it('answers the delegation index for a visible Base58 POST', async () => {
    const to = peerBase58
    const delegated = await settle(
      tronWeb,
      await tronWeb.transactionBuilder.delegateResource(10 * TRX, to, 'BANDWIDTH', ownerBase58),
    )
    assert.isTrue((delegated.broadcast as { result?: boolean }).result)
    const index = (await post('wallet/getdelegatedresourceaccountindexv2', {
      value: ownerBase58,
      visible: true,
    })) as { account?: string; toAccounts?: string[] }
    assert.strictEqual(index.account, ownerBase58)
    assert.include(index.toAccounts ?? [], to)
    assert.deepEqual(
      await post('walletsolidity/getdelegatedresourceaccountindexv2', {
        value: ownerBase58,
        visible: true,
      }),
      index,
    )
  })

  it('keeps real frozenV2 holdings in the id lookup', async () => {
    const built = (await post('wallet/setaccountid', {
      owner_address: TronWeb.address.toHex(ownerBase58),
      account_id: TronWeb.fromUtf8('staked-holder').replace(/^0x/, ''),
    })) as Record<string, unknown>
    assert.isUndefined(built.Error)
    const applied = await settle(tronWeb, built)
    assert.isTrue((applied.broadcast as { result?: boolean }).result)
    const byId = (await post('wallet/getaccountbyid', {
      account_id: 'staked-holder',
      visible: true,
    })) as { frozenV2?: { type?: string; amount?: number }[] }
    // the id lookup skips zero-slot padding, not the actual stake
    assert.isDefined(byId.frozenV2)
    // The id lookup returns the stored repeated field; unlike getaccount it
    // does not synthesize the zero-valued resource entries. This account froze
    // energy first and bandwidth second.
    assert.deepEqual(
      (byId.frozenV2 ?? []).map((slot) => slot.type),
      ['ENERGY', undefined],
    )
    assert.isAbove(
      (byId.frozenV2 ?? []).reduce((sum, slot) => sum + (slot.amount ?? 0), 0),
      0,
    )
  })
})

/**
 * int64 stake amounts above 2^53 over the wire. The assertions read the raw
 * response text: parsing it in JavaScript would round the same digits the
 * printer is being held to.
 */
describe('Stake 2.0 int64 amounts past the double range', () => {
  // 2^53 + 1 sun: the smallest int64 a JavaScript number cannot state
  const BIG = 9_007_199_254_740_993n
  const config = resolveConfig()
  config.mnemonic.count = 3
  config.mnemonic.balance = 100_000_000_000_000_000n
  const ownerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
  const owner = parseTronAddress(ownerBase58)
  const peerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[1].privateKey,
  ) as string
  const peer = parseTronAddress(peerBase58)
  // a staker of its own, so the ceiling it reports is its whole stake
  const stakerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[2].privateKey,
  ) as string
  const staker = parseTronAddress(stakerBase58)
  const clock = new Clock()
  let node: TronNode
  let server: Server
  let tronWeb: TronWeb
  let baseUrl = ''

  beforeAll(async () => {
    node = await createNode(config, clock)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    tronWeb = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    })
  })

  afterAll(() => {
    server.close()
  })

  const rawPost = async (path: string, body: unknown): Promise<string> =>
    (
      await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).text()

  it('prints a delegation of 2^53+1 sun to the last digit', async () => {
    await nodeCore(node).freezeV2(owner, BIG, 'ENERGY')
    await nodeCore(node).delegateResource(owner, peer, BIG, 'ENERGY', false, 0)

    const listed = await rawPost('wallet/getdelegatedresourcev2', {
      fromAddress: ownerBase58,
      toAddress: peerBase58,
      visible: true,
    })
    assert.include(listed, `"frozen_balance_for_energy":${BIG}`)
    const solidityListed = await rawPost('walletsolidity/getdelegatedresourcev2', {
      fromAddress: ownerBase58,
      toAddress: peerBase58,
      visible: true,
    })
    assert.strictEqual(solidityListed, listed)

    // the string form is asked for on the query string, and only on a GET
    const asString = await (
      await fetch(
        `${baseUrl}/wallet/getdelegatedresourcev2?fromAddress=${ownerBase58}&toAddress=${peerBase58}&visible=true&int64_as_string=true`,
      )
    ).text()
    assert.include(asString, `"frozen_balance_for_energy":"${BIG}"`)
  })

  it('prints the delegatable ceiling to the last digit', async () => {
    await nodeCore(node).freezeV2(staker, BIG, 'ENERGY')
    const ceiling = await rawPost('wallet/getcandelegatedmaxsize', {
      owner_address: stakerBase58,
      type: 1,
      visible: true,
    })
    assert.include(ceiling, `"max_size":${BIG}`)
    assert.strictEqual(
      await rawPost('walletsolidity/getcandelegatedmaxsize', {
        owner_address: stakerBase58,
        type: 1,
        visible: true,
      }),
      ceiling,
    )
  })

  it('prints the withdrawable amount and its receipt to the last digit', async () => {
    await nodeCore(node).freezeV2(owner, BIG, 'BANDWIDTH')
    await nodeCore(node).unfreezeV2(owner, BIG, 'BANDWIDTH')
    await node.tre.increaseTime((config.chainParameters.unfreezeDelayDays * DAY_MS) / 1000 + 3)

    const withdrawable = await rawPost('wallet/getcanwithdrawunfreezeamount', {
      owner_address: ownerBase58,
      visible: true,
    })
    assert.include(withdrawable, `"amount":${BIG}`)

    const built = JSON.parse(
      await rawPost('wallet/withdrawexpireunfreeze', {
        owner_address: ownerBase58,
        visible: true,
      }),
    ) as Record<string, unknown>
    const signed = await tronWeb.trx.sign(built as never)
    const reply = JSON.parse(await rawPost('wallet/broadcasttransaction', signed)) as {
      result?: boolean
      txid?: string
    }
    assert.isTrue(reply.result)
    const info = await rawPost('wallet/gettransactioninfobyid', { value: reply.txid })
    assert.include(info, `"withdraw_expire_amount":${BIG}`)
  })

  it('prints the amount a fresh unstake settles on its way', async () => {
    const peerWeb = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[1].privateKey,
    })
    await nodeCore(node).freezeV2(peer, BIG, 'BANDWIDTH')
    await nodeCore(node).unfreezeV2(peer, BIG, 'BANDWIDTH')
    await node.tre.increaseTime((config.chainParameters.unfreezeDelayDays * DAY_MS) / 1000 + 3)
    await nodeCore(node).freezeV2(peer, 1_000_000n, 'BANDWIDTH')

    const built = JSON.parse(
      await rawPost('wallet/unfreezebalancev2', {
        owner_address: peerBase58,
        unfreeze_balance: 1_000_000,
        resource: 'BANDWIDTH',
        visible: true,
      }),
    ) as Record<string, unknown>
    const signed = await peerWeb.trx.sign(built as never)
    const reply = JSON.parse(await rawPost('wallet/broadcasttransaction', signed)) as {
      result?: boolean
      txid?: string
    }
    assert.isTrue(reply.result)
    // the matured unstake settles as this one is started, and its receipt says so
    const info = await rawPost('wallet/gettransactioninfobyid', { value: reply.txid })
    assert.include(info, `"withdraw_expire_amount":${BIG}`)
  })

  it('prints a cancelled unstake amount to the last digit', async () => {
    await nodeCore(node).freezeV2(owner, BIG, 'ENERGY')
    await nodeCore(node).unfreezeV2(owner, BIG, 'ENERGY')

    const built = JSON.parse(
      await rawPost('wallet/cancelallunfreezev2', {
        owner_address: ownerBase58,
        visible: true,
      }),
    ) as Record<string, unknown>
    const signed = await tronWeb.trx.sign(built as never)
    const reply = JSON.parse(await rawPost('wallet/broadcasttransaction', signed)) as {
      result?: boolean
      txid?: string
    }
    assert.isTrue(reply.result)
    const info = await rawPost('wallet/gettransactioninfobyid', { value: reply.txid })
    assert.include(info, `{"key":"ENERGY","value":${BIG}}`)
  })
})
