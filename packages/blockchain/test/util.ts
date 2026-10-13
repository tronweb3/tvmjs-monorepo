import { keccak_256 } from '@noble/hashes/sha3.js'
import { createBlock } from '@tvmjs/block'
import { Common, ConsensusAlgorithm, ConsensusType, TronMainnet } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import {
  MapDB,
  bytesToUnprefixedHex,
  equalsBytes,
  hexToBytes,
  toBytes,
  utf8ToBytes,
} from '@tvmjs/util'

import { createBlockchain } from '../src/index.ts'

import type { Block, BlockHeader } from '@tvmjs/block'
import type { DB } from '@tvmjs/util'

// Local test metadata for retained tools; these are not TRON network consensus profiles.
export const powCommon = () =>
  new Common({
    chain: {
      ...TronMainnet,
      consensus: { type: ConsensusType.ProofOfWork, algorithm: ConsensusAlgorithm.Ethash },
    },
  })

export const cliqueCommon = (epoch = 30000) =>
  new Common({
    chain: {
      ...TronMainnet,
      consensus: {
        type: ConsensusType.ProofOfAuthority,
        algorithm: ConsensusAlgorithm.Clique,
        clique: { period: 15, epoch },
      },
    },
  })

export const generateBlocks = (numberOfBlocks: number, existingBlocks?: Block[]): Block[] => {
  const blocks = existingBlocks ?? []
  if (blocks.length === 0) {
    blocks.push(createBlock({ header: { gasLimit: 8000000n } }))
  }
  for (let i = blocks.length; i < numberOfBlocks; i++) {
    blocks.push(generateConsecutiveBlock(blocks[i - 1]))
  }
  return blocks
}

export const generateBlockchain = async (numberOfBlocks: number, genesis?: Block) => {
  const blocks = generateBlocks(numberOfBlocks, genesis ? [genesis] : [])
  const blockchain = await createBlockchain({
    common: blocks[0].common,
    validateBlocks: true,
    genesisBlock: blocks[0],
  })
  await blockchain.putBlocks(blocks.slice(1))
  return { blockchain, blocks, error: null }
}

export const generateConsecutiveBlock = (
  parentBlock: Block,
  timestampOffset = 1,
  gasLimit = parentBlock.header.gasLimit,
): Block =>
  createBlock(
    {
      header: {
        number: parentBlock.header.number + 1n,
        parentHash: parentBlock.hash(),
        gasLimit,
        timestamp: parentBlock.header.timestamp + BigInt(timestampOffset),
        baseFeePerGas: parentBlock.header.calcNextBaseFee(),
      },
    },
    { common: parentBlock.common },
  )

export const isConsecutive = (blocks: Block[]) =>
  !blocks.some(
    (block, index) => index > 0 && !equalsBytes(block.header.parentHash, blocks[index - 1].hash()),
  )

export const createTestDB = async (): Promise<
  [DB<string | Uint8Array, string | Uint8Array>, Block]
> => {
  const genesis = createBlock({ header: { number: 0, difficulty: 0n } })
  const hash = bytesToUnprefixedHex(genesis.hash())
  const db = new MapDB<any, any>()
  // Populate the fixed database layout using this fixture's actual hash, not an Ethereum genesis hash.
  await db.batch([
    { type: 'put', key: hexToBytes('0x6800000000000000006e'), value: genesis.hash() },
    { type: 'put', key: hexToBytes(`0x48${hash}`), value: new Uint8Array(8) },
    { type: 'put', key: 'LastHeader', value: genesis.hash() },
    { type: 'put', key: 'LastBlock', value: genesis.hash() },
    {
      type: 'put',
      key: hexToBytes(`0x680000000000000000${hash}`),
      value: genesis.header.serialize(),
    },
    {
      type: 'put',
      key: hexToBytes(`0x680000000000000000${hash}74`),
      value: RLP.encode(toBytes(genesis.header.difficulty)),
    },
    {
      type: 'put',
      key: hexToBytes(`0x620000000000000000${hash}`),
      value: RLP.encode(genesis.raw().slice(1)),
    },
    { type: 'put', key: 'heads', value: { head0: 'abcd' } },
  ])
  return [db, genesis]
}

export function generateBlock(
  parentBlock: Block,
  extraData: string,
  uncles: BlockHeader[] = [],
  common = parentBlock.common,
): Block {
  if (extraData.length > 32) throw new Error('extra data graffiti must be 32 bytes or less')
  return createBlock(
    {
      header: {
        number: parentBlock.header.number + 1n,
        parentHash: parentBlock.hash(),
        timestamp: parentBlock.header.timestamp + 1n,
        gasLimit: parentBlock.header.gasLimit,
        extraData: utf8ToBytes(extraData),
        uncleHash: keccak_256(RLP.encode(uncles.map((uh) => uh.raw()))),
        baseFeePerGas: parentBlock.header.calcNextBaseFee(),
      },
      uncleHeaders: uncles,
    },
    {
      common,
      calcDifficultyFromHeader:
        common.hasConsensus() && common.consensusAlgorithm() === ConsensusAlgorithm.Ethash
          ? parentBlock.header
          : undefined,
    },
  )
}
