import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet } from '@tvmjs/common'

const common = new Common({ chain: TronMainnet })
// Base fee is retained execution-container metadata, not a TRON resource price model.
const parent = createBlock(
  { header: { baseFeePerGas: 10n, gasLimit: 1000000n, gasUsed: 600000n } },
  { common },
)
const block = createBlock(
  {
    header: {
      number: 1n,
      parentHash: parent.hash(),
      timestamp: parent.header.timestamp + 1n,
      baseFeePerGas: parent.header.calcNextBaseFee(),
      gasLimit: parent.header.gasLimit,
    },
  },
  { common },
)
console.log(block.header.baseFeePerGas) // 11n
await block.validateData()
block.validateGasLimit(parent)
