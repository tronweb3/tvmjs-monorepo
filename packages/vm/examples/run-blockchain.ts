import { createBlock } from '@tvmjs/block'
import { createBlockchain } from '@tvmjs/blockchain'
import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import {
  Account,
  bytesToHex,
  createAddressFromPrivateKey,
  createAddressFromString,
  equalsBytes,
  hexToBytes,
} from '@tvmjs/util'
import { createVM, runBlock } from '@tvmjs/vm'

const main = async () => {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Berlin })
  const blockchain = await createBlockchain({
    common,
    validateBlocks: false,
    validateConsensus: false,
  })
  const vm = await createVM({ blockchain, common })

  const privateKey = hexToBytes(
    '0x46b9e86af35a6a1e153b5655b7bb77645b3e7d12057526428653ba7db66c5b89',
  )
  const sender = createAddressFromPrivateKey(privateKey)
  const receiver = createAddressFromString('0x00000000000000000000000000000000000000ff')
  await vm.stateManager.putAccount(sender, new Account(0n, 1_000_000n))

  const tx = createLegacyTx(
    {
      nonce: 0,
      gasPrice: 10,
      gasLimit: 21_000,
      to: receiver,
      value: 1,
    },
    { common },
  ).sign(privateKey)

  const block = createBlock(
    {
      header: {
        number: 1,
        parentHash: blockchain.genesisBlock.hash(),
        difficulty: blockchain.genesisBlock.header.difficulty + 1n,
        gasLimit: 30_000_000,
        timestamp: blockchain.genesisBlock.header.timestamp + 1n,
      },
      transactions: [tx],
    },
    { common },
  )

  const result = await runBlock(vm, {
    block,
    generate: true,
    skipBlockValidation: true,
    skipHardForkValidation: true,
  })

  if (result.results.length !== 1 || result.results[0].execResult.exceptionError !== undefined) {
    throw new Error('Block transaction execution failed')
  }

  const receiverAccount = await vm.stateManager.getAccount(receiver)
  if (receiverAccount?.balance !== 1n) {
    throw new Error(`Unexpected receiver balance: ${receiverAccount?.balance}`)
  }

  await blockchain.putBlock(block)
  const head = await blockchain.getCanonicalHeadBlock()
  if (!equalsBytes(head.hash(), block.hash())) {
    throw new Error('Canonical head does not match the inserted block')
  }

  console.log('--- Finished processing the blockchain ---')
  console.log(`Executed transactions: ${result.results.length}`)
  console.log(`Receiver balance: ${receiverAccount.balance}`)
  console.log(`Canonical head: ${bytesToHex(head.hash())}`)
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
