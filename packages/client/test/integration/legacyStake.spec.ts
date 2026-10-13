import { TronWeb } from 'tronweb'
import { assert, afterAll, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import type { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

import type { Server } from 'node:http'

const TRX = 1_000_000
const DAY_MS = 86_400_000
const actuatorMessage = (value: unknown): string => String(value ?? '')

describe('Stake 1.0 lifecycle before the Stake 2.0 proposal', () => {
  const config = resolveConfig({
    chainParameters: { unfreezeDelayDays: 0 },
  })
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

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>

  const settle = async (tx: unknown): Promise<Record<string, unknown>> => {
    const signed = await tronWeb.trx.sign(tx as never)
    return post('wallet/broadcasttransaction', signed)
  }

  it('keeps local and delegated freezes, their queries and expiry on one state path', async () => {
    const local = await settle(
      await tronWeb.transactionBuilder.freezeBalance(10 * TRX, 3, 'BANDWIDTH', ownerBase58),
    )
    assert.isTrue(local.result)
    const localExpiry = nodeCore(node).legacyFrozenOf(owner).bandwidth?.expireMs
    assert.isDefined(localExpiry)
    const delegated = await settle(
      await tronWeb.transactionBuilder.freezeBalance(
        20 * TRX,
        3,
        'ENERGY',
        ownerBase58,
        peerBase58,
      ),
    )
    assert.isTrue(delegated.result)

    assert.deepEqual(nodeCore(node).legacyFrozenOf(owner), {
      bandwidth: { amount: 10_000_000n, expireMs: localExpiry },
    })
    assert.deepEqual(nodeCore(node).legacyDelegatedOutOf(owner), {
      bandwidth: 0n,
      energy: 20_000_000n,
    })
    assert.deepEqual(nodeCore(node).legacyAcquiredDelegatedOf(peer), {
      bandwidth: 0n,
      energy: 20_000_000n,
    })
    assert.strictEqual(nodeCore(node).totalNetWeightTrx, 10n)
    assert.strictEqual(nodeCore(node).totalEnergyWeightTrx, 20n)

    // A frozen-supply entry makes the top-level ordering observable: `frozen`
    // is field 7, while `frozen_supply` is field 16.
    await nodeCore(node).issueAsset(
      owner,
      {
        name: 'key-order',
        abbr: 'KO',
        totalSupply: 1n,
        trxNum: 1,
        precision: 0,
        num: 1,
        startTime: 1n,
        endTime: 2n,
        order: 0n,
        voteScore: 0,
        description: '',
        url: '',
        freeAssetNetLimit: 0,
        publicFreeAssetNetLimit: 0,
        publicFreeAssetNetUsage: 0,
        publicLatestFreeNetTime: 0,
      },
      0n,
      [{ frozenBalance: 1n, expireTime: 1n }],
    )

    const account = (await post('wallet/getaccount', { address: ownerBase58, visible: true })) as {
      frozen?: { frozen_balance: number; expire_time: number }[]
      account_resource?: { delegated_frozen_balance_for_energy?: number }
    }
    const accountKeys = Object.keys(account)
    assert.isBelow(accountKeys.indexOf('frozen'), accountKeys.indexOf('frozen_supply'))
    // the resource window is only resized on the path the cancel-unfreeze
    // proposal opens, so this chain carries none of its four fields
    assert.deepEqual(Object.keys(account.account_resource ?? {}), [
      'delegated_frozen_balance_for_energy',
    ])
    assert.deepEqual(
      account.frozen?.map(({ frozen_balance }) => frozen_balance),
      [10 * TRX],
    )
    assert.strictEqual(account.account_resource?.delegated_frozen_balance_for_energy, 20 * TRX)

    const stored = (await post('wallet/getdelegatedresource', {
      fromAddress: ownerBase58,
      toAddress: peerBase58,
      visible: true,
    })) as {
      delegatedResource?: {
        frozen_balance_for_energy?: number
        expire_time_for_energy?: number
      }[]
    }
    assert.deepEqual(
      stored.delegatedResource?.map((entry) => entry.frozen_balance_for_energy),
      [20 * TRX],
    )
    assert.strictEqual(
      stored.delegatedResource?.[0]?.expire_time_for_energy,
      nodeCore(node).legacyDelegationOf(
        TronWeb.address.toHex(ownerBase58).slice(2).toLowerCase(),
        TronWeb.address.toHex(peerBase58).slice(2).toLowerCase(),
      )?.expireEnergyMs,
    )
    assert.deepEqual(
      await post('walletsolidity/getdelegatedresource', {
        fromAddress: ownerBase58,
        toAddress: peerBase58,
        visible: true,
      }),
      stored,
    )

    const index = (await post('wallet/getdelegatedresourceaccountindex', {
      value: ownerBase58,
      visible: true,
    })) as { account?: string; toAccounts?: string[] }
    assert.strictEqual(index.account, ownerBase58)
    assert.deepEqual(index.toAccounts, [peerBase58])
    assert.deepEqual(
      await post('walletsolidity/getdelegatedresourceaccountindex', {
        value: ownerBase58,
        visible: true,
      }),
      index,
    )

    const early = await post('wallet/unfreezebalance', {
      owner_address: ownerBase58,
      resource: 'BANDWIDTH',
      visible: true,
    })
    assert.strictEqual(actuatorMessage(early.Error), "It's not time to unfreeze(BANDWIDTH).")

    await node.tre.increaseTime((3 * DAY_MS) / 1000 + 3)
    const unfrozeLocal = await settle(
      await tronWeb.transactionBuilder.unfreezeBalance('BANDWIDTH', ownerBase58),
    )
    assert.isTrue(unfrozeLocal.result)
    const localInfo = (await post('wallet/gettransactioninfobyid', {
      value: unfrozeLocal.txid,
    })) as {
      unfreeze_amount?: number
    }
    assert.strictEqual(localInfo.unfreeze_amount, 10 * TRX)

    const unfrozeDelegated = await settle(
      await tronWeb.transactionBuilder.unfreezeBalance('ENERGY', ownerBase58, peerBase58),
    )
    assert.isTrue(unfrozeDelegated.result)
    assert.deepEqual(nodeCore(node).legacyAcquiredDelegatedOf(peer), { bandwidth: 0n, energy: 0n })
    assert.deepEqual(
      await post('wallet/getdelegatedresource', {
        fromAddress: ownerBase58,
        toAddress: peerBase58,
        visible: true,
      }),
      {},
    )
    assert.deepEqual(
      await post('wallet/getdelegatedresourceaccountindex', { value: ownerBase58, visible: true }),
      { account: ownerBase58 },
    )
    assert.deepEqual(
      await post('wallet/getdelegatedresourceaccountindexv2', {
        value: ownerBase58,
        visible: true,
      }),
      { account: ownerBase58 },
    )
  })

  it('uses the local or receiver legacy balance for each whole-TRX weight transition', async () => {
    const isolated = await createNode(config, new Clock())
    await nodeCore(isolated).freezeLegacy(owner, 1_500_000n, 'BANDWIDTH', 3)
    assert.strictEqual(nodeCore(isolated).totalNetWeightTrx, 1n)

    await nodeCore(isolated).freezeLegacy(owner, 1_500_000n, 'BANDWIDTH', 3, peer)
    assert.strictEqual(nodeCore(isolated).totalNetWeightTrx, 2n)

    await nodeCore(isolated).unfreezeLegacy(owner, 'BANDWIDTH', peer)
    assert.strictEqual(nodeCore(isolated).totalNetWeightTrx, 1n)

    await nodeCore(isolated).unfreezeLegacy(owner, 'BANDWIDTH')
    assert.strictEqual(nodeCore(isolated).totalNetWeightTrx, 0n)
  })
})

describe('Stake 1.0 fixed protocol capabilities', () => {
  const config = resolveConfig({
    chainParameters: {
      unfreezeDelayDays: 0,
      minFrozenTime: 2,
      maxFrozenTime: 4,
    },
  })
  const ownerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
  let node: TronNode
  let server: Server
  let baseUrl = ''

  beforeAll(async () => {
    node = await createNode(config, new Clock())
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
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

  it('reports its fixed values alongside configurable legacy rules', async () => {
    const params = (await post('wallet/getchainparameters', {})).chainParameter as {
      key: string
      value?: number
    }[]
    assert.deepEqual(
      params.find((entry) => entry.key === 'getAllowTvmConstantinople'),
      {
        key: 'getAllowTvmConstantinople',
        value: 1,
      },
    )
    assert.deepEqual(
      params.find((entry) => entry.key === 'getAllowTvmSolidity059'),
      {
        key: 'getAllowTvmSolidity059',
        value: 1,
      },
    )
    // Protobuf omits a zero-valued int64 but preserves the parameter key.
    assert.deepEqual(
      params.find((entry) => entry.key === 'getAllowTvmCompatibleEvm'),
      { key: 'getAllowTvmCompatibleEvm' },
    )

    assert.strictEqual(
      actuatorMessage(
        (
          await post('wallet/freezebalance', {
            owner_address: ownerBase58,
            frozen_balance: TRX,
            frozen_duration: 1,
            resource: 'BANDWIDTH',
            visible: true,
          })
        ).Error,
      ),
      'frozenDuration must be less than 4 days and more than 2 days',
    )
    assert.isUndefined(
      (
        await post('wallet/freezebalance', {
          owner_address: ownerBase58,
          frozen_balance: TRX,
          frozen_duration: 4,
          resource: 'BANDWIDTH',
          visible: true,
        })
      ).Error,
    )
  })
})
