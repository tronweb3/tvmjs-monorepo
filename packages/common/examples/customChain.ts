import { TronMainnet, createCustomCommon } from '@tvmjs/common'

const common = createCustomCommon({ name: 'private-tron', chainId: 123 }, TronMainnet)
console.log(`Custom TRON network: ${common.chainName()}, chainId: ${common.chainId()}`)
