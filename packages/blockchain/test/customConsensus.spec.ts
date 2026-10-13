import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet } from '@tvmjs/common'
import { bytesToHex } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createBlockchain } from '../src/index.ts'

import type { Block, BlockHeader } from '@tvmjs/block'
import type { Consensus, ConsensusDict } from '../src/index.ts'

class fibonacciConsensus implements Consensus {
  algorithm: string
  constructor() {
    this.algorithm = 'fibonacciConsensus'
  }
  genesisInit(_genesisBlock: Block): Promise<void> {
    return new Promise<void>((resolve) => resolve())
  }
  setup(): Promise<void> {
    return new Promise<void>((resolve) => resolve())
  }
  validateConsensus(_block: Block): Promise<void> {
    if (bytesToHex(_block.header.extraData) !== '0x12358d') {
      throw new Error(
        'header contains invalid extradata - must match first 6 elements of fibonacci sequence',
      )
    }
    return new Promise<void>((resolve) => resolve())
  }
  validateDifficulty(_header: BlockHeader): Promise<void> {
    if (_header.number === 1n && _header.difficulty === 1n) {
      return new Promise<void>((resolve) => resolve())
    }
    if (_header.difficulty !== _header.number - 1n + _header.number - 2n) {
      throw new Error('invalid difficulty - must be sum of previous two block numbers')
    }
    return new Promise<void>((resolve) => resolve())
  }
  newBlock(): Promise<void> {
    return new Promise<void>((resolve) => resolve())
  }
}

const consensusDict: ConsensusDict = {}
consensusDict['fibonacci'] = new fibonacciConsensus()

async function createTestBlockchain() {
  const common = new Common({
    chain: {
      ...TronMainnet,
      name: 'custom-consensus-test',
      chainId: 12345,
      consensus: { type: 'custom', algorithm: 'fibonacci' },
    },
  })
  const genesisBlock = createBlock({ header: { gasLimit: 1000000n } }, { common })
  const blockchain = await createBlockchain({
    common,
    genesisBlock,
    validateConsensus: true,
    consensusDict,
  })
  return { common, blockchain }
}

describe('Optional consensus parameter in blockchain constructor', () => {
  it('blockchain constructor should work with custom consensus', async () => {
    const { blockchain } = await createTestBlockchain()
    assert.strictEqual(
      (blockchain.consensus as fibonacciConsensus).algorithm,
      'fibonacciConsensus',
      'consensus algorithm matches',
    )
  })
})

describe('Custom consensus validation rules', () => {
  it('should validate custom consensus rules', async () => {
    const { common, blockchain } = await createTestBlockchain()
    const block = createBlock(
      {
        header: {
          number: 1n,
          difficulty: 1n,
          extraData: '0x12358d',
          parentHash: blockchain.genesisBlock.hash(),
          timestamp: blockchain.genesisBlock.header.timestamp + 1n,
          gasLimit: blockchain.genesisBlock.header.gasLimit + 1n,
        },
      },
      { common },
    )

    try {
      await blockchain.putBlock(block)
      assert.deepEqual(
        (await blockchain.getBlock(block.header.number)).header.hash(),
        block.header.hash(),
        'put block with valid difficulty and extraData',
      )
    } catch {
      assert.fail('should have put block with valid difficulty and extraData')
    }

    const blockWithBadDifficulty = createBlock(
      {
        header: {
          number: 2n,
          difficulty: 2n,
          extraData: '0x12358d',
          parentHash: block.hash(),
          timestamp: block.header.timestamp + 1n,
        },
      },
      { common },
    )
    try {
      await blockchain.putBlock(blockWithBadDifficulty)
      assert.fail('should throw')
    } catch (err: any) {
      assert.isTrue(
        err.message.includes('invalid difficulty'),
        'failed to put block with invalid difficulty',
      )
    }

    const blockWithBadExtraData = createBlock(
      {
        header: {
          number: 2n,
          difficulty: 1n,
          extraData: '0x12358c',
          parentHash: block.hash(),
          timestamp: block.header.timestamp + 1n,
          gasLimit: block.header.gasLimit + 1n,
        },
      },
      { common },
    )
    try {
      await blockchain.putBlock(blockWithBadExtraData)
      assert.fail('should throw')
    } catch (err: any) {
      assert.isTrue(
        err.message ===
          'header contains invalid extradata - must match first 6 elements of fibonacci sequence',
        'failed to put block with invalid extraData',
      )
    }
  })
})

describe('consensus transition checks', () => {
  it('should transition correctly', async () => {
    const { blockchain } = await createTestBlockchain()

    try {
      await blockchain.checkAndTransitionHardForkByNumber(5n)
      assert.isTrue(true, 'checkAndTransitionHardForkByNumber does not throw with custom consensus')
    } catch (err: any) {
      assert.fail(
        `checkAndTransitionHardForkByNumber should not throw with custom consensus, error=${err.message}`,
      )
    }

    blockchain.common.consensusAlgorithm = () => 'ethash'

    try {
      await blockchain.checkAndTransitionHardForkByNumber(5n)
      assert.fail(
        'checkAndTransitionHardForkByNumber should throw when using standard consensus (ethash, clique, casper) but consensus algorithm defined in common is different',
      )
    } catch (err: any) {
      assert.isTrue(err.message.includes('Consensus object for ethash must be passed'))
    }
  })
})
