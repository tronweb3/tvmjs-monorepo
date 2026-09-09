import { Common, TronMainnet } from '@tvmjs/common'
import { bigIntToBytes, concatBytes, setLengthLeft } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { TVMError, createTVM } from '../../src/index.ts'
import { precompile0a } from '../../src/precompiles/0a-validate-multi-sign.ts'
import { precompile09 } from '../../src/precompiles/09-batch-validate-sign.ts'
import { DataWord } from '../../src/precompiles/dataWord.ts'
import { SIGNATURE_LENGTH, extractSigArray } from '../../src/precompiles/util.ts'

const ATTACKER_CONTROLLED_LENGTH = 0x7fffffffn

function encodeWords(values: bigint[]): Uint8Array {
  return concatBytes(
    ...values.map((value) => setLengthLeft(bigIntToBytes(value), DataWord.WORD_SIZE)),
  )
}

function batchValidateSignBomb(): Uint8Array {
  return encodeWords([
    0n, // hash
    3n * 32n, // signatures offset
    9n * 32n, // addresses offset
    1n, // signature count
    32n, // first signature offset
    ATTACKER_CONTROLLED_LENGTH, // ignored ABI bytes length
    0n,
    0n,
    0n, // signature data
    1n, // address count
    0n, // address
    0n,
  ])
}

function validateMultiSignBomb(): Uint8Array {
  return encodeWords([
    0n, // owner address
    0n, // permission id
    0n, // hash
    4n * 32n, // signatures offset
    1n, // signature count
    32n, // first signature offset
    ATTACKER_CONTROLLED_LENGTH, // ignored ABI bytes length
    0n,
    0n,
    0n, // signature data
  ])
}

describe('TRON signature array extraction hardening', () => {
  it('extracts a fixed 65-byte signature without allocating the ABI-declared length', () => {
    const data = batchValidateSignBomb()
    const signatures = extractSigArray(DataWord.parseArray(data), 3, 1, data)

    assert.lengthOf(signatures, 1)
    assert.lengthOf(signatures[0], SIGNATURE_LENGTH)
  })

  it('keeps 0x09 failure output for an oversized signature length word', async () => {
    const common = new Common({ chain: TronMainnet })
    const result = precompile09({
      data: batchValidateSignBomb(),
      gasLimit: 100000n,
      common,
      _TVM: await createTVM({ common }),
    })

    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.executionGasUsed, common.param('batchvalidatesignGas'))
    assert.deepEqual(result.returnValue, new Uint8Array(DataWord.WORD_SIZE))
  })

  it('keeps 0x0a failure output for an oversized signature length word', async () => {
    const common = new Common({ chain: TronMainnet })
    const result = await precompile0a({
      data: validateMultiSignBomb(),
      gasLimit: 100000n,
      common,
      _TVM: await createTVM({ common }),
    })

    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.executionGasUsed, common.param('validatemultisignGas'))
    assert.deepEqual(result.returnValue, new Uint8Array(DataWord.WORD_SIZE))
  })

  it('rejects 0x09 counts above 16 before reading signature offsets', async () => {
    const common = new Common({ chain: TronMainnet })
    const result = precompile09({
      data: encodeWords([0n, 3n * 32n, 0n, 17n]),
      gasLimit: 100000n,
      common,
      _TVM: await createTVM({ common }),
    })

    assert.isUndefined(result.exceptionError)
    assert.deepEqual(result.returnValue, new Uint8Array(DataWord.WORD_SIZE))
  })

  it('rejects 0x0a counts above 5 before reading signature offsets', async () => {
    const common = new Common({ chain: TronMainnet })
    const result = await precompile0a({
      data: encodeWords([0n, 0n, 0n, 4n * 32n, 6n]),
      gasLimit: 100000n,
      common,
      _TVM: await createTVM({ common }),
    })

    assert.isUndefined(result.exceptionError)
    assert.deepEqual(result.returnValue, new Uint8Array(DataWord.WORD_SIZE))
  })

  it('rejects a truncated 0x09 address array with the existing UNKNOWN semantics', async () => {
    const common = new Common({ chain: TronMainnet })
    const gasLimit = 100000n
    const result = precompile09({
      data: encodeWords([
        0n,
        3n * 32n,
        9n * 32n,
        1n,
        32n,
        65n,
        0n,
        0n,
        0n,
        1n, // address count without its address element
      ]),
      gasLimit,
      common,
      _TVM: await createTVM({ common }),
    })

    assert.strictEqual(result.executionGasUsed, gasLimit)
    assert.strictEqual(result.exceptionError?.error, TVMError.errorMessages.UNKNOWN)
  })

  it('rejects a truncated 0x0a signature array with the existing UNKNOWN semantics', async () => {
    const common = new Common({ chain: TronMainnet })
    const gasLimit = 100000n
    const result = await precompile0a({
      data: encodeWords([0n, 0n, 0n, 4n * 32n, 1n]),
      gasLimit,
      common,
      _TVM: await createTVM({ common }),
    })

    assert.strictEqual(result.executionGasUsed, gasLimit)
    assert.strictEqual(result.exceptionError?.error, TVMError.errorMessages.UNKNOWN)
  })
})
