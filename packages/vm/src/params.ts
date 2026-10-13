import type { ParamsDict } from '@tvmjs/common'
import { SYSTEM_ADDRESS } from '@tvmjs/util'

export const paramsVM: ParamsDict = {
  /**
   * Frontier/Chainstart
   */
  1: {
    // gasConfig
    maxRefundQuotient: 2,
    // pow
    minerReward: '5000000000000000000', // the amount a miner get rewarded for mining a block
  },
  /**
.  * Byzantium HF Meta EIP
.  */
  609: {
    // pow
    minerReward: '3000000000000000000', // the amount a miner get rewarded for mining a block
  },
  /**
.  * Constantinople HF Meta EIP
.  */
  1013: {
    // pow
    minerReward: '2000000000000000000', // The amount a miner gets rewarded for mining a block
  },
  /**
.  * Fee market change for ETH 1.0 chain
.  */
  1559: {
    // gasConfig
    elasticityMultiplier: 2, // Maximum block gas target elasticity
    initialBaseFee: 1000000000, // Initial base fee on first EIP1559 block
  },
  /**
   * Save historical block hashes in state (Verkle related usage, UNSTABLE)
   */
  2935: {
    // config
    historyStorageAddress: '0x0000F90827F1C53A10CB7A02335B175320002935', // The address where the historical blockhashes are stored
    historyServeWindow: 8191, // The amount of blocks to be served by the historical blockhash contract
    systemAddress: SYSTEM_ADDRESS, // The system address
  },
  /**
.  * Reduction in refunds
.  */
  3529: {
    // gasConfig
    maxRefundQuotient: 5, // Maximum refund quotient; max tx refund is min(tx.gasUsed/maxRefundQuotient, tx.gasRefund)
  },
  /**
   * Execution layer triggerable withdrawals (experimental)
   */
  7002: {
    // config
    systemAddress: SYSTEM_ADDRESS, // The system address to perform operations on the withdrawal requests predeploy address
    // See: https://github.com/ethereum/EIPs/pull/8934/files
    withdrawalRequestPredeployAddress: '0x00000961EF480EB55E80D19AD83579A64C007002', // Address of the validator excess address
    systemCallGasLimit: 30_000_000, // EIP-7002 system call gas limit
  },

  /**
   * Increase the MAX_EFFECTIVE_BALANCE -> Execution layer triggered consolidations (experimental)
   */
  7251: {
    // config
    systemAddress: SYSTEM_ADDRESS, // The system address to perform operations on the consolidation requests predeploy address
    // See: https://github.com/ethereum/EIPs/pull/8934/files
    consolidationRequestPredeployAddress: '0x0000BBDDC7CE488642FB579F8B00F3A590007251', // Address of the consolidations contract
    systemCallGasLimit: 30_000_000, // EIP-7251 system call gas limit
  },
}
