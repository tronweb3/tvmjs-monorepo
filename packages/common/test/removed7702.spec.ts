import { describe, expect, it } from 'vitest'

import { Common, TronMainnet, TronNile, TronShasta } from '../src/index.ts'

describe.each([TronMainnet, TronNile, TronShasta])('EIP-7702 removal on $name', (chain) => {
  it('rejects authorization activation and parameters without changing the TRON profile', () => {
    expect(() => new Common({ chain, eips: [7702] })).toThrow(/not supported/)
    const common = new Common({ chain, eips: [7939], activatedProposals: [95, 96] })
    const before = common.copy()
    expect(() => common.setEIPs([7939, 7702])).toThrow(/not supported/)
    for (const param of ['perAuthBaseGas', 'perEmptyAccountCost']) {
      expect(() => common.paramByEIP(param, 7702)).toThrow(/not supported/)
    }
    expect(common.isActivatedEIP(7702)).toBe(false)
    expect(common.isCompatibleWith(before)).toBe(true)
  })
})
