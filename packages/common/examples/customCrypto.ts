import { keccak256, waitReady } from '@polkadot/wasm-crypto'
import { createBlock } from '@tvmjs/block'
import { Common, Mainnet } from '@tvmjs/common'

const main = async () => {
  // @polkadot/wasm-crypto specific initialization
  await waitReady()

  const common = new Common({ chain: Mainnet, customCrypto: { keccak256 } })
  const block = createBlock({}, { common })

  // Method invocations within EthereumJS library instantiations where the common
  // instance above is passed will now use the custom keccak_256 implementation
  console.log(block.hash())
}

void main()
