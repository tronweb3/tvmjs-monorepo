import { createBlockchain } from '@tvmjs/blockchain'
import { Common, TronMainnet, parseGethGenesisState } from '@tvmjs/common'
import { postMergeGethGenesis } from '@tvmjs/testdata'
import { bytesToHex } from '@tvmjs/util'

const main = async () => {
  // Import allocations as data; supply separate TRON execution configuration.
  const common = new Common({
    chain: {
      ...TronMainnet,
      name: 'local-genesis-example',
      // Local simulation metadata, not the TRON Mainnet genesis block.
      genesis: { gasLimit: 1000000, difficulty: 0, nonce: '0x0000000000000000', extraData: '0x' },
    },
  })
  const genesisState = parseGethGenesisState(postMergeGethGenesis)
  const blockchain = await createBlockchain({
    genesisState,
    common,
  })
  console.log(`Local genesis hash: ${bytesToHex(blockchain.genesisBlock.hash())}`)
}

void main()
