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

async function startPowerChain(unfreezeDelayDays: number): Promise<{
  config: ReturnType<typeof resolveConfig>
  node: TronNode
  server: Server
  owner: string
  web: TronWeb
  post: (path: string, body: unknown) => Promise<Record<string, unknown>>
}> {
  const config = resolveConfig({
    chainParameters: { allowNewResourceModel: 1, unfreezeDelayDays },
  })
  const owner = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
  const node = await createNode(config, new Clock())
  const started = await startHttpServer(new TronProvider(node), { port: 0 })
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`${started.url}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>
  return {
    config,
    node,
    server: started.server,
    owner,
    web: new TronWeb({
      fullHost: started.url,
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    }),
    post,
  }
}

describe('independent voting-power resource', () => {
  let chain: Awaited<ReturnType<typeof startPowerChain>>

  beforeAll(async () => {
    chain = await startPowerChain(14)
  })

  afterAll(() => {
    chain.server.close()
  })

  const settle = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const built = await chain.post(path, { owner_address: chain.owner, visible: true, ...body })
    const signed = await chain.web.trx.sign(built as never)
    return chain.post('wallet/broadcasttransaction', signed)
  }

  it('gates, freezes, unfreezes and restores Stake 2.0 voting power independently', async () => {
    const parameters = (await chain.post('wallet/getchainparameters', {})) as {
      chainParameter?: { key: string; value: number }[]
    }
    assert.deepInclude(parameters.chainParameter ?? [], {
      key: 'getAllowNewResourceModel',
      value: 1,
    })

    const froze = await settle('wallet/freezebalancev2', {
      frozen_balance: 7 * TRX,
      resource: 'TRON_POWER',
    })
    assert.isTrue(froze.result)
    const owner = parseTronAddress(chain.owner)
    assert.strictEqual(nodeCore(chain.node).frozenV2Of(owner).tronPower, 7_000_000n)
    assert.strictEqual(nodeCore(chain.node).totalTronPowerWeightTrx, 7n)
    assert.strictEqual(nodeCore(chain.node).totalNetWeightTrx, 0n)
    assert.strictEqual(nodeCore(chain.node).totalEnergyWeightTrx, 0n)

    const resources = (await chain.post('wallet/getaccountresource', {
      address: chain.owner,
      visible: true,
    })) as { tronPowerLimit?: number; TotalTronPowerWeight?: number }
    assert.strictEqual(resources.tronPowerLimit, 7)
    assert.strictEqual(resources.TotalTronPowerWeight, 7)

    const account = (await chain.post('wallet/getaccount', {
      address: chain.owner,
      visible: true,
    })) as {
      old_tron_power?: number
      frozenV2?: { type?: string; amount?: number }[]
    }
    assert.strictEqual(account.old_tron_power, -1)
    assert.deepInclude(account.frozenV2 ?? [], { type: 'TRON_POWER', amount: 7 * TRX })

    const unstaked = await settle('wallet/unfreezebalancev2', {
      unfreeze_balance: 7 * TRX,
      resource: 'TRON_POWER',
    })
    assert.isTrue(unstaked.result)
    assert.strictEqual(nodeCore(chain.node).totalTronPowerWeightTrx, 0n)

    const canceled = await settle('wallet/cancelallunfreezev2', {})
    assert.isTrue(canceled.result)
    assert.strictEqual(nodeCore(chain.node).frozenV2Of(owner).tronPower, 7_000_000n)
    assert.strictEqual(nodeCore(chain.node).totalTronPowerWeightTrx, 7n)
    const receipt = (await chain.post('wallet/gettransactioninfobyid', {
      value: canceled.txid,
    })) as {
      cancel_unfreezeV2_amount?: { key: string; value: number }[]
    }
    assert.deepInclude(receipt.cancel_unfreezeV2_amount ?? [], {
      key: 'TRON_POWER',
      value: 7 * TRX,
    })
  })
})

describe('legacy voting-power resource', () => {
  let chain: Awaited<ReturnType<typeof startPowerChain>>

  beforeAll(async () => {
    chain = await startPowerChain(0)
  })

  afterAll(() => {
    chain.server.close()
  })

  it('uses the V1 storage slot and rejects delegation', async () => {
    const built = await chain.post('wallet/freezebalance', {
      owner_address: chain.owner,
      frozen_balance: 4 * TRX,
      frozen_duration: 3,
      resource: 'TRON_POWER',
      visible: true,
    })
    const frozen = await chain.post(
      'wallet/broadcasttransaction',
      await chain.web.trx.sign(built as never),
    )
    assert.isTrue(frozen.result)

    const owner = parseTronAddress(chain.owner)
    assert.strictEqual(nodeCore(chain.node).legacyFrozenOf(owner).tronPower?.amount, 4_000_000n)
    assert.strictEqual(nodeCore(chain.node).totalTronPowerWeightTrx, 4n)
    const resources = (await chain.post('wallet/getaccountresource', {
      address: chain.owner,
      visible: true,
    })) as { tronPowerLimit?: number; TotalTronPowerWeight?: number }
    assert.strictEqual(resources.tronPowerLimit, 4)
    assert.strictEqual(resources.TotalTronPowerWeight, 4)
    const account = (await chain.post('wallet/getaccount', {
      address: chain.owner,
      visible: true,
    })) as {
      old_tron_power?: number
      tron_power?: { frozen_balance?: number; expire_time?: number }
    }
    assert.strictEqual(account.old_tron_power, -1)
    assert.strictEqual(account.tron_power?.frozen_balance, 4 * TRX)
    assert.isDefined(account.tron_power?.expire_time)

    const refused = await chain.post('wallet/freezebalance', {
      owner_address: chain.owner,
      frozen_balance: TRX,
      frozen_duration: 3,
      resource: 'TRON_POWER',
      receiver_address: TronWeb.address.fromPrivateKey(
        accountsFromMnemonic(chain.config.mnemonic)[1]!.privateKey,
      ),
      visible: true,
    })
    assert.strictEqual(refused.Error, 'TRON_POWER is not allowed to delegate to other accounts.')

    await chain.node.tre.increaseTime(3 * 86_400 + 3)
    const unstakeBuilt = await chain.post('wallet/unfreezebalance', {
      owner_address: chain.owner,
      resource: 'TRON_POWER',
      visible: true,
    })
    const unfrozen = await chain.post(
      'wallet/broadcasttransaction',
      await chain.web.trx.sign(unstakeBuilt as never),
    )
    assert.isTrue(unfrozen.result)
    assert.strictEqual(nodeCore(chain.node).totalTronPowerWeightTrx, 0n)
  })
})
