import { cliqueSigner, createSealedCliqueBlock } from '@tvmjs/block'
import { Common, ConsensusAlgorithm, ConsensusType, TronMainnet } from '@tvmjs/common'
import { hexToBytes } from '@tvmjs/util'

// Explicit local metadata for the retained Clique tool, not TRON network consensus.
const common = new Common({
  chain: {
    ...TronMainnet,
    consensus: {
      type: ConsensusType.ProofOfAuthority,
      algorithm: ConsensusAlgorithm.Clique,
      clique: { period: 15, epoch: 30000 },
    },
  },
})
const exampleKey = hexToBytes(`0x${'20'.repeat(32)}`)
const block = createSealedCliqueBlock(
  { header: { number: 1n, extraData: new Uint8Array(97) } },
  exampleKey,
  { common },
)
console.log(`Recovered local signer: ${cliqueSigner(block.header)}`)
