import { Common, Hardfork, TronMainnet } from '@tvmjs/common'
import { createVM } from '@tvmjs/vm'

const main = async () => {
  const common = new Common({ chain: TronMainnet, hardfork: Hardfork.Tron, eips: [7939] })
  const vm = await createVM({ common })
  console.log(`CLZ is explicitly active on the TRON profile - ${vm.common.isActivatedEIP(7939)}`)
}
void main()
