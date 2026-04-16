import { createBlock } from '@tvmjs/block'
import { Common } from '@tvmjs/common'
import { goerliBlocks, goerliChainConfig } from '@tvmjs/testdata'
import { bytesToHex } from '@tvmjs/util'
import { createVM, runBlock } from '@tvmjs/vm'

const main = async () => {
  const common = new Common({ chain: goerliChainConfig, hardfork: 'london' })
  const vm = await createVM({ common })

  const block = createBlock(goerliBlocks[0], { common })
  const result = await runBlock(vm, { block, generate: true, skipHeaderValidation: true }) // we skip header validation since we are running a block without the full Ethereum history available
  console.log(`The state root for the block is ${bytesToHex(result.stateRoot)}`)
}

void main()
