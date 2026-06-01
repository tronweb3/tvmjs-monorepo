import { trustedSetup } from '@paulmillr/trusted-setups/fast-peerdas.js'
import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { KZG as microEthKZG } from 'micro-eth-signer/kzg.js'

const main = async () => {
  const kzg = new microEthKZG(trustedSetup)
  // Instantiate `common`
  const common = new Common({
    chain: Mainnet,
    hardfork: Hardfork.Cancun,
    customCrypto: { kzg },
  })

  console.log(common.customCrypto.kzg) // should output the KZG API as an object
}

void main()
