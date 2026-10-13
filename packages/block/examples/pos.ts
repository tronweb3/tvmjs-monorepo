import { createBlock } from '@tvmjs/block'
import { Common, ConsensusAlgorithm, ConsensusType, TronMainnet } from '@tvmjs/common'

// Explicit local metadata for retained PoS format checks, not a default TRON preset.
const common = new Common({
  chain: {
    ...TronMainnet,
    consensus: { type: ConsensusType.ProofOfStake, algorithm: ConsensusAlgorithm.Casper },
  },
})
const block = createBlock({ header: { number: 1n } }, { common })
console.log(block.header.difficulty) // 0n
console.log(block.common.isActivatedEIP(4399)) // false: metadata does not enable Ethereum EIPs
