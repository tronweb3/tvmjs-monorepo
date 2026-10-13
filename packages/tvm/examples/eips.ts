import { Common, Hardfork, TronMainnet } from '@tvmjs/common'
import { createTVM } from '@tvmjs/tvm'

const main = async () => {
  const common = new Common({ chain: TronMainnet, hardfork: Hardfork.Tron, eips: [7939] })
  const tvm = await createTVM({ common })
  console.log(`CLZ is explicitly active on the TRON profile - ${tvm.common.isActivatedEIP(7939)}`)
}

void main()
