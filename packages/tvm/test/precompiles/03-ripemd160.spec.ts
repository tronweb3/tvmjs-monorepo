import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { bytesToHex, utf8ToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createTVM, getActivePrecompiles } from '../../src/index.ts'

const input = utf8ToBytes('test')
const expected = '0x165402a607b46bad4395cf6c0b22caa3b0aa26f922d79656b455e8fb544c4d7c'

describe('Precompiles: RIPEMD160', () => {
  it('RIPEMD160', async () => {
    // Test reference: https://github.com/ethereum/go-ethereum/blob/e206d3f8975bd98cc86d14055dca40f996bacc60/core/vm/contracts_test.go#L217

    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Petersburg })
    const tvm = await createTVM({
      common,
    })
    const addressStr = '0000000000000000000000000000000000000003'
    const RIPEMD160 = getActivePrecompiles(common).get(addressStr)!

    const data = input
    let result = await RIPEMD160({
      data,
      gasLimit: BigInt(0xffff),
      common,
      _TVM: tvm,
    })
    assert.deepEqual(bytesToHex(result.returnValue), expected, 'should generate expected value')

    result = await RIPEMD160({
      data,
      gasLimit: BigInt(0x1),
      common,
      _TVM: tvm,
    })
    assert.strictEqual(
      result.exceptionError!.error,
      'out of gas',
      'should error when not enough gas',
    )
  })
})
