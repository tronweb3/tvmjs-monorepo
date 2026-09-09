import { trustedSetup } from '@paulmillr/trusted-setups/fast-peerdas.js'
import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import type { BlobEIP4844TxData } from '@tvmjs/tx'
import { createBlob4844Tx } from '@tvmjs/tx'
import { bytesToHex, getBlobs } from '@tvmjs/util'
import { KZG as microEthKZG } from 'micro-eth-signer/kzg.js'

const main = async () => {
  const kzg = new microEthKZG(trustedSetup)
  const common = new Common({
    chain: Mainnet,
    hardfork: Hardfork.Cancun,
    customCrypto: { kzg },
  })

  console.log('\nBlob transaction (EIP-4844):')
  console.log('---------------------------------------')

  const blobsData = ['blob 1', 'blob 2', 'blob 3']
  console.log(`Blobs (Data) : "${blobsData.join('", "')}"`)
  const blobs = getBlobs(blobsData)

  console.log('Generating tx...')

  const txData: BlobEIP4844TxData = {
    data: '0x1a8451e600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    gasLimit: 16_000_000n,
    maxPriorityFeePerGas: '0x01',
    maxFeePerGas: '0xff',
    maxFeePerBlobGas: '0xfff',
    nonce: '0x00',
    to: '0xcccccccccccccccccccccccccccccccccccccccc',
    value: '0x0186a0',
    v: '0x01',
    r: '0xafb6e247b1c490e284053c87ab5f6b59e219d51f743f7a4d83e400782bc7e4b9',
    s: '0x479a268e0e0acd4de3f1e28e4fac2a6b32a4195e8dfa9d19147abe8807aa6f64',
    chainId: '0x01',
    accessList: [],
    type: '0x05',
    blobs,
  }

  const tx = createBlob4844Tx(txData, { common })

  console.log(`Tx hash               : ${bytesToHex(tx.hash())}`)
  console.log(`Num blobs             : ${tx.numBlobs()}`)
  console.log(`Blob versioned hashes : ${tx.blobVersionedHashes.join(', ')}`)
  console.log(`KZG commitments       : ${tx.kzgCommitments!.join(', ')}`)
  console.log(`First KZG proof       : ${tx.kzgProofs![0]}`)
  console.log(`Num KZG proofs        : ${tx.kzgProofs!.length} (one proof per blob)`)

  // To send a transaction via RPC, you can something like this:
  // const rawTx = tx.sign(privateKeyBytes).serializeNetworkWrapper()
  // myRPCClient.request('eth_sendRawTransaction', [rawTx]) // submits a transaction via RPC
  //
  // Also see ./sendRawSepoliaTx.ts example
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
