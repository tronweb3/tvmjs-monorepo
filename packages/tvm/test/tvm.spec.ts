import { assert, describe, it } from 'vitest'

import { createTVM, paramsTVM } from '../src/index.ts'

// TODO: This whole file was missing for quite some time and now (July 2024)
// has been side introduced along another PR. We should add basic initialization
// tests for options and the like.
describe('initialization', () => {
  it('basic initialization', async () => {
    const tvm = await createTVM()
    const msg = 'should use the correct parameter defaults'
    assert.isFalse(tvm.allowUnlimitedContractSize, msg)
  })

  it('TVM parameter customization', async () => {
    let tvm = await createTVM()
    assert.strictEqual(
      tvm.common.param('bn254AddGas'),
      BigInt(150),
      'should use default TVM parameters',
    )

    const params = JSON.parse(JSON.stringify(paramsTVM))
    params['1679']['bn254AddGas'] = 100 // 150
    tvm = await createTVM({ params })
    assert.strictEqual(
      tvm.common.param('bn254AddGas'),
      BigInt(100),
      'should use custom parameters provided',
    )
  })
})
