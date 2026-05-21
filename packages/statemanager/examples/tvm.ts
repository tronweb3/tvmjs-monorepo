import { RPCBlockChain, RPCStateManager } from '@tvmjs/statemanager'
import { createTVM } from '@tvmjs/tvm'

const main = async () => {
  try {
    const provider = 'https://path.to.my.provider.com'
    const blockchain = new RPCBlockChain(provider)
    const blockTag = 1n
    const state = new RPCStateManager({ provider, blockTag })
    const tvm = await createTVM({ blockchain, stateManager: state }) // note that tvm is ready to run BLOCKHASH opcodes (over RPC)
  } catch (e) {
    console.log(e.message) // fetch would fail because provider url is not real. please replace provider with a valid RPC url string.
  }
}
void main()
