import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { Address, bytesToBigInt, createZeroAddress, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createTVM, getActivePrecompiles } from '../../src/index.ts'
import { precompile0a } from '../../src/precompiles/0a-validate-multi-sign.ts'
import { precompile09 } from '../../src/precompiles/09-batch-validate-sign.ts'

const TRON_PRECOMPILE_ADDRESSES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) =>
  id.toString(16).padStart(40, '0'),
)

describe('Precompiles: TRON profile availability', () => {
  for (const chain of [TronMainnet, TronNile, TronShasta]) {
    it(`${chain.name}: does not expose the retired alternate precompile addresses`, async () => {
      const common = new Common({ chain })
      const tvm = await createTVM({ common })
      const active = getActivePrecompiles(common)
      assert.isFalse(active.has('0000000000000000000000000000000000020003'))
      assert.isFalse(active.has('0000000000000000000000000000000000020009'))
      assert.strictEqual(
        tvm.precompiles.get('0000000000000000000000000000000000000009'),
        precompile09,
      )
      assert.strictEqual(
        tvm.precompiles.get('000000000000000000000000000000000000000a'),
        precompile0a,
      )
    })
    it(`${chain.name}: keeps the precompile set across supported proposals and optional EIPs`, () => {
      for (const activatedProposals of [[], [95], [96], [95, 96]]) {
        for (const eips of [[], [7939]]) {
          const common = new Common({ chain, activatedProposals, eips })
          assert.sameMembers([...getActivePrecompiles(common).keys()], TRON_PRECOMPILE_ADDRESSES)
        }
      }
    })

    it(`${chain.name}: executes BN254 pairing with the current TRON profile gas`, async () => {
      const tvm = await createTVM({ common: new Common({ chain }) })
      const result = await tvm.runCall({
        caller: createZeroAddress(),
        gasLimit: 100000n,
        to: new Address(hexToBytes('0x0000000000000000000000000000000000000008')),
      })

      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.executionGasUsed, 45000n)
      assert.lengthOf(result.execResult.returnValue, 32)
      assert.strictEqual(bytesToBigInt(result.execResult.returnValue), 1n)
    })
  }
})
