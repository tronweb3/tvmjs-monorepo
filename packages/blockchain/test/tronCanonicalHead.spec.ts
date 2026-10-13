import { createBlock } from '@tvmjs/block'
import { Common, TronNile } from '@tvmjs/common'
import { assert, describe, it } from 'vitest'

import { createBlockchain } from '../src/index.ts'

import type { Block } from '@tvmjs/block'
import type { Blockchain } from '../src/index.ts'

// TRON execution presets carry no consensus metadata and block headers default to
// difficulty 0, so total difficulty never grows. Fork choice then follows block
// numbers: a higher block extends the canonical head, everything else is stored
// without moving it.
describe('TRON canonical head without consensus metadata', () => {
  const common = new Common({ chain: TronNile })

  function childOf(parent: Block, timestampOffset = 1n): Block {
    return createBlock(
      {
        header: {
          number: parent.header.number + 1n,
          parentHash: parent.hash(),
          timestamp: parent.header.timestamp + timestampOffset,
          gasLimit: parent.header.gasLimit,
          baseFeePerGas: parent.header.calcNextBaseFee(),
        },
      },
      { common },
    )
  }

  async function chain(validateBlocks = false) {
    const genesisBlock = createBlock({ header: { gasLimit: 1000000n } }, { common })
    const blockchain = await createBlockchain({ common, genesisBlock, validateBlocks })
    return { genesisBlock, blockchain }
  }

  async function heads(blockchain: Blockchain) {
    return {
      header: (await blockchain.getCanonicalHeadHeader()).hash(),
      block: (await blockchain.getCanonicalHeadBlock()).hash(),
    }
  }

  for (const validateBlocks of [false, true]) {
    it(`advances the head through zero-difficulty blocks with validateBlocks=${validateBlocks}`, async () => {
      const { genesisBlock, blockchain } = await chain(validateBlocks)
      assert.isFalse(common.hasConsensus())

      let parent = genesisBlock
      for (let height = 1n; height <= 3n; height++) {
        const block = childOf(parent)
        assert.strictEqual(block.header.difficulty, 0n)
        await blockchain.putBlock(block)

        assert.deepEqual(await heads(blockchain), { header: block.hash(), block: block.hash() })
        assert.deepEqual((await blockchain.getBlock(height)).hash(), block.hash())
        assert.strictEqual(await blockchain.getTotalDifficulty(block.hash()), 0n)
        parent = block
      }
    })
  }

  it('keeps the head when an older block is put again', async () => {
    const { genesisBlock, blockchain } = await chain()
    const first = childOf(genesisBlock)
    const second = childOf(first)
    const third = childOf(second)
    for (const block of [first, second, third]) await blockchain.putBlock(block)

    await blockchain.putBlock(first)
    assert.deepEqual(await heads(blockchain), { header: third.hash(), block: third.hash() })
    assert.deepEqual((await blockchain.getBlock(3n)).hash(), third.hash())
    assert.deepEqual((await blockchain.getBlock(1n)).hash(), first.hash())
  })

  it('advances the head block along stored headers when bodies arrive later', async () => {
    const { genesisBlock, blockchain } = await chain()
    const first = childOf(genesisBlock)
    const second = childOf(first)
    const third = childOf(second)
    await blockchain.putHeaders([first.header, second.header, third.header])
    assert.deepEqual(await heads(blockchain), { header: third.hash(), block: genesisBlock.hash() })

    for (const block of [first, second, third]) {
      await blockchain.putBlock(block)
      assert.deepEqual(await heads(blockchain), { header: third.hash(), block: block.hash() })
    }
    assert.deepEqual((await blockchain.getBlock(2n)).hash(), second.hash())
  })

  it('keeps the first stored sibling and switches to a longer fork', async () => {
    const { genesisBlock, blockchain } = await chain()
    const first = childOf(genesisBlock, 1n)
    const sibling = childOf(genesisBlock, 2n)
    assert.notDeepEqual(first.hash(), sibling.hash())

    await blockchain.putBlock(first)
    await blockchain.putBlock(sibling)
    assert.deepEqual(await heads(blockchain), { header: first.hash(), block: first.hash() })
    assert.deepEqual((await blockchain.getBlock(1n)).hash(), first.hash())
    assert.deepEqual((await blockchain.getBlock(sibling.hash())).hash(), sibling.hash())

    const forkChild = childOf(sibling)
    await blockchain.putBlock(forkChild)
    assert.deepEqual(await heads(blockchain), { header: forkChild.hash(), block: forkChild.hash() })
    assert.deepEqual((await blockchain.getBlock(1n)).hash(), sibling.hash())
    assert.deepEqual((await blockchain.getBlock(2n)).hash(), forkChild.hash())
  })
})
