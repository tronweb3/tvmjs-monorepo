import { hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, afterAll, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

import type { Server } from 'node:http'

/** Writes and returns one 32-byte word: deliberately more than a one-energy call cap. */
const RETURN_WORD = '0x600060005260206000f3'

describe('estimateenergy fee ceiling', () => {
  const config = resolveConfig({ runtime: { maxEnergyLimitForConstant: 1n } })
  const owner = TronWeb.address.toHex(
    TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[0].privateKey) as string,
  )
  const contract = utils.accounts.generateAccount().address.base58
  let server: Server
  let baseUrl = ''

  beforeAll(async () => {
    const node = await TronNode.create(config)
    await nodeCore(node).setCode(parseTronAddress(contract), hexToBytes(RETURN_WORD))
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
  })

  afterAll(() => {
    server.close()
  })

  const estimate = async (
    path: string,
  ): Promise<{ result: { result?: boolean }; energy_required?: number }> =>
    (await (
      await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_address: owner,
          contract_address: TronWeb.address.toHex(contract),
        }),
      })
    ).json()) as { result: { result?: boolean }; energy_required?: number }

  it('starts both views at the fee ceiling rather than the ordinary call cap', async () => {
    for (const path of ['wallet/estimateenergy', 'walletsolidity/estimateenergy']) {
      const reply = await estimate(path)
      assert.strictEqual(reply.result.result, true)
      assert.isAbove(reply.energy_required ?? 0, 1)
    }
  })
})
