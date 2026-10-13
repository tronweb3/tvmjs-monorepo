import { EthereumJSErrorWithoutCode } from '@tvmjs/util'

/** Validate caller-supplied block contexts before events or state changes. */
export function validateBlockContext(header: object) {
  for (const field of ['blobGasUsed', 'excessBlobGas', 'getBlobGasPrice']) {
    if (field in header) {
      throw EthereumJSErrorWithoutCode(`Blob block context field ${field} is no longer supported`)
    }
  }
  for (const field of ['parentBeaconBlockRoot', 'parent_beacon_block_root']) {
    if (field in header) {
      throw EthereumJSErrorWithoutCode(
        `Beacon root block context field ${field} is no longer supported`,
      )
    }
  }
}
