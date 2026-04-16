import { createBlock } from '@tvmjs/block'
import { Common, Mainnet } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import { Account, bytesToHex, createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'
import { buildBlock, createVM } from '@tvmjs/vm'

const main = async () => {
  const common = new Common({ chain: Mainnet })
  const vm = await createVM({ common })

  const parentBlock = createBlock(
    { header: { number: 1n } },
    { skipConsensusFormatValidation: true },
  )
  const headerData = {
    number: 2n,
  }
  const blockBuilder = await buildBlock(vm, {
    parentBlock, // the parent @ethereumjs/block Block
    headerData, // header values for the new block
    blockOpts: {
      calcDifficultyFromHeader: parentBlock.header,
      freeze: false,
      skipConsensusFormatValidation: true,
      putBlockIntoBlockchain: false,
    },
  })

  const pk = hexToBytes('0x26f81cbcffd3d23eace0bb4eac5274bb2f576d310ee85318b5428bf9a71fc89a')
  const address = createAddressFromPrivateKey(pk)
  const account = new Account(0n, 0xfffffffffn)
  await vm.stateManager.putAccount(address, account) // create a sending account and give it a big balance
  const tx = createLegacyTx({ gasLimit: 0xffffff, gasPrice: 75n }).sign(pk)
  await blockBuilder.addTransaction(tx)

  // Add more transactions

  const { block } = await blockBuilder.build()
  console.log(`Built a block with hash ${bytesToHex(block.hash())}`)
}

void main()
