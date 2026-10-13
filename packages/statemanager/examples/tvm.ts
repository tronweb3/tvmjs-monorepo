import { Common, TronMainnet } from '@tvmjs/common'
import { RPCBlockChain, RPCStateManager } from '@tvmjs/statemanager'
import { createTVM } from '@tvmjs/tvm'

const main = async () => {
  const provider = process.env.PROVIDER ?? 'http://localhost:8545'
  const common = new Common({ chain: TronMainnet })
  const blockchain = new RPCBlockChain(provider)
  const blockTag = 1n
  const state = new RPCStateManager({ common, provider, blockTag })
  const tvm = await createTVM({ common, blockchain, stateManager: state })
  // Initialization is local. Execution needs the matching block context and a compatible provider.
  console.log('Configured TVM chainId:', tvm.common.chainId())
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
