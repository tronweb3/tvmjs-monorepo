import { assert, afterAll, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import type { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

import type { Server } from 'node:http'

describe('asset pagination ordering', () => {
  const config = resolveConfig()
  const owner = parseTronAddress(`41${'11'.repeat(20)}`)
  const secondOwner = parseTronAddress(`41${'22'.repeat(20)}`)
  let node: TronNode
  let server: Server
  let baseUrl = ''

  beforeAll(async () => {
    node = await createNode(config, new Clock())
    await nodeCore(node).setBalance(owner, 1n)
    await nodeCore(node).setBalance(secondOwner, 1n)
    const input = (order: bigint) => ({
      name: 'same-name',
      abbr: 'S',
      totalSupply: 100n,
      trxNum: 1,
      num: 1,
      precision: 0,
      startTime: 1n,
      endTime: 2n,
      order,
      voteScore: 0,
      description: '',
      url: '',
      freeAssetNetLimit: 0,
      publicFreeAssetNetLimit: 0,
      publicFreeAssetNetUsage: 0,
      publicLatestFreeNetTime: 0,
    })
    await nodeCore(node).issueAsset(owner, input(50n))
    await nodeCore(node).issueAsset(secondOwner, input(2n))
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
  })

  afterAll(() => {
    server.close()
  })

  const post = async (path: string): Promise<{ assetIssue?: { id?: string; order?: number }[] }> =>
    (await (
      await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset: 0, limit: 2, visible: true }),
      })
    ).json()) as { assetIssue?: { id?: string; order?: number }[] }

  it('keeps identical names in asset-store order, regardless of declared order', async () => {
    for (const path of [
      'wallet/getpaginatedassetissuelist',
      'walletsolidity/getpaginatedassetissuelist',
    ]) {
      const page = await post(path)
      assert.deepEqual(
        page.assetIssue?.map((asset) => asset.order),
        [50, 2],
        path,
      )
      assert.deepEqual(
        page.assetIssue?.map((asset) => asset.id),
        ['1000001', '1000002'],
        path,
      )
    }
  })

  it('keeps lookup selection and list order through Solidity aliases', async () => {
    const ask = async (
      path: string,
      body: unknown,
    ): Promise<{ id?: string; assetIssue?: { id?: string }[] }> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as { id?: string; assetIssue?: { id?: string }[] }

    for (const prefix of ['wallet', 'walletsolidity']) {
      assert.strictEqual(
        (await ask(`${prefix}/getassetissuebyid`, { value: '1000001' })).id,
        '1000001',
      )
      // By-name also probes the id store after finding no matching name.
      assert.strictEqual(
        (await ask(`${prefix}/getassetissuebyname`, { value: '1000001', visible: true })).id,
        '1000001',
      )
      assert.deepEqual(
        (await ask(`${prefix}/getassetissuelist`, {})).assetIssue?.map((asset) => asset.id),
        ['1000001', '1000002'],
      )
      assert.deepEqual(
        (
          await ask(`${prefix}/getassetissuelistbyname`, { value: 'same-name', visible: true })
        ).assetIssue?.map((asset) => asset.id),
        ['1000001', '1000002'],
      )
    }
  })

  it('omits an empty page instead of printing an empty repeated field', async () => {
    for (const path of [
      'wallet/getpaginatedassetissuelist',
      'walletsolidity/getpaginatedassetissuelist',
    ]) {
      const response = await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset: 0, limit: 0, visible: true }),
      })
      assert.deepEqual(await response.json(), {}, path)
    }
  })

  it('decays public asset bandwidth before printing an issuance', async () => {
    const asset = nodeCore(node).assets.byId(1_000_001)!
    asset.publicFreeAssetNetUsage = 100
    asset.publicLatestFreeNetTime = nodeCore(node).head().timestampMs
    nodeCore(node).clock.advanceMs(86_400_000)
    await node.tre.mine(1)

    const response = await fetch(`${baseUrl}/wallet/getassetissuebyid?value=1000001`)
    const printed = (await response.json()) as { public_free_asset_net_usage?: number }
    assert.isUndefined(printed.public_free_asset_net_usage)
  })

  it('uses bytewise asset-id order when an id gains a digit', async () => {
    const registry = nodeCore(node).assets as unknown as {
      byIdMap: Map<number, { id: number; name: string }>
    }
    const template = nodeCore(node).assets.byId(1_000_001)!
    registry.byIdMap.set(9_999_999, { ...template, id: 9_999_999, name: 'boundary-low' })
    registry.byIdMap.set(10_000_000, { ...template, id: 10_000_000, name: 'boundary-high' })

    const response = await fetch(`${baseUrl}/wallet/getassetissuelist`)
    const list = (await response.json()) as { assetIssue?: { id?: string }[] }
    const boundary = (list.assetIssue ?? [])
      .map((asset) => asset.id)
      .filter((id) => id === '9999999' || id === '10000000')
    assert.deepEqual(boundary, ['10000000', '9999999'])
  })

  it('keeps that bytewise order when listing assets by name', async () => {
    const registry = nodeCore(node).assets as unknown as {
      byIdMap: Map<number, { id: number; name: string }>
    }
    const template = nodeCore(node).assets.byId(1_000_001)!
    registry.byIdMap.set(9_999_998, { ...template, id: 9_999_998, name: 'boundary-name' })
    registry.byIdMap.set(10_000_001, { ...template, id: 10_000_001, name: 'boundary-name' })

    const response = await fetch(
      `${baseUrl}/wallet/getassetissuelistbyname?visible=true&value=boundary-name`,
    )
    const list = (await response.json()) as { assetIssue?: { id?: string }[] }
    assert.deepEqual(
      list.assetIssue?.map((asset) => asset.id),
      ['10000001', '9999998'],
    )
  })
})
