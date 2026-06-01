import { Mainnet, createCustomCommon } from '@tvmjs/common'
import { customChainConfig } from '@tvmjs/testdata'

// Add custom chain config
const common1 = createCustomCommon(customChainConfig, Mainnet)
console.log(`Common is instantiated with custom chain parameters - ${common1.chainName()}`)
