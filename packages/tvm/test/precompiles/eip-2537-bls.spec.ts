import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { SimpleStateManager } from '@tvmjs/statemanager'
import { Address, bytesToHex, createZeroAddress, hexToBytes } from '@tvmjs/util'
import * as mcl from 'mcl-wasm'
import { assert, describe, it } from 'vitest'

import {
  MCLBLS,
  NobleBLS,
  NobleBN254,
  TVM,
  TVMError,
  TVMMockBlockchain,
  createTVM,
  getActivePrecompiles,
  paramsTVM,
} from '../../src/index.ts'
import { precompiles } from '../../src/precompiles/index.ts'

import type { TVMBLSInterface } from '../../src/index.ts'

import fixture0 from './bls/add_G1_bls.json' with { type: 'json' }
import fixture1 from './bls/add_G2_bls.json' with { type: 'json' }
import fixture2 from './bls/fail-add_G1_bls.json' with { type: 'json' }
import fixture3 from './bls/fail-add_G2_bls.json' with { type: 'json' }
import fixture4 from './bls/fail-map_fp2_to_G2_bls.json' with { type: 'json' }
import fixture5 from './bls/fail-map_fp_to_G1_bls.json' with { type: 'json' }
import fixture6 from './bls/fail-mul_G1_bls.json' with { type: 'json' }
import fixture7 from './bls/fail-mul_G2_bls.json' with { type: 'json' }
import fixture8 from './bls/fail-multiexp_G1_bls.json' with { type: 'json' }
import fixture9 from './bls/fail-multiexp_G2_bls.json' with { type: 'json' }
import fixture10 from './bls/fail-pairing_check_bls.json' with { type: 'json' }
import fixture11 from './bls/map_fp2_to_G2_bls.json' with { type: 'json' }
import fixture12 from './bls/map_fp_to_G1_bls.json' with { type: 'json' }
import fixture13 from './bls/mul_G1_bls.json' with { type: 'json' }
import fixture14 from './bls/mul_G2_bls.json' with { type: 'json' }
import fixture15 from './bls/multiexp_G1_bls.json' with { type: 'json' }
import fixture16 from './bls/multiexp_G2_bls.json' with { type: 'json' }
import fixture17 from './bls/pairing_check_bls.json' with { type: 'json' }

interface BLSVector {
  Name: string
  Input: string
  Expected?: string
  ExpectedError?: string
  Gas?: number
}

// BLS remains a low-level tool, not an activatable TRON execution capability.
// This harness supplies the backend and the fixture fee schedule only for direct
// wrapper calls. It never registers BLS addresses in the active precompile table.
class BLSPrecompileHarness extends TVM {
  protected readonly _bls: TVMBLSInterface

  constructor(bls: TVMBLSInterface) {
    super({
      common: new Common({ chain: TronMainnet }),
      stateManager: new SimpleStateManager(),
      blockchain: new TVMMockBlockchain(),
      bn254: new NobleBN254(),
      params: { ...paramsTVM, tron: { ...paramsTVM.tron, ...paramsTVM[2537] } },
    })
    this._bls = bls
    bls.init?.()
  }
}

const vectorFiles: { name: string; address: string; data: BLSVector[] }[] = [
  { name: 'add_G1_bls.json', address: '000000000000000000000000000000000000000b', data: fixture0 },
  { name: 'add_G2_bls.json', address: '000000000000000000000000000000000000000d', data: fixture1 },
  {
    name: 'fail-add_G1_bls.json',
    address: '000000000000000000000000000000000000000b',
    data: fixture2,
  },
  {
    name: 'fail-add_G2_bls.json',
    address: '000000000000000000000000000000000000000d',
    data: fixture3,
  },
  {
    name: 'fail-map_fp2_to_G2_bls.json',
    address: '0000000000000000000000000000000000000011',
    data: fixture4,
  },
  {
    name: 'fail-map_fp_to_G1_bls.json',
    address: '0000000000000000000000000000000000000010',
    data: fixture5,
  },
  {
    name: 'fail-mul_G1_bls.json',
    address: '000000000000000000000000000000000000000c',
    data: fixture6,
  },
  {
    name: 'fail-mul_G2_bls.json',
    address: '000000000000000000000000000000000000000e',
    data: fixture7,
  },
  {
    name: 'fail-multiexp_G1_bls.json',
    address: '000000000000000000000000000000000000000c',
    data: fixture8,
  },
  {
    name: 'fail-multiexp_G2_bls.json',
    address: '000000000000000000000000000000000000000e',
    data: fixture9,
  },
  {
    name: 'fail-pairing_check_bls.json',
    address: '000000000000000000000000000000000000000f',
    data: fixture10,
  },
  {
    name: 'map_fp2_to_G2_bls.json',
    address: '0000000000000000000000000000000000000011',
    data: fixture11,
  },
  {
    name: 'map_fp_to_G1_bls.json',
    address: '0000000000000000000000000000000000000010',
    data: fixture12,
  },
  { name: 'mul_G1_bls.json', address: '000000000000000000000000000000000000000c', data: fixture13 },
  { name: 'mul_G2_bls.json', address: '000000000000000000000000000000000000000e', data: fixture14 },
  {
    name: 'multiexp_G1_bls.json',
    address: '000000000000000000000000000000000000000c',
    data: fixture15,
  },
  {
    name: 'multiexp_G2_bls.json',
    address: '000000000000000000000000000000000000000e',
    data: fixture16,
  },
  {
    name: 'pairing_check_bls.json',
    address: '000000000000000000000000000000000000000f',
    data: fixture17,
  },
]

