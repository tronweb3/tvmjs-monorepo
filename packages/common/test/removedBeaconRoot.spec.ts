import { describe, expect, it } from 'vitest'

import { Common, TronMainnet, TronNile, TronShasta } from '../src/index.ts'

describe.each([TronMainnet, TronNile, TronShasta])('Beacon root removal on $name', (chain) => {
  it('rejects EIP-4788 without changing the active TRON configuration', () => {
    expect(() => new Common({ chain, eips: [4788] })).toThrow(/not supported/)
    const common = new Common({ chain, eips: [7939], activatedProposals: [95, 96] })
    const before = common.copy()

    expect(() => common.setEIPs([7939, 4788])).toThrow(/not supported/)
    expect(() => common.paramByEIP('historicalRootsLength', 4788)).toThrow(/not supported/)
    expect(common.isActivatedEIP(4788)).toBe(false)
    expect(common.isActivatedEIP(7939)).toBe(true)
    expect(common.eips()).toEqual([7939])
    expect(common.isCompatibleWith(before)).toBe(true)
  })
})
