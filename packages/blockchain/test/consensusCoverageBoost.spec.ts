import { createBlock, createBlockHeader } from '@tvmjs/block'
import {
  Chain,
  ChainGenesis,
  Common,
  ConsensusAlgorithm,
  TronMainnet,
  TronNile,
} from '@tvmjs/common'
import { BIGINT_0, BIGINT_1, bytesToHex, concatBytes } from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import { genGenesisStateRoot, getGenesisStateRoot } from '../src/helpers.ts'
import { Blockchain, CasperConsensus, EthashConsensus, createBlockchain } from '../src/index.ts'

describe('Blockchain Consensus and Helpers Coverage Boost', () => {
  it('covers EthashConsensus methods and validations', async () => {
    let shouldPassPow = true
    const mockEthash = {
      cacheDB: undefined,
      verifyPOW: async () => shouldPassPow,
    }
    const ethash = new EthashConsensus(mockEthash)
    assert.strictEqual(ethash.algorithm, ConsensusAlgorithm.Ethash)

    const block = createBlock()
    await ethash.validateConsensus(block)

    shouldPassPow = false
    await expect(ethash.validateConsensus(block)).rejects.toThrow('invalid POW')

    const realHeader = createBlockHeader()
    await expect(ethash.validateDifficulty(realHeader)).rejects.toThrow('blockchain not provided')

    const mockBlockchain = {
      db: {},
      _getHeader: async () => realHeader,
    } as any

    await ethash.setup({ blockchain: mockBlockchain })
    assert.strictEqual(ethash.blockchain, mockBlockchain)
    assert.strictEqual(mockEthash.cacheDB, mockBlockchain.db)

    // Using header mock to test the difficulty validation branch in EthashConsensus
    const matchingHeader = {
      parentHash: new Uint8Array(32),
      difficulty: 100n,
      number: 1n,
      ethashCanonicalDifficulty: () => 100n,
      errorStr: () => '',
    } as any
    await ethash.validateDifficulty(matchingHeader)

    const mismatchHeader = {
      parentHash: new Uint8Array(32),
      difficulty: 100n,
      number: 1n,
      ethashCanonicalDifficulty: () => 200n,
      errorStr: () => 'mismatch',
    } as any
    await expect(ethash.validateDifficulty(mismatchHeader)).rejects.toThrow('invalid difficulty')

    await ethash.genesisInit()
    await ethash.newBlock()
  })

  it('covers CasperConsensus methods and validation', async () => {
    const casper = new CasperConsensus()
    assert.strictEqual(casper.algorithm, ConsensusAlgorithm.Casper)

    await casper.genesisInit()
    await casper.setup()
    await casper.validateConsensus()
    await casper.newBlock()

    const posHeader = createBlockHeader({ difficulty: BIGINT_0 })
    await casper.validateDifficulty(posHeader)

    const badHeader = createBlockHeader({ difficulty: BIGINT_1 })
    await expect(casper.validateDifficulty(badHeader)).rejects.toThrow(
      'PoS blocks must have difficulty 0',
    )
  })

  it('covers helpers.ts getGenesisStateRoot', async () => {
    const common = new Common({
      chain: {
        ...TronMainnet,
        genesis: {
          gasLimit: 1000000,
          difficulty: 0,
          nonce: '0x0000000000000000',
          extraData: '0x',
          timestamp: '0x00',
        },
      },
    })
    const knownRoot = await getGenesisStateRoot(Chain.Mainnet, common)
    assert.deepEqual(knownRoot, ChainGenesis[Chain.Mainnet].stateRoot)

    const genRoot = await genGenesisStateRoot({}, common)
    assert.isDefined(genRoot)
    assert.lengthOf(genRoot, 32)
  })

  it('covers Blockchain edge cases: safeNumberToHash, genesisBlock check, selectNeededHashes, poa genesis', async () => {
    const common = new Common({
      chain: {
        ...TronMainnet,
        genesis: {
          gasLimit: 1000000,
          difficulty: 0,
          nonce: '0x0000000000000000',
          extraData: '0x',
          timestamp: '0x00',
        },
      },
    })
    const blockchain = await createBlockchain({
      common,
      validateBlocks: false,
      validateConsensus: false,
    })

    // safeNumberToHash for non-existent block number
    const hash = await blockchain.safeNumberToHash(999999n)
    assert.isFalse(hash)

    // selectNeededHashes with mix of existing and missing
    const genesisHash = blockchain.genesisBlock.hash()
    const missingHash = new Uint8Array(32).fill(99)
    const needed = await blockchain.selectNeededHashes([genesisHash, missingHash])
    assert.lengthOf(needed, 1)
    assert.deepEqual(needed[0], missingHash)

    // Uninitialized genesisBlock check
    const uninitBlockchain = Object.create(Blockchain.prototype)
    expect(() => uninitBlockchain.genesisBlock).toThrow('genesis block not set')

    // createGenesisBlock with poa
    const poaCommon = new Common({
      chain: {
        ...TronMainnet,
        consensus: {
          type: 'poa',
          algorithm: 'clique',
          clique: { period: 15, epoch: 30000 },
        },
        genesis: {
          gasLimit: 1000000,
          difficulty: 1,
          nonce: '0x0000000000000000',
          extraData: bytesToHex(
            concatBytes(new Uint8Array(32), new Uint8Array(20), new Uint8Array(65)),
          ),
          timestamp: '0x00',
        },
      },
    })
    const poaBlockchain = await createBlockchain({
      common: poaCommon,
      validateBlocks: false,
      validateConsensus: false,
    })
    const genBlock = poaBlockchain.createGenesisBlock(new Uint8Array(32))
    assert.isDefined(genBlock)

    // Test constructor error: different chainId on genesisBlock
    const diffChainGenesis = createBlock({}, { common: new Common({ chain: TronMainnet }) })
    const diffChainCommon = new Common({ chain: TronNile })
    await expect(
      createBlockchain({
        common: diffChainCommon,
        genesisBlock: diffChainGenesis,
        validateBlocks: false,
        validateConsensus: false,
      }),
    ).rejects.toThrow('The genesis block has a different chainId than the Blockchain')
  })
})
