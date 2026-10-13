import { describe, expect, it } from 'vitest'

import { Common, TronMainnet, TronNile, TronShasta } from '../src/index.ts'

describe.each([TronMainnet, TronNile, TronShasta])(
  'TRON contract limit removal on $name',
  (chain) => {
    for (const activatedProposals of [[], [95], [96], [95, 96]]) {
      for (const eips of [[], [7939]]) {
        it(`rejects limits with proposals [${activatedProposals}] and EIPs [${eips}]`, () => {
          const common = new Common({ chain, activatedProposals, eips })
          const before = common.copy()
          for (const eip of [170, 3860]) {
            expect(() => new Common({ chain, activatedProposals, eips: [...eips, eip] })).toThrow(
              /not supported by the TRON execution profile/,
            )
            expect(common.isActivatedEIP(eip)).toBe(false)
            expect(() => common.setEIPs([...eips, eip])).toThrow(/not supported/)
          }
          for (const name of ['maxInitCodeSize', 'initCodeWordGas']) {
            expect(() => common.paramByEIP(name, 3860)).toThrow(/not supported/)
          }
          expect(() => common.paramByEIP('maxCodeSize', 170)).toThrow(/not supported/)
          expect(common.isActivatedEIP(607)).toBe(true)
          expect(common.isCompatibleWith(before)).toBe(true)
        })
      }
    }
  },
)