await mcl.init(mcl.BLS12_381)
for (const [name, bls] of [
  ['Noble', new NobleBLS()],
  ['MCL', new MCLBLS(mcl)],
] as const) {
  const harness = new BLSPrecompileHarness(bls)
  for (const file of vectorFiles) {
    describe(`Retained BLS helpers: ${file.name} [${name}]`, () => {
      for (const vector of file.data) {
        it(vector.Name, async () => {
          assert.isFalse(harness.common.isActivatedEIP(2537))
          assert.isFalse(harness.precompiles.has(file.address))
          const gasLimit = 5000000n
          const result = await precompiles[file.address]({
            data: hexToBytes(`0x${vector.Input}`),
            gasLimit,
            common: harness.common,
            _TVM: harness,
          })

          if (vector.ExpectedError !== undefined) {
            const error = result.exceptionError
            if (error instanceof Error) {
              // Field decoding can return a backend Error instead of a TVMError.
              // Check the exact domain error so unrelated TypeErrors cannot pass.
              assert.strictEqual(vector.ExpectedError, 'invalid fp.Element encoding')
              assert.strictEqual(
                error.message,
                name === 'Noble' ? 'invalid affine point' : 'err _wrapInput',
              )
            } else {
              assert.instanceOf(error, TVMError, vector.ExpectedError)
              assert.include(
                [
                  TVMError.errorMessages.BLS_12_381_INVALID_INPUT_LENGTH,
                  TVMError.errorMessages.BLS_12_381_POINT_NOT_ON_CURVE,
                  TVMError.errorMessages.BLS_12_381_INPUT_EMPTY,
                  TVMError.errorMessages.BLS_12_381_FP_NOT_IN_FIELD,
                ],
                error!.error,
              )
            }
            assert.strictEqual(result.returnValue.length, 0)
            assert.strictEqual(result.executionGasUsed, gasLimit)
          } else {
            assert.isUndefined(result.exceptionError)
            assert.strictEqual(bytesToHex(result.returnValue), `0x${vector.Expected}`)
            assert.strictEqual(result.executionGasUsed, BigInt(vector.Gas!))
          }
        })
      }
    })
  }
}

describe.each([TronMainnet, TronNile, TronShasta])('BLS isolation on $name', (chain) => {
  it('rejects EIP-2537 and leaves BLS addresses unregistered even with a custom backend', async () => {
    const common = new Common({ chain })
    const tvm = await createTVM({ common, bls: new NobleBLS() })
    assert.isFalse(common.isActivatedEIP(2537))
    assert.throws(() => common.setEIPs([2537]), /not supported by the TRON execution profile/)
    for (let index = 0x0b; index <= 0x11; index++) {
      const address = index.toString(16).padStart(40, '0')
      assert.isFalse(getActivePrecompiles(common).has(address))
      assert.isFalse(tvm.precompiles.has(address))
      const to = new Address(hexToBytes(`0x${address}`))
      const result = await tvm.runCall({
        caller: createZeroAddress(),
        to,
        data: new Uint8Array(),
        gasLimit: 100000n,
      })
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.executionGasUsed, 0n)
      assert.strictEqual(result.execResult.returnValue.length, 0)
      assert.isUndefined(await tvm.stateManager.getAccount(to))
    }
  })
})
