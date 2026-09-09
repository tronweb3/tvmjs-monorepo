import { createTronChainIdCommon } from '@tvmjs/common'
import { createLegacyTx, createLegacyTxFromRLP } from '@tvmjs/tx'
import { bytesToHex, createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'

const common = createTronChainIdCommon('nile')
const privateKey = hexToBytes('0x46b9e86af35a6a1e153b5655b7bb77645b3e7d12057526428653ba7db66c5b89')
const expectedSender = createAddressFromPrivateKey(privateKey)

const signedTx = createLegacyTx(
  {
    nonce: 0,
    gasPrice: 10,
    gasLimit: 21_000,
    to: '0x2d18de92e0f9aee1a29770c3b15c6cf8ac5498e5',
    value: 1,
  },
  { common },
).sign(privateKey)

const serialized = signedTx.serialize()
const decodedTx = createLegacyTxFromRLP(serialized, { common })

if (decodedTx.common.chainId() !== 3448148188n) {
  throw new Error(`Unexpected Nile chainId: ${decodedTx.common.chainId()}`)
}
if (decodedTx.raw().length !== 11) {
  throw new Error(`Expected 11 TRON legacy transaction fields, got ${decodedTx.raw().length}`)
}
if (!decodedTx.isValid() || !decodedTx.getSenderAddress().equals(expectedSender)) {
  throw new Error('TRON Nile transaction failed validation')
}

console.log(`Correctly decoded TRON Nile transaction with chainId ${common.chainId()}`)
console.log(`Sender: ${expectedSender}`)
console.log(`Serialized: ${bytesToHex(serialized)}`)
