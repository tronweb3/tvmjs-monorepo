import { createBlock } from '@tvmjs/block'
import { Common, ConsensusAlgorithm, ConsensusType, TronMainnet } from '@tvmjs/common'

// Explicit local metadata for the retained PoW tool, not TRON network consensus.
const common = new Common({
  chain: {
    ...TronMainnet,
    consensus: { type: ConsensusType.ProofOfWork, algorithm: ConsensusAlgorithm.Ethash },
  },
})
const parent = createBlock({ header: { difficulty: 131072n } }, { common })
const block = createBlock(
  { header: { number: 1n, timestamp: 10n } },
  { common, calcDifficultyFromHeader: parent.header },
)
console.log(block.header.difficulty) // 131136n
