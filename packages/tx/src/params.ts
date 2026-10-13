import type { ParamsDict } from '@tvmjs/common'

export const paramsTx: ParamsDict = {
  // Access lists remain serializable metadata and do not buy warm TRON accesses.
  tron: {
    accessListStorageKeyGas: 0,
    accessListAddressGas: 0,
  },
  /**
   * Frontier/Chainstart
   */
  1: {
    // gasPrices
    txGas: 21000, // Per transaction. NOTE: Not payable on data of calls between transactions
    txCreationGas: 32000, // The cost of creating a contract via tx
    txDataZeroGas: 4, // Per byte of data attached to a transaction that equals zero. NOTE: Not payable on data of calls between transactions
    txDataNonZeroGas: 68, // Per byte of data attached to a transaction that is not equal to zero. NOTE: Not payable on data of calls between transactions
    accessListStorageKeyGas: 0,
    accessListAddressGas: 0,
  },
  /**
.  * Istanbul HF Meta EIP
.  */
  1679: {
    // gasPrices
    txDataNonZeroGas: 16, // Per byte of data attached to a transaction that is not equal to zero. NOTE: Not payable on data of calls between transactions
  },
  /**
.  * Optional access lists
.  */
  2930: {
    // gasPrices
    accessListStorageKeyGas: 1900, // Gas cost per storage key in an Access List transaction
    accessListAddressGas: 2400, // Gas cost per storage key in an Access List transaction
  },
  /**
   * Increase calldata cost to reduce maximum block size
   */
  7623: {
    totalCostFloorPerToken: 10,
  },
  /**
   * Transaction Gas Limit Cap
   */
  7825: {
    maxTransactionGasLimit: 16777216, // Maximum gas limit for a single transaction (2^24)
  },
}
