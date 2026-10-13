import { createBlock } from '@tvmjs/block'
import { Common, TronNile } from '@tvmjs/common'
import { MapDB } from '@tvmjs/util'
import { assert, afterEach, describe, expect, it, vi } from 'vitest'

import { createBlockchain } from '../src/index.ts'

import { generateConsecutiveBlock } from './util.ts'

import type { Block } from '@tvmjs/block'
import type { Blockchain } from '../src/index.ts'

afterEach(() => vi.restoreAllMocks())

async function assertHead(blockchain: Blockchain, block: Block) {
  assert.deepEqual((await blockchain.getCanonicalHeadBlock()).hash(), block.hash())
  assert.deepEqual((await blockchain.getCanonicalHeadHeader()).hash(), block.hash())
}

describe('Block import after a database batch failure', () => {
  it('rejects a child until its parent has been stored successfully', async () => {
    const common = new Common({ chain: TronNile })
    const genesisBlock = createBlock({ header: { gasLimit: 1000000n } }, { common })
    const db = new MapDB()
    const options = { common, genesisBlock, db, validateBlocks: true }
    const blockchain = await createBlockchain(options)
    const storedGenesis = new Map(db._database)
    const first = generateConsecutiveBlock(genesisBlock)
    const second = generateConsecutiveBlock(first)

    const failure = new Error('Injected batch failure before any writes')
    vi.spyOn(db, 'batch').mockRejectedValueOnce(failure)
    await expect(blockchain.putBlock(first)).rejects.toBe(failure)
    await assertHead(blockchain, genesisBlock)
    assert.deepEqual(db._database, storedGenesis)

    // A fresh instance must reject the missing parent, and the original instance
    // must behave the same way even though it attempted to import that parent.
    const fresh = await createBlockchain(options)
    await expect(fresh.putBlock(second)).rejects.toThrow('not found in DB')
    await expect(blockchain.putBlock(second)).rejects.toThrow('not found in DB')
    await assertHead(blockchain, genesisBlock)
    assert.deepEqual(db._database, storedGenesis)

    const reloaded = await createBlockchain(options)
    for (const chain of [blockchain, reloaded]) {
      await assertHead(chain, genesisBlock)
      for (const block of [first, second]) {
        await expect(chain.getBlock(block.hash())).rejects.toThrow('not found in DB')
        await expect(chain.getBlock(block.header.number)).rejects.toThrow('not found in DB')
      }
    }

    // The failed import must neither poison the cache nor prevent a later retry.
    await blockchain.putBlock(first)
    await blockchain.putBlock(second)
    const afterRetry = await createBlockchain(options)
    for (const chain of [blockchain, afterRetry]) {
      await assertHead(chain, second)
      for (const block of [first, second]) {
        assert.deepEqual((await chain.getBlock(block.hash())).serialize(), block.serialize())
        assert.deepEqual((await chain.getBlock(block.header.number)).hash(), block.hash())
      }
    }
  })
})
