import { Common, Hardfork, Mainnet } from '@tvmjs/common'

export const getCommon = () => {
  return new Common({
    hardfork: Hardfork.Cancun,
    eips: [663, 3540, 3670, 4200, 4750, 5450, 6206, 7069, /* 7480, */ 7620, 7692, 7698],
    chain: Mainnet,
  })
}
