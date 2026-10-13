import { describe, expect, it } from 'vitest'

import { createBlock, ethashCanonicalDifficulty } from '../src/index.ts'
import { powCommon } from './helpers.ts'

describe('Retained explicit Ethash difficulty tool', () => {
  // Fixed cases for the retained formula; Ethereum multi-Hardfork runners are retired.
  it.each([
    { parent: 131072n, time: 12n, number: 1n, expected: 131136n },
    { parent: 131072n, time: 13n, number: 1n, expected: 131072n },
    { parent: 262144n, time: 13n, number: 1n, expected: 262016n },
    { parent: 131072n, time: 1n, number: 200000n, expected: 131137n },
    { parent: 131072n, time: 1n, number: 300000n, expected: 131138n },
  ])(
    'calculates $expected at height $number and elapsed time $time',
    ({ parent, time, number, expected }) => {
      const common = powCommon()
      const parentBlock = createBlock({ header: { difficulty: parent } }, { common })
      const block = createBlock({ header: { number, timestamp: time } }, { common })
      expect(block.header.ethashCanonicalDifficulty(parentBlock.header)).toBe(expected)
      expect(ethashCanonicalDifficulty(block, parentBlock)).toBe(expected)
    },
  )

  it('requires explicit consensus metadata', () => {
    const parent = createBlock()
    const block = createBlock({ header: { number: 1n } })
    expect(() => block.header.ethashCanonicalDifficulty(parent.header)).toThrow()
  })
})
