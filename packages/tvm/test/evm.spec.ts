import { assert, describe, it } from 'vitest'

import { createTVM, paramsEVM } from '../src/index.ts'

// TODO: This whole file was missing for quite some time and now (July 2024)
// has been side introduced along another PR. We should add basic initialization
// tests for options and the like.
describe('initialization', () => {
  it('basic initialization', async () => {
    const evm = await createTVM()
    const msg = 'should use the correct parameter defaults'
    assert.isFalse(evm.allowUnlimitedContractSize, msg)
  })

  it('EVM parameter customization', async () => {
    let evm = await createTVM()
    assert.strictEqual(
      evm.common.param('bn254AddGas'),
      BigInt(150),
      'should use default EVM parameters',
    )

    const params = JSON.parse(JSON.stringify(paramsEVM))
    params['1679']['bn254AddGas'] = 100 // 150
    evm = await createTVM({ params })
    assert.strictEqual(
      evm.common.param('bn254AddGas'),
      BigInt(100),
      'should use custom parameters provided',
    )
  })
})
