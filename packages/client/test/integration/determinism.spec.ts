import { bytesToHex } from '@tvmjs/util'
import { assert } from 'chai'
import { TronWeb } from 'tronweb'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import type { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

import type { Server } from 'node:http'

/**
 * A frozen clock, not merely a shifted one: block times come from the clock, and
 * two chains driven a few hundred milliseconds apart would otherwise stamp
 * different `timestamp` and `expiration` into every transaction.
 */
const PINNED_MS = 1_800_000_000_000

interface Chain {
  node: TronNode
  server: Server
  url: string
  tronWeb: TronWeb
}

async function startChain(): Promise<Chain> {
  const config = resolveConfig()
  const clock = new Clock(() => PINNED_MS)
  const node = await createNode(config, clock)
  const started = await startHttpServer(new TronProvider(node), { port: 0 })
  return {
    node,
    server: started.server,
    url: started.url,
    tronWeb: new TronWeb({
      fullHost: started.url,
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    }),
  }
}

/** the inputs both chains are driven with, so nothing about them can differ */
async function drive(chain: Chain): Promise<string[]> {
  const config = resolveConfig()
  const owner = chain.tronWeb.defaultAddress.base58 as string
  const to = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[1].privateKey,
  ) as string
  const ids: string[] = []
  for (const amount of [1_000_000, 2_000_000, 3_000_000]) {
    const tx = (await chain.tronWeb.transactionBuilder.sendTrx(to, amount, owner)) as unknown as {
      txID: string
      raw_data_hex: string
    }
    const reply = (await chain.tronWeb.trx.sendRawTransaction(
      await chain.tronWeb.trx.sign(tx as never),
    )) as { result?: boolean }
    assert.isTrue(reply.result)
    ids.push(`${tx.txID}:${tx.raw_data_hex}`)
  }
  return ids
}

describe('determinism', () => {
  let a: Chain
  let b: Chain

  beforeAll(async () => {
    a = await startChain()
    b = await startChain()
  })

  afterAll(() => {
    a.server.close()
    b.server.close()
  })

  it('two chains driven with the same inputs agree on ids, bytes and state root', async () => {
    const [idsA, idsB] = [await drive(a), await drive(b)]

    // the id and the signed bytes are what a client checks a signature against
    assert.deepEqual(idsA, idsB)
    assert.strictEqual(nodeCore(a.node).blocks.height(), nodeCore(b.node).blocks.height())
    assert.strictEqual(
      bytesToHex(await nodeCore(a.node).stateManager.getStateRoot()),
      bytesToHex(await nodeCore(b.node).stateManager.getStateRoot()),
    )
  })

  it('every block agrees, header for header', async () => {
    for (let number = 0n; number <= nodeCore(a.node).blocks.height(); number += 1n) {
      const [blockA, blockB] = [
        nodeCore(a.node).blocks.getByNumber(number),
        nodeCore(b.node).blocks.getByNumber(number),
      ]
      assert.strictEqual(blockA?.blockID, blockB?.blockID, `block ${number}`)
      assert.strictEqual(blockA?.txTrieRoot, blockB?.txTrieRoot, `block ${number} txTrieRoot`)
    }
  })

  it('replaying a receipt query gives the same answer every time', async () => {
    const [id] = (await drive(a))[0].split(':')
    const once = await (
      await fetch(`${a.url}/wallet/gettransactioninfobyid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: id }),
      })
    ).text()
    const twice = await (
      await fetch(`${a.url}/wallet/gettransactioninfobyid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: id }),
      })
    ).text()
    assert.strictEqual(once, twice)
  })
})

describe('concurrency', () => {
  let chain: Chain

  beforeAll(async () => {
    chain = await startChain()
  })

  afterAll(() => {
    chain.server.close()
  })

  it('parallel transfers all land, and the balances add up', async () => {
    const config = resolveConfig()
    const owner = chain.tronWeb.defaultAddress.base58 as string
    const receivers = accountsFromMnemonic(config.mnemonic)
      .slice(1, 6)
      .map((account) => TronWeb.address.fromPrivateKey(account.privateKey) as string)
    const before = await Promise.all(receivers.map((to) => chain.tronWeb.trx.getBalance(to)))
    const ownerBefore = await chain.tronWeb.trx.getBalance(owner)

    // built up front, then fired together: the node has to serialise them itself
    const signed = await Promise.all(
      receivers.map(async (to) =>
        chain.tronWeb.trx.sign(
          (await chain.tronWeb.transactionBuilder.sendTrx(to, 1_000_000, owner)) as never,
        ),
      ),
    )
    const replies = (await Promise.all(
      signed.map((tx) => chain.tronWeb.trx.sendRawTransaction(tx)),
    )) as { result?: boolean }[]
    assert.deepEqual(
      replies.map((reply) => reply.result),
      receivers.map(() => true),
    )

    const after = await Promise.all(receivers.map((to) => chain.tronWeb.trx.getBalance(to)))
    assert.deepEqual(
      after.map((balance, index) => balance - before[index]),
      receivers.map(() => 1_000_000),
    )
    // the sender pays every amount plus every fee, and nothing is lost or minted
    const ownerAfter = await chain.tronWeb.trx.getBalance(owner)
    assert.isAtLeast(ownerBefore - ownerAfter, 5_000_000)
  })

  it('the same transaction fired in parallel is accepted once', async () => {
    const config = resolveConfig()
    const owner = chain.tronWeb.defaultAddress.base58 as string
    const to = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[7].privateKey,
    ) as string
    const signed = await chain.tronWeb.trx.sign(
      (await chain.tronWeb.transactionBuilder.sendTrx(to, 1_000_000, owner)) as never,
    )
    const before = await chain.tronWeb.trx.getBalance(to)

    const replies = (await Promise.all(
      Array.from({ length: 6 }, () => chain.tronWeb.trx.sendRawTransaction(signed)),
    )) as unknown as { result?: boolean; code?: string }[]

    assert.strictEqual(replies.filter((reply) => reply.result === true).length, 1)
    assert.strictEqual(replies.filter((reply) => reply.code === 'DUP_TRANSACTION_ERROR').length, 5)
    assert.strictEqual((await chain.tronWeb.trx.getBalance(to)) - before, 1_000_000)
  })

  it('a block never contains a transaction twice', async () => {
    const seen = new Set<string>()
    for (let number = 0n; number <= nodeCore(chain.node).blocks.height(); number += 1n) {
      for (const record of nodeCore(chain.node).blocks.getByNumber(number)?.txs ?? []) {
        assert.isFalse(seen.has(record.txid), `${record.txid} sealed twice`)
        seen.add(record.txid)
      }
    }
  })
})
