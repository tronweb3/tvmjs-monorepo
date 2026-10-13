// This files contain examples on how to use this module.
// You can run them with tsx, as this project is developed in TypeScript.
// Install the dependencies and run `npx tsx examples/transactions.ts`

import { createLegacyTx, createLegacyTxFromBytesArray } from '@tvmjs/tx'
import { bytesToHex, randomBytes } from '@tvmjs/util'

// We create an unsigned transaction.
// Notice we don't set the `to` field because we are creating a new contract.
// This local execution envelope defaults to TronMainnet.
const tx = createLegacyTx({
  nonce: 0,
  gasPrice: 100,
  gasLimit: 1000000000,
  value: 0,
  data: '0x7f4e616d65526567000000000000000000000000000000000000000000000000003057307f4e616d6552656700000000000000000000000000000000000000000000000000573360455760415160566000396000f20036602259604556330e0f600f5933ff33560f601e5960003356576000335700604158600035560f602b590033560f60365960003356573360003557600035335700',
})

// We sign the transaction with a random private key (for illustration purposes).
const privateKey = randomBytes(32)

const signedTx = tx.sign(privateKey)

// We have a signed transaction.
// The local envelope's upfront cost is gasLimit * gasPrice + value.
// This helper does not model java-tron bandwidth, staking or Energy resource accounting.
const feeCost = signedTx.getUpfrontCost()
console.log('Local envelope upfront cost: ' + feeCost.toString())

// Lets serialize the transaction

console.log('---Serialized TX----')
console.log(bytesToHex(signedTx.serialize()))
console.log('--------------------')

// Parsing & Validating Transactions
// Legacy envelopes include tokenId and tokenValue in their eleven raw fields.
// They are TVMJS RLP containers, not native java-tron protobuf transactions.
const rawTx = signedTx.raw()

const tx2 = createLegacyTxFromBytesArray(rawTx)

// So assuming that you were able to parse the transaction, we will now get the sender's address.

console.log('Senders Address: ' + tx2.getSenderAddress().toString())

// Cool now we know who sent the tx!
// Let's verify the signature to make sure it was not some poser.

if (tx2.verifySignature()) {
  console.log('Signature Checks out!')
}

// And hopefully it's verified. For the transaction to be totally valid we would
// also need to check the account of the sender and see if they have enough funds.
