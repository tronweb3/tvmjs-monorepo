import { createBlockchain } from '@tvmjs/blockchain'
import { createCommonFromGethGenesis, parseGethGenesisState } from '@tvmjs/common'
import { postMergeGethGenesis } from '@tvmjs/testdata'
import { bytesToHex } from '@tvmjs/util'

const main = async () => {
  // Load geth genesis file
  const common = createCommonFromGethGenesis(postMergeGethGenesis, { chain: 'customChain' })
  const genesisState = parseGethGenesisState(postMergeGethGenesis)
  const blockchain = await createBlockchain({
    genesisState,
    common,
  })
  const genesisBlockHash = blockchain.genesisBlock.hash()
  common.setForkHashes(genesisBlockHash)
  console.log(
    `Genesis hash from geth genesis parameters - ${bytesToHex(blockchain.genesisBlock.hash())}`,
  )
}

void main()
