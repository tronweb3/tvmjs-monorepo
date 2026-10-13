import { Common, Hardfork, TronMainnet, createCustomCommon } from '@tvmjs/common'

const common = new Common({ chain: TronMainnet, hardfork: Hardfork.Tron })
console.log(`Network: ${common.chainName()}, chainId: ${common.chainId()}`)
console.log(`Execution profile: ${common.hardfork()}, TRON: ${common.isTron()}`)

// Execution presets do not provide genesis, consensus or discovery metadata.
console.log(`Genesis: ${common.hasGenesis()}, consensus: ${common.hasConsensus()}`)
console.log('Bootstrap nodes:', common.bootstrapNodes()) // []

// Explicitly activate the CLZ instruction
common.setEIPs([7939])
console.log(`CLZ is active -- ${common.isActivatedEIP(7939)}`)

// Instantiate common with custom chainID
const commonWithCustomChainId = createCustomCommon({ chainId: 1234 }, TronMainnet)
console.log(`The current chain ID is ${commonWithCustomChainId.chainId()}`)
