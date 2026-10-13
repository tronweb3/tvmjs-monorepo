import {
  createBlock,
  createBlockHeader,
  createBlockHeaderFromBytesArray,
  genTransactionsTrieRoot,
} from '@tvmjs/block'
import { Common, Hardfork, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import { MapDB, bytesToHex, equalsBytes, hexToBytes, utf8ToBytes } from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import { Blockchain, createBlockchain, createBlockchainFromBlocksData } from '../src/index.ts'

import {
  cliqueCommon,
  createTestDB,
  generateBlockchain,
  generateBlocks,
  isConsecutive,
  powCommon,
} from './util.ts'

import type { Block, BlockOptions } from '@tvmjs/block'
import { CliqueConsensus } from '../src/consensus/clique.ts'

describe('blockchain test', () => {
  it('requires an explicit genesis for a TRON execution preset', async () => {
    await expect(createBlockchain()).rejects.toThrow(
      'require an explicit genesisBlock or network genesis metadata',
    )
  })

  it('should initialize correctly', async () => {
    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock({}, { common })
    for (const hardforkByHeadBlockNumber of [false, true]) {
      const blockchain = await createBlockchain({ common, genesisBlock, hardforkByHeadBlockNumber })
      assert.deepEqual((await blockchain.getIteratorHead()).hash(), genesisBlock.hash())
      assert.strictEqual(blockchain.common.hardfork(), Hardfork.Tron)
      assert.isUndefined(blockchain.consensus)
    }
  })

  it('initializes all three TRON networks with an explicit local genesis', async () => {
    for (const chain of [TronMainnet, TronNile, TronShasta]) {
      const common = new Common({ chain })
      const genesisBlock = createBlock(
        { header: { extraData: utf8ToBytes(chain.name) } },
        { common },
      )
      const blockchain = await createBlockchain({ common, genesisBlock })
      assert.deepEqual((await blockchain.getBlock(0n)).hash(), genesisBlock.hash())
      assert.strictEqual(blockchain.common.chainId(), BigInt(chain.chainId))
    }
  })

  it('should initialize correctly with createBlockchainFromBlocksData()', async () => {
    const blocks = generateBlocks(4)
    const blockchain = await createBlockchainFromBlocksData(
      blocks.slice(1).map((block) => block.toJSON()),
      {
        common: blocks[0].common,
        genesisBlock: blocks[0],
        validateBlocks: true,
      },
    )
    assert.strictEqual((await blockchain.getIteratorHead()).header.number, 0n)
    assert.deepEqual((await blockchain.getCanonicalHeadBlock()).hash(), blocks[3].hash())
  })

  it('should only initialize with supported consensus validation options', async () => {
    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock({}, { common })
    await expect(
      createBlockchain({ common, genesisBlock, validateConsensus: true }),
    ).rejects.toThrow('requires explicit network metadata')
    const pow = powCommon()
    await expect(
      createBlockchain({
        common: pow,
        genesisBlock: createBlock({}, { common: pow }),
        validateConsensus: true,
      }),
    ).rejects.toThrow('Consensus object for ethash must be passed')
    const clique = cliqueCommon()
    const cliqueGenesis = createBlock(
      { header: { extraData: new Uint8Array(97) } },
      { common: clique },
    )
    await expect(
      createBlockchain({ common: clique, genesisBlock: cliqueGenesis, validateConsensus: true }),
    ).rejects.toThrow('Consensus object for clique must be passed')
    const chain = await createBlockchain({
      common: clique,
      genesisBlock: cliqueGenesis,
      validateConsensus: true,
      consensusDict: { clique: new CliqueConsensus() },
    })
    assert.instanceOf(chain, Blockchain)
  })

  it('should add a genesis block without errors', async () => {
    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock({ header: { number: 0 } }, { common })
    const blockchain = await createBlockchain({
      common,
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock,
    })
    assert.deepEqual(
      genesisBlock.hash(),
      (await blockchain.getCanonicalHeadHeader()).hash(),
      'genesis block hash should be correct',
    )
  })

  it('should not validate a block incorrectly flagged as genesis', async () => {
    await expect(
      createBlockchain({ genesisBlock: createBlock({ header: { number: 8n } }) }),
    ).rejects.toBe('supplied block is not a genesis block')
  })

  it('should initialize with a genesis block', async () => {
    const blockchain = await createBlockchain({ genesisBlock: createBlock(), validateBlocks: true })
    const blocks = await blockchain.getBlocks(0, 5, 0, false)
    assert.strictEqual(blocks.length, 1)
  })

  it('should add 12 blocks, one at a time', async () => {
    const blocks: Block[] = []
    const gasLimit = 8000000
    const common = new Common({ chain: TronMainnet })

    const genesisBlock = createBlock({ header: { gasLimit } }, { common })
    blocks.push(genesisBlock)

    const blockchain = await createBlockchain({
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock,
      common,
      hardforkByHeadBlockNumber: true,
    })

    const addNextBlock = async (number: number) => {
      const lastBlock = blocks[number - 1]
      const blockData = {
        header: {
          number,
          parentHash: lastBlock.hash(),
          timestamp: lastBlock.header.timestamp + BigInt(1),
          gasLimit,
        },
      }
      const block = createBlock(blockData, {
        common,
      })
      await blockchain.putBlock(block)
      blocks.push(block)

      if (blocks.length < 12) {
        await addNextBlock(number + 1)
      } else {
        const getBlocks = await blockchain.getBlocks(blocks[0].hash(), 12, 0, false)
        assert.strictEqual(getBlocks.length, 12)
        assert.strictEqual(
          common.hardfork(),
          Hardfork.Tron,
          'correct HF updates along block additions',
        )
      }
    }

    await addNextBlock(1)
  })

  it('getBlock(): should get block by number', async () => {
    const blocks: Block[] = []
    const gasLimit = 8000000
    const common = new Common({ chain: TronMainnet })

    const genesisBlock = createBlock({ header: { gasLimit } }, { common })
    blocks.push(genesisBlock)

    const blockchain = await createBlockchain({
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock,
      common,
    })

    const blockData = {
      header: {
        number: 1,
        parentHash: genesisBlock.hash(),
        timestamp: genesisBlock.header.timestamp + BigInt(1),
        gasLimit,
      },
    }
    const block = createBlock(blockData, {
      common,
    })
    blocks.push(block)
    await blockchain.putBlock(block)

    const returnedBlock = await blockchain.getBlock(1)
    if (typeof returnedBlock !== 'undefined') {
      assert.deepEqual(returnedBlock.hash(), blocks[1].hash())
    } else {
      assert.fail('block is not defined!')
    }
  })

  it('getBlock(): should get block by hash / not existing', async () => {
    const common = new Common({ chain: TronMainnet })
    const gasLimit = 8000000
    const genesisBlock = createBlock({ header: { gasLimit } }, { common })

    const blockchain = await createBlockchain({
      common,
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock,
    })
    const block = await blockchain.getBlock(genesisBlock.hash())
    assert.deepEqual(block.hash(), genesisBlock.hash())

    try {
      await blockchain.getBlock(5)
      assert.fail('should throw an exception')
    } catch (e: any) {
      assert.isTrue(
        e.message.includes('not found in DB'),
        `should throw for non-existing block-by-number request`,
      )
    }

    try {
      await blockchain.getBlock(hexToBytes('0x1234'))
      assert.fail('should throw an exception')
    } catch (e: any) {
      assert.isTrue(
        e.message.includes('not found in DB'),
        `should throw for non-existing block-by-hash request`,
      )
    }
  })

  it('should get 5 consecutive blocks, starting from genesis hash', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: genesisHash, max: 5, skip: 0, reverse: false
    const getBlocks = await blockchain.getBlocks(blocks[0].hash(), 5, 0, false)
    assert.strictEqual(getBlocks!.length, 5)
    assert.strictEqual(blocks[0].header.number, getBlocks[0].header.number)
    assert.isTrue(isConsecutive(getBlocks!), 'blocks should be consecutive')

    const canonicalHeaderOriginal = await blockchain.getCanonicalHeadHeader()
    assert.strictEqual(
      canonicalHeaderOriginal.number,
      BigInt(24),
      'block 24 should be canonical header',
    )
    const block22 = await blockchain.getBlock(22)
    assert.strictEqual(block22.header.number, BigInt(22), 'should fetch block by number')

    await blockchain.resetCanonicalHead(BigInt(4))
    let canonicalHeader = await blockchain.getCanonicalHeadHeader()
    assert.strictEqual(canonicalHeader.number, BigInt(4), 'block 4 should be new canonical header')

    try {
      await blockchain.getBlock(22)
      assert.fail('canonical references should have been deleted')
    } catch (err: any) {
      assert.isTrue(
        err.message.includes('not found in DB'),
        'canonical references correctly deleted',
      )
    }

    try {
      await blockchain.getCanonicalHeader(BigInt(22))
      assert.fail('canonical references should have been deleted')
    } catch (err: any) {
      assert.strictEqual(
        err.message,
        'header with number 22 not found in canonical chain',
        'canonical references correctly deleted',
      )
    }

    await blockchain.putHeader(canonicalHeaderOriginal)
    canonicalHeader = await blockchain.getCanonicalHeadHeader()
    assert.strictEqual(
      canonicalHeader.number,
      BigInt(24),
      'block 24 should be new canonical header',
    )

    const newblock22 = await blockchain.getBlock(22)
    assert.strictEqual(
      newblock22.header.number,
      BigInt(22),
      'canonical references should be restored',
    )
    const newheader22 = await blockchain.getCanonicalHeader(BigInt(22))
    assert.strictEqual(newheader22.number, BigInt(22), 'canonical references should be restored')
    assert.strictEqual(
      bytesToHex(newblock22.hash()),
      bytesToHex(newheader22.hash()),
      'fetched block should match',
    )
  })

  it('should get 5 blocks, skipping 1 apart, starting from genesis hash', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: genesisHash, max: 5, skip: 1, reverse: false
    const getBlocks = await blockchain.getBlocks(blocks[0].hash(), 5, 1, false)
    assert.strictEqual(getBlocks!.length, 5, 'should get 5 blocks')
    assert.strictEqual(
      getBlocks![1].header.number,
      blocks[2].header.number,
      'should skip second block',
    )
    assert.isFalse(isConsecutive(getBlocks!), 'blocks should not be consecutive')
  })

  it('should get 4 blocks, skipping 2 apart, starting from genesis hash', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: genesisHash, max: 4, skip: 2, reverse: false
    const getBlocks = await blockchain.getBlocks(blocks[0].hash(), 4, 2, false)
    assert.strictEqual(getBlocks!.length, 4, 'should get 4 blocks')
    assert.strictEqual(
      getBlocks![1].header.number,
      blocks[3].header.number,
      'should skip two blocks apart',
    )
    assert.isFalse(isConsecutive(getBlocks!), 'blocks should not be consecutive')
  })

  it('should get 10 consecutive blocks, starting from genesis hash', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(15)
    assert.strictEqual(error, null, 'no error')
    // start: genesisHash, max: 17, skip: 0, reverse: false
    const getBlocks = await blockchain.getBlocks(blocks[0].hash(), 17, 0, false)
    assert.strictEqual(getBlocks!.length, 15)
    assert.strictEqual(getBlocks![0].header.number, blocks[0].header.number)
    assert.isTrue(isConsecutive(getBlocks!), 'blocks should be consecutive')
  })

  it('should get 5 consecutive blocks, starting from block 0', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: 0, max: 5, skip: 0, reverse: false
    const getBlocks = await blockchain.getBlocks(0, 5, 0, false)
    assert.strictEqual(getBlocks!.length, 5)
    assert.strictEqual(getBlocks![0].header.number, blocks[0].header.number)
    assert.isTrue(isConsecutive(getBlocks!), 'blocks should be consecutive')
  })

  it('should get 5 blocks, skipping 1 apart, starting from block 1', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: 1, max: 5, skip: 1, reverse: false
    const getBlocks = await blockchain.getBlocks(1, 5, 1, false)
    assert.strictEqual(getBlocks!.length, 5)
    assert.strictEqual(
      getBlocks![1].header.number,
      blocks[3].header.number,
      'should skip one block',
    )
    assert.isFalse(isConsecutive(getBlocks!), 'blocks should not be consecutive')
  })

  it('should get 5 blocks, skipping 2 apart, starting from block 0', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: 0, max: 5, skip: 2, reverse: false
    const getBlocks = await blockchain.getBlocks(0, 5, 2, false)
    assert.strictEqual(getBlocks!.length, 5)
    assert.strictEqual(
      getBlocks![1].header.number,
      blocks[3].header.number,
      'should skip two blocks',
    )
    assert.isFalse(isConsecutive(getBlocks!), 'blocks should not be consecutive')
  })

  it('should get 15 consecutive blocks, starting from block 0', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(15)
    assert.strictEqual(error, null, 'no error')
    // start: 0, max: 17, skip: 0, reverse: false
    const getBlocks = await blockchain.getBlocks(0, 17, 0, false)
    assert.strictEqual(getBlocks!.length, 15)
    assert.strictEqual(getBlocks![0].header.number, blocks[0].header.number)
    assert.isTrue(isConsecutive(getBlocks!), 'blocks should be consecutive')
  })

  it('should get 5 consecutive blocks, starting from block 1', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: 1, max: 5, skip: 0, reverse: false
    const getBlocks = await blockchain.getBlocks(1, 5, 0, false)
    assert.strictEqual(getBlocks!.length, 5)
    assert.strictEqual(getBlocks![0].header.number, blocks[1].header.number)
    assert.isTrue(isConsecutive(getBlocks!), 'blocks should be consecutive')
  })

  it('should get 5 consecutive blocks, starting from block 5', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: 5, max: 5, skip: 0, reverse: false
    const getBlocks = await blockchain.getBlocks(5, 5, 0, false)
    assert.strictEqual(getBlocks!.length, 5)
    assert.strictEqual(getBlocks![0].header.number, blocks[5].header.number)
    assert.isTrue(isConsecutive(getBlocks!), 'blocks should be consecutive')
  })

  it('should get 5 consecutive blocks, starting from block 5, reversed', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: 5, max: 5, skip: 0, reverse: true
    const getBlocks = await blockchain.getBlocks(5, 5, 0, true)
    assert.strictEqual(getBlocks!.length, 5)
    assert.strictEqual(getBlocks![0].header.number, blocks[5].header.number)
    assert.isTrue(isConsecutive(getBlocks!.reverse()), 'blocks should be consecutive')
  })

  it('should get 6 consecutive blocks, starting from block 5, reversed', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(15)
    assert.strictEqual(error, null, 'no error')
    // start: 5, max: 15, skip: 0, reverse: true
    const getBlocks = await blockchain.getBlocks(5, 15, 0, true)
    assert.strictEqual(getBlocks!.length, 6)
    assert.strictEqual(getBlocks![0].header.number, blocks[5].header.number)
    assert.isTrue(isConsecutive(getBlocks!.reverse()), 'blocks should be consecutive')
  })

  it('should get 6 blocks, starting from block 10, reversed, skipping 1 apart', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    // start: 10, max: 10, skip: 1, reverse: true
    const getBlocks = await blockchain.getBlocks(10, 10, 1, true)
    assert.strictEqual(getBlocks!.length, 6)
    assert.strictEqual(
      getBlocks![1].header.number,
      blocks[8].header.number,
      'should skip one block',
    )
    assert.isFalse(isConsecutive(getBlocks!.reverse()), 'blocks should not be consecutive')
  })

  it('should find needed hashes', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    const neededHash = hexToBytes('0xabcdef')
    const hashes = await blockchain.selectNeededHashes([
      blocks[0].hash(),
      blocks[9].hash(),
      neededHash,
    ])
    assert.deepEqual(hashes[0], neededHash)
  })

  it('should add fork header and reset stale heads', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(15)
    assert.strictEqual(error, null, 'no error')

    await blockchain.putBlocks(blocks.slice(1))

    const common = new Common({ chain: TronMainnet })
    const headerData = {
      number: 15,
      parentHash: blocks[14].hash(),
      gasLimit: 8000000,
      timestamp: BigInt(blocks[14].header.timestamp) + BigInt(1),
    }
    const forkHeader = createBlockHeader(headerData, {
      common,
    })

    await blockchain.setIteratorHead(
      'staleTest',
      (await blockchain.getCanonicalHeadHeader()).hash(),
    )

    await blockchain.putHeader(forkHeader)

    assert.deepEqual(
      (await blockchain.getIteratorHead('staleTest')).hash(),
      blocks[14].hash(),
      'should update stale head',
    )
    assert.deepEqual(
      (await blockchain.getCanonicalHeadBlock()).hash(),
      blocks[14].hash(),
      'should update stale headBlock',
    )
  })

  it('should delete fork header', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(15)
    assert.strictEqual(error, null, 'no error')

    const common = new Common({ chain: TronMainnet })
    const headerData = {
      number: 15,
      parentHash: blocks[14].hash(),
      gasLimit: 8000000,

      timestamp: BigInt(blocks[14].header.timestamp) + BigInt(1),
    }
    const forkHeader = createBlockHeader(headerData, {
      common,
    })

    await blockchain.setIteratorHead(
      'staleTest',
      (await blockchain.getCanonicalHeadHeader()).hash(),
    )

    await blockchain.putHeader(forkHeader)

    assert.deepEqual(
      (await blockchain.getIteratorHead('staleTest')).hash(),
      blocks[14].hash(),
      'should update stale head',
    )
    assert.deepEqual(
      (await blockchain.getCanonicalHeadBlock()).hash(),
      blocks[14].hash(),
      'should update stale headBlock',
    )

    await blockchain.delBlock(forkHeader.hash())

    assert.deepEqual(
      (await blockchain.getCanonicalHeadHeader()).hash(),
      blocks[14].hash(),
      'should reset headHeader',
    )
    assert.deepEqual(
      (await blockchain.getCanonicalHeadBlock()).hash(),
      blocks[14].hash(),
      'should not change headBlock',
    )
  })

  it('should delete blocks', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')

    const delNextBlock = async (number: number): Promise<any> => {
      const block = blocks[number]
      await blockchain.delBlock(block.hash())
      if (number > 6) {
        return delNextBlock(--number)
      }
    }

    await delNextBlock(9)
    assert.deepEqual(
      (await blockchain.getCanonicalHeadHeader()).hash(),
      blocks[5].hash(),
      'should have block 5 as head',
    )
  })

  it('should delete blocks and children', async () => {
    const { blockchain, blocks, error } = await generateBlockchain(25)
    assert.strictEqual(error, null, 'no error')
    await blockchain.delBlock(blocks[1].hash())
    assert.deepEqual(
      (await blockchain.getCanonicalHeadHeader()).hash(),
      blocks[0].hash(),
      'should have genesis as head',
    )
  })

  it('should put one block at a time', async () => {
    const blocks = generateBlocks(15)
    const blockchain = await createBlockchain({
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock: blocks[0],
    })
    await blockchain.putBlock(blocks[1])
    await blockchain.putBlock(blocks[2])
    await blockchain.putBlock(blocks[3])
  })

  it('should test nil bodies / throw', async () => {
    const blocks = generateBlocks(3)
    const blockchain = await createBlockchain({
      validateBlocks: false,
      validateConsensus: false,
      genesisBlock: blocks[0],
    })
    await blockchain.putHeader(blocks[1].header)
    // Should be able to get the block
    await blockchain.getBlock(BigInt(1))

    const block2HeaderValuesArray = blocks[2].header.raw()

    block2HeaderValuesArray[1] = new Uint8Array(32)
    const block2Header = createBlockHeaderFromBytesArray(block2HeaderValuesArray, {
      common: blocks[2].common,
    })
    await blockchain.putHeader(block2Header)
    try {
      await blockchain.getBlock(BigInt(2))
      assert.fail('block should not be constructed')
    } catch (e: any) {
      assert.strictEqual(
        e.message,
        'uncle hash should be equal to hash of empty array',
        'block not constructed from empty bodies',
      )
    }
  })

  it('should put multiple blocks at once', async () => {
    const common = new Common({ chain: TronMainnet })
    const blocks: Block[] = []
    const genesisBlock = createBlock({ header: { gasLimit: 8000000 } }, { common })
    blocks.push(...generateBlocks(15, [genesisBlock]))
    const blockchain = await createBlockchain({
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock,
    })
    await blockchain.putBlocks(blocks.slice(1))
  })

  it('should validate', async () => {
    const blockchain = await createBlockchain({
      genesisBlock: createBlock({ header: { gasLimit: 8000000n } }),
      validateBlocks: true,
    })
    const invalidBlock = createBlock({ header: { number: 50 } })
    await expect(blockchain.putBlock(invalidBlock)).rejects.toThrow('not found in DB')
  })

  it('should add block with body', async () => {
    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock({ header: { gasLimit: 8000000n } }, { common })
    const blockchain = await createBlockchain({ common, genesisBlock, validateBlocks: true })
    const tx = createLegacyTx(
      {
        to: `0x${'11'.repeat(20)}`,
        gasLimit: 21000n,
        gasPrice: 7n,
        tokenId: 9007199254740993n,
        tokenValue: 1n,
      },
      { common },
    ).sign(hexToBytes(`0x${'20'.repeat(32)}`))
    const block = createBlock(
      {
        header: {
          number: 1n,
          parentHash: genesisBlock.hash(),
          timestamp: 1n,
          gasLimit: 8000000n,
          baseFeePerGas: 7n,
          transactionsTrie: await genTransactionsTrieRoot([tx]),
        },
        transactions: [tx],
      },
      { common },
    )
    await blockchain.putBlock(block)
    const restored = await blockchain.getBlock(1n)
    assert.deepEqual(restored.serialize(), block.serialize())
    assert.deepEqual(restored.transactions[0].getSenderAddress(), tx.getSenderAddress())
    assert.strictEqual(restored.transactions[0].toJSON().tokenId, '0x20000000000001')
  })

  it('uncached db ops', async () => {
    const [db, genesis] = await createTestDB()
    if (typeof genesis === 'undefined') {
      return assert.fail('genesis not defined!')
    }
    const blockchain = await createBlockchain({ db, genesisBlock: genesis })

    const number = await blockchain.dbManager.hashToNumber(genesis?.hash())
    assert.strictEqual(number, BigInt(0), 'should perform _hashToNumber correctly')

    const hash = await blockchain.dbManager.numberToHash(BigInt(0))
    assert.deepEqual(genesis.hash(), hash, 'should perform _numberToHash correctly')

    const td = await blockchain.getTotalDifficulty(genesis.hash(), BigInt(0))
    assert.strictEqual(td, genesis.header.difficulty, 'should perform getTotalDifficulty correctly')
  })

  it('should save headers', async () => {
    const db = new MapDB()
    const gasLimit = 8000000

    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock({ header: { gasLimit } }, { common })
    let blockchain = await createBlockchain({
      db,
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock,
    })

    const headerData = {
      number: 1,
      parentHash: genesisBlock.hash(),
      gasLimit,
      timestamp: genesisBlock.header.timestamp + BigInt(1),
    }
    const header = createBlockHeader(headerData, {
      common,
    })
    await blockchain.putHeader(header)

    blockchain = await createBlockchain({
      db,
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock,
    })

    const latestHeader = await blockchain.getCanonicalHeadHeader()
    assert.deepEqual(latestHeader.hash(), header.hash(), 'should save headHeader')

    const latestBlock = await blockchain.getCanonicalHeadBlock()
    assert.deepEqual(latestBlock.hash(), genesisBlock.hash(), 'should save headBlock')
  })

  it('should get latest', async () => {
    const gasLimit = 8000000
    const common = new Common({ chain: TronMainnet })
    const opts: BlockOptions = { common }

    const genesisBlock = createBlock({ header: { gasLimit } }, opts)
    const blockchain = await createBlockchain({
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock,
    })

    const blockData = {
      header: {
        number: 1,
        parentHash: genesisBlock.hash(),
        timestamp: genesisBlock.header.timestamp + BigInt(3),
        gasLimit,
      },
    }
    const block = createBlock(blockData, opts)

    const headerData1 = {
      number: 1,
      parentHash: genesisBlock.hash(),
      timestamp: genesisBlock.header.timestamp + BigInt(1),
      gasLimit,
    }
    const header1 = createBlockHeader(headerData1, opts)
    const headers = [header1]

    const headerData2 = {
      number: 2,
      parentHash: header1.hash(),
      timestamp: header1.timestamp + BigInt(1),
      gasLimit,
    }
    const header2 = createBlockHeader(headerData2, opts)
    headers.push(header2)

    await blockchain.putHeaders(headers)

    const latestHeader = await blockchain.getCanonicalHeadHeader()
    assert.deepEqual(latestHeader.hash(), headers[1].hash(), 'should update latest header')

    const latestBlock = await blockchain.getCanonicalHeadBlock()
    assert.deepEqual(latestBlock.hash(), genesisBlock.hash(), 'should not change latest block')

    await blockchain.putBlock(block)

    const latestHeader2 = await blockchain.getCanonicalHeadHeader()
    assert.deepEqual(latestHeader2.hash(), headers[1].hash(), 'should not change latest header')

    const getBlock = await blockchain.getCanonicalHeadBlock()
    assert.deepEqual(
      getBlock.hash(),
      genesisBlock.hash(),
      'body outside the canonical chain must not advance the head',
    )
    await blockchain.putBlock(createBlock({ header: header1 }, { common }))
    assert.deepEqual(
      (await blockchain.getCanonicalHeadBlock()).hash(),
      header1.hash(),
      'canonical body advances the head',
    )
  })

  it('mismatched chains', async () => {
    const common = new Common({ chain: TronMainnet })
    const gasLimit = 8000000

    const genesisBlock = createBlock({ header: { gasLimit } }, { common })

    const blockData1 = {
      header: {
        number: 1,
        parentHash: genesisBlock.hash(),
        timestamp: genesisBlock.header.timestamp + BigInt(1),
        gasLimit,
      },
    }
    const blockData2 = {
      header: { ...blockData1.header, timestamp: genesisBlock.header.timestamp + 2n },
    }

    const blocks = [
      genesisBlock,
      createBlock(blockData1, {
        common,
      }),
      createBlock(blockData2, {
        common: new Common({ chain: TronNile }),
      }),
    ]

    const blockchain = await createBlockchain({
      common,
      validateBlocks: true,
      validateConsensus: false,
      genesisBlock,
    })

    for (let i = 1; i < blocks.length; i++) {
      let error
      try {
        await blockchain.putBlock(blocks[i])
      } catch (err: any) {
        error = err
      }
      if (i === 2) {
        assert.include(error.message, 'Chain mismatch', 'should return chain mismatch error')
      } else {
        assert.isUndefined(error, 'should not return mismatch error')
      }
    }
  })
})

