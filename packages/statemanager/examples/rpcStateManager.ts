import { Common, TronMainnet } from '@tvmjs/common'
import { RPCStateManager } from '@tvmjs/statemanager'
import { createAddressFromString } from '@tvmjs/util'

const main = async () => {
  const provider = process.env.PROVIDER
  if (provider === undefined) {
    console.log('Set PROVIDER to an RPC URL supporting eth_getProof to read an account.')
    return
  }
  // The provider must support EIP-1186; a TRON Common does not add java-tron RPC support.
  const common = new Common({ chain: TronMainnet })
  const stateManager = new RPCStateManager({ common, provider, blockTag: 500000n })
  const address = createAddressFromString('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
  const account = await stateManager.getAccount(address)
  console.log('Provider account balance at block 500000:', account?.balance)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
