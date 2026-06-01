import { trustedSetup } from '@paulmillr/trusted-setups/fast-peerdas.js'
import { Hardfork, createCommonFromGethGenesis } from '@tvmjs/common'
import {
  bytesToBigInt,
  computeVersionedHash,
  concatBytes,
  hexToBytes,
  unpadBytes,
} from '@tvmjs/util'
import { KZG as microEthKZG } from 'micro-eth-signer/kzg.js'
import { assert, describe, it } from 'vitest'

import { createTVM, getActivePrecompiles } from '../../src/index.ts'

import type { PrefixedHexString } from '@tvmjs/util'
import type { PrecompileInput } from '../../src/index.ts'
const kzg = new microEthKZG(trustedSetup)
const BLS_MODULUS = BigInt(
  '52435875175126190479447740508185965837690552500527637822603658699938581184513',
)

describe('Precompiles: point evaluation', () => {
  it('should work', async () => {
    const { eip4844GethGenesis } = await import('@tvmjs/testdata')

    const common = createCommonFromGethGenesis(eip4844GethGenesis, {
      chain: 'custom',
      hardfork: Hardfork.Cancun,
      customCrypto: { kzg },
    })

    const tvm = await createTVM({
      common,
    })
    const addressStr = '000000000000000000000000000000000000000a'
    const pointEvaluation = getActivePrecompiles(common).get(addressStr)!

    const testCase = {
      commitment:
        '0xc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as PrefixedHexString,
      z: '0x0000000000000000000000000000000000000000000000000000000000000002' as PrefixedHexString,
      y: '0x0000000000000000000000000000000000000000000000000000000000000000' as PrefixedHexString,
      proof:
        '0xc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as PrefixedHexString,
    }
    const versionedHash = computeVersionedHash(testCase.commitment as PrefixedHexString, 1)

    const opts: PrecompileInput = {
      data: concatBytes(
        hexToBytes(versionedHash),
        hexToBytes(testCase.z),
        hexToBytes(testCase.y),
        hexToBytes(testCase.commitment),
        hexToBytes(testCase.proof),
      ),
      gasLimit: 0xfffffffffn,
      _TVM: tvm,
      common,
    }

    let res = await pointEvaluation(opts)
    assert.strictEqual(
      bytesToBigInt(unpadBytes(res.returnValue.slice(32))),
      BLS_MODULUS,
      'point evaluation precompile returned expected output',
    )

    const optsWithInvalidCommitment: PrecompileInput = {
      data: concatBytes(
        concatBytes(Uint8Array.from([0]), hexToBytes(versionedHash as PrefixedHexString)),
        hexToBytes(testCase.z),
        hexToBytes(testCase.y),
        hexToBytes(testCase.commitment),
        hexToBytes(testCase.proof),
      ),
      gasLimit: 0xfffffffffn,
      _TVM: tvm,
      common,
    }
    res = await pointEvaluation(optsWithInvalidCommitment)
    assert.include(res.exceptionError?.error, 'invalid input length', 'invalid input length')
  })
})
