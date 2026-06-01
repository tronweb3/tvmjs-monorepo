import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { assert, describe, it } from 'vitest'

import { createTVM, getActivePrecompiles } from '../../src/index.ts'

describe('Precompiles: BN254ADD', () => {
  it('BN254ADD', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Petersburg })
    const tvm = await createTVM({
      common,
    })
    const addressStr = '0000000000000000000000000000000000000006'
    const BN254ADD = getActivePrecompiles(common).get(addressStr)!

    const result = await BN254ADD({
      data: new Uint8Array(0),
      gasLimit: BigInt(0xffff),
      common,
      _TVM: tvm,
    })

    assert.deepEqual(result.executionGasUsed, BigInt(500), 'should use petersburg gas costs')
  })
})
