import { Common, TronMainnet } from '@tvmjs/common'
import { assert, describe, it } from 'vitest'

import { createTVM, getActivePrecompiles } from '../../src/index.ts'

describe('Precompiles: BN254MUL', () => {
  it('BN254MUL', async () => {
    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({
      common,
    })
    const BN254MUL = getActivePrecompiles(common).get('0000000000000000000000000000000000000007')!

    const result = await BN254MUL({
      data: new Uint8Array(0),
      gasLimit: BigInt(0xffff),
      common,
      _TVM: tvm,
    })

    assert.deepEqual(
      result.executionGasUsed,
      6000n,
      'uses the TRON BN254 multiplication Energy cost',
    )
  })
})
