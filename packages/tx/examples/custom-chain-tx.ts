import { TronMainnet, createCustomCommon } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import { createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'

// Create a signed transaction for a local TRON execution simulation.

// Only the name and chainId change; the TRON execution profile is preserved.
const customCommon = createCustomCommon(
  {
    name: 'private-tron',
    chainId: 2134,
  },
  TronMainnet,
)

// We pass our custom Common object whenever we create a transaction
const opts = { common: customCommon }
const tx = createLegacyTx(
  {
    nonce: 0,
    gasPrice: 100,
    gasLimit: 1000000000,
    value: 100000,
  },
  opts,
)

// Once we created the transaction using the custom Common object, we can use it as a normal tx.

// Here we sign it and validate its signature
// WARNING: The private key in this example is for demonstration only. Never use in production.
const privateKey = hexToBytes('0xe331b6d69882b4cb4ea581d88e0b604039a3de5967688d3dcffdd2270c0fd109')

const signedTx = tx.sign(privateKey)
const address = createAddressFromPrivateKey(privateKey)

if (signedTx.isValid() && signedTx.getSenderAddress().equals(address)) {
  console.log('Valid signature')
} else {
  console.log('Invalid signature')
}

console.log("The transaction's chain id is: ", signedTx.common.chainId().toString())
