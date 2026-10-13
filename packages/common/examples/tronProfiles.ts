import { createTronChainIdCommon } from '@tvmjs/common'

for (const network of ['mainnet', 'nile', 'shasta'] as const) {
  const common = createTronChainIdCommon(network)
  console.log(`${common.chainName()}: chainId=${common.chainId()}, profile=${common.hardfork()}`)
  console.log(
    `Genesis metadata: ${common.hasGenesis()}, consensus metadata: ${common.hasConsensus()}`,
  )
}
