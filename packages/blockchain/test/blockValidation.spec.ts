import { createBlock } from '@tvmjs/block'
import { Hardfork } from '@tvmjs/common'
import { assert, describe, expect, it } from 'vitest'

import { createBlockchain } from '../src/index.ts'

import { generateBlock, powCommon } from './util.ts'

describe('[Blockchain]: Block validation tests', () => {
  it('should throw if an uncle is included before', async () => {
    const common = powCommon()
    const blockchain = await createBlockchain({
      common,
      genesisBlock: createBlock({ header: { gasLimit: 8000000n } }, { common }),
    })

    const genesis = blockchain.genesisBlock

    const uncleBlock = generateBlock(genesis, 'uncle', [], common)

    const block1 = generateBlock(genesis, 'block1', [], common)
    const block2 = generateBlock(block1, 'block2', [uncleBlock.header], common)
    const block3 = generateBlock(block2, 'block3', [uncleBlock.header], common)

    await blockchain.putBlock(uncleBlock)
    await blockchain.putBlock(block1)
    await blockchain.putBlock(block2)

    await expect(blockchain.putBlock(block3)).rejects.toThrow('uncle is already included')
  })

  it('should throw if the uncle parent block is not part of the canonical chain', async () => {
    const common = powCommon()
    const blockchain = await createBlockchain({
      common,
      genesisBlock: createBlock({ header: { gasLimit: 8000000n } }, { common }),
    })

    const genesis = blockchain.genesisBlock

    const emptyBlock = createBlock({ header: { number: BigInt(1) } }, { common })

    const uncleBlock = generateBlock(emptyBlock, 'uncle', [], common)
    const block1 = generateBlock(genesis, 'block1', [], common)
    const block2 = generateBlock(block1, 'block2', [], common)
    const block3 = generateBlock(block2, 'block3', [uncleBlock.header], common)
    await blockchain.putBlock(block1)
    await blockchain.putBlock(block2)

    await expect(blockchain.putBlock(block3)).rejects.toThrow('not found in DB')
  })

  it('should throw if the uncle is too old', async () => {
    const common = powCommon()
    const blockchain = await createBlockchain({
      common,
      genesisBlock: createBlock({ header: { gasLimit: 8000000n } }, { common }),
    })

    const genesis = blockchain.genesisBlock

    const uncleBlock = generateBlock(genesis, 'uncle', [], common)

    let lastBlock = genesis
    for (let i = 0; i < 7; i++) {
      const block = generateBlock(lastBlock, 'block' + i.toString(), [], common)
      await blockchain.putBlock(block)
      lastBlock = block
    }

    const blockWithUnclesTooOld = generateBlock(
      lastBlock,
      'too-old-uncle',
      [uncleBlock.header],
      common,
    )

    await expect(blockchain.putBlock(blockWithUnclesTooOld)).rejects.toThrow(
      'uncle block has a parent that is too old',
    )
  })

  it('should throw if uncle is too young', async () => {
    const common = powCommon()
    const blockchain = await createBlockchain({
      common,
      genesisBlock: createBlock({ header: { gasLimit: 8000000n } }, { common }),
    })

    const genesis = blockchain.genesisBlock

    const uncleBlock = generateBlock(genesis, 'uncle', [], common)
    const block1 = generateBlock(genesis, 'block1', [uncleBlock.header], common)

    await blockchain.putBlock(uncleBlock)

    await expect(blockchain.putBlock(block1)).rejects.toThrow(
      'uncle block has a parent that is too old or too young',
    )
  })

  it('throws if uncle is a canonical block', async () => {
    const common = powCommon()
    const blockchain = await createBlockchain({
      common,
      genesisBlock: createBlock({ header: { gasLimit: 8000000n } }, { common }),
    })

    const genesis = blockchain.genesisBlock

    const block1 = generateBlock(genesis, 'block1', [], common)
    const block2 = generateBlock(block1, 'block2', [block1.header], common)

    await blockchain.putBlock(block1)

    await expect(blockchain.putBlock(block2)).rejects.toThrow('The uncle is a canonical block')
  })

  it('successfully validates uncles', async () => {
    const common = powCommon()
    const blockchain = await createBlockchain({
      common,
      genesisBlock: createBlock({ header: { gasLimit: 8000000n } }, { common }),
    })

    const genesis = blockchain.genesisBlock

    const uncleBlock = generateBlock(genesis, 'uncle', [], common)
    await blockchain.putBlock(uncleBlock)

    const block1 = generateBlock(genesis, 'block1', [], common)
    const block2 = generateBlock(block1, 'block2', [uncleBlock.header], common)

    await blockchain.putBlock(block1)
    await blockchain.putBlock(block2)
    assert.deepEqual(
      (await blockchain.getCanonicalHeadHeader()).uncleHash,
      block2.header.uncleHash,
      'uncle blocks validated successfully',
    )
  })

  it('preserves the TRON profile and fee on uncles at every height', async () => {
    const common = powCommon()
    const genesisBlock = createBlock({ header: { gasLimit: 8000000n } }, { common })
    const blockchain = await createBlockchain({ common, genesisBlock })
    const uncle = generateBlock(genesisBlock, 'uncle', [], common)
    const first = generateBlock(genesisBlock, 'first', [], common)
    const second = generateBlock(first, 'second', [uncle.header], common)
    await blockchain.putBlocks([first, second])
    const restored = await blockchain.getBlock(second.hash())
    assert.deepEqual(restored.uncleHeaders[0].hash(), uncle.hash())
    assert.strictEqual(restored.uncleHeaders[0].baseFeePerGas, 7n)
    assert.strictEqual(restored.uncleHeaders[0].common.hardfork(), Hardfork.Tron)
    assert.strictEqual(common.hardfork(), Hardfork.Tron)
    assert.throws(() => common.setHardfork(Hardfork.London))
    const copied = createBlock(
      { header: second.header, uncleHeaders: [uncle.header] },
      { common, setHardfork: true },
    )
    assert.deepEqual(copied.uncleHeaders[0].hash(), uncle.hash())
  })
})
