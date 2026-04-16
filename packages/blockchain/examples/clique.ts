import { CliqueConsensus, createBlockchain } from '@tvmjs/blockchain'
import { Common, ConsensusAlgorithm, Hardfork } from '@tvmjs/common'
import { goerliChainConfig } from '@tvmjs/testdata'

import type { ConsensusDict } from '@tvmjs/blockchain'

const common = new Common({ chain: goerliChainConfig, hardfork: Hardfork.London })

const consensusDict: ConsensusDict = {}
consensusDict[ConsensusAlgorithm.Clique] = new CliqueConsensus()
const blockchain = await createBlockchain({
  consensusDict,
  common,
})
console.log(`Created blockchain with ${blockchain.consensus!.algorithm} consensus algorithm`)
