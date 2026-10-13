import { createBlock } from '@tvmjs/block'
import { createBlockchain } from '@tvmjs/blockchain'
import { Common, TronMainnet } from '@tvmjs/common'
import { bytesToHex } from '@tvmjs/util'

const common = new Common({ chain: TronMainnet })
// An explicit local genesis, not the network's canonical genesis block.
const genesisBlock = createBlock({ header: { gasLimit: 1000000n } }, { common })
const blockchain = await createBlockchain({ common, genesisBlock, validateBlocks: true })

let parent = genesisBlock
for (let height = 1n; height <= 2n; height++) {
  const block = createBlock(
    {
      header: {
        number: height,
        parentHash: parent.hash(),
        timestamp: parent.header.timestamp + 1n,
        gasLimit: parent.header.gasLimit,
        baseFeePerGas: parent.header.calcNextBaseFee(),
      },
    },
    { common },
  )
  await blockchain.putBlock(block)
  parent = block
}

await blockchain.iterator('example', (block) => {
  console.log(`Block ${block.header.number}: ${bytesToHex(block.hash())}`)
})
