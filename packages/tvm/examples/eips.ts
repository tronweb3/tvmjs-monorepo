import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { createTVM } from '@tvmjs/tvm'

const main = async () => {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun, eips: [7702] })
  const tvm = await createTVM({ common })
  console.log(
    `EIP 7702 is active in isolation on top of the Cancun HF - ${tvm.common.isActivatedEIP(7702)}`,
  )
}

void main()
