import { keccak256, waitReady } from '@polkadot/wasm-crypto'
import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet } from '@tvmjs/common'

const main = async () => {
  // @polkadot/wasm-crypto specific initialization
  await waitReady()

  const common = new Common({ chain: TronMainnet, customCrypto: { keccak256 } })
  const block = createBlock({}, { common })

  // Method invocations within TVMJS library instances where the common
  // instance above is passed will now use the custom keccak_256 implementation
  console.log(block.hash())
}

void main()