describe('initialization tests', () => {
  it('should read genesis from database', async () => {
    const common = new Common({
      chain: TronMainnet,
    })
    const genesisBlock = createBlock({}, { common })
    const blockchain = await createBlockchain({ common, genesisBlock })
    const genesisHash = blockchain.genesisBlock.hash()

    assert.deepEqual(
      (await blockchain.getIteratorHead()).hash(),
      genesisHash,
      'head hash should equal explicit genesis hash',
    )

    const db = blockchain.db

    const newBlockchain = await createBlockchain({ db, common, genesisBlock })

    assert.deepEqual(
      (await newBlockchain.getIteratorHead()).hash(),
      genesisHash,
      'head hash should be read from the provided db',
    )
  })

  it('should allow to put a custom genesis block', async () => {
    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock(
      {
        header: {
          extraData: utf8ToBytes('custom extra data'),
        },
      },
      { common },
    )
    const hash = genesisBlock.hash()
    const blockchain = await createBlockchain({ common, genesisBlock })
    const db = blockchain.db

    assert.deepEqual(
      (await blockchain.getIteratorHead()).hash(),
      hash,
      'blockchain should put custom genesis block',
    )

    const newBlockchain = await createBlockchain({ db, genesisBlock })
    assert.deepEqual(
      (await newBlockchain.getIteratorHead()).hash(),
      hash,
      'head hash should be read from the provided db',
    )
  })

  it('should not allow to change the genesis block in the database', async () => {
    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock(
      {
        header: {
          extraData: utf8ToBytes('custom extra data'),
        },
      },
      { common },
    )
    const hash = genesisBlock.hash()
    const blockchain = await createBlockchain({ common, genesisBlock })
    const db = blockchain.db

    const otherGenesisBlock = createBlock(
      {
        header: {
          extraData: utf8ToBytes('other extra data'),
        },
      },
      { common },
    )

    // assert that this is a block with a new hash
    if (equalsBytes(otherGenesisBlock.hash(), hash)) {
      assert.fail('other genesis block should have a different hash than the genesis block')
    }

    // try to put a new genesis block should throw
    try {
      await blockchain.putBlock(otherGenesisBlock)
      assert.fail('putting a genesis block did not throw')
    } catch (e: any) {
      assert.strictEqual(
        e.message,
        'Cannot put a different genesis block than current blockchain genesis: create a new Blockchain',
        'putting a genesis block did throw (otherGenesisBlock not found in chain)',
      )
    }

    // trying to input a genesis block which differs from the one in db should throw on creation
    try {
      await createBlockchain({ genesisBlock: otherGenesisBlock, db })
      assert.fail('creating blockchain with different genesis block than in db did not throw')
    } catch (e: any) {
      assert.strictEqual(
        e.message,
        'The genesis block in the DB has a different hash than the provided genesis block.',
        'creating blockchain with different genesis block than in db throws',
      )
    }
  })
})

it('derives a local genesis from explicit metadata and an explicit state root', async () => {
  const stateRoot = hexToBytes('0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544')
  const common = new Common({
    chain: {
      ...TronMainnet,
      genesis: {
        gasLimit: 8000000,
        difficulty: 0,
        nonce: '0x0000000000000000',
        extraData: '0x1234',
      },
    },
  })
  const blockchain = await createBlockchain({ common, genesisStateRoot: stateRoot })
  const expected = createBlock(
    { header: { gasLimit: 8000000n, stateRoot, difficulty: 0n, extraData: '0x1234' } },
    { common },
  )
  assert.deepEqual(blockchain.genesisBlock.header.stateRoot, stateRoot)
  assert.deepEqual(blockchain.genesisBlock.hash(), expected.hash())
  assert.isFalse(common.hasConsensus())
})
