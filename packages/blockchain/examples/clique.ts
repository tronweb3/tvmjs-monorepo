import { createBlock } from '@tvmjs/block'
import { CliqueConsensus, createBlockchain } from '@tvmjs/blockchain'
import { Common, ConsensusAlgorithm, ConsensusType, TronMainnet } from '@tvmjs/common'
import { concatBytes, createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'

// Explicit local metadata for the retained consensus extension, not TRON DPoS.
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
const signer = createAddressFromPrivateKey(hexToBytes(`0x${'20'.repeat(32)}`))
const genesisBlock = createBlock(
  {
    header: {
      gasLimit: 1000000n,
      extraData: concatBytes(new Uint8Array(32), signer.toBytes(), new Uint8Array(65)),
    },
  },
  { common },
)
const blockchain = await createBlockchain({
  common,
  genesisBlock,
  consensusDict: { clique: new CliqueConsensus() },
  validateConsensus: true,
})
console.log(`Created local chain with ${blockchain.consensus!.algorithm} consensus`)
