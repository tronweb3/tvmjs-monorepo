import { createBlock } from '@tvmjs/block'
import { Common, Hardfork } from '@tvmjs/common'
import { goerliChainConfig } from '@tvmjs/testdata'

const common = new Common({ chain: goerliChainConfig, hardfork: Hardfork.Chainstart })

console.log(common.consensusType()) // 'poa'
console.log(common.consensusAlgorithm()) // 'clique'

createBlock({ header: { extraData: new Uint8Array(97) } }, { common })
console.log(`Old Clique Proof-of-Authority block created`)
