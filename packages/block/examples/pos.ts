import { createBlock } from '@tvmjs/block'
import { Common, Mainnet } from '@tvmjs/common'

const common = new Common({ chain: Mainnet })

const block = createBlock(
  {
    // Provide your block data here or use default values
  },
  { common },
)

console.log(`Proof-of-Stake (default) block created with hardfork=${block.common.hardfork()}`)
