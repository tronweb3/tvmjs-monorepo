import { type PrefixedHexString, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { default as testData } from '../../../ethereum-tests/EOFTests/EIP5450/validInvalid.json' with {
  type: 'json',
}
import { validateEOF } from '../../src/eof/container.ts'
import { createTVM } from '../../src/index.ts'

import { getCommon } from './eof-utils.ts'

async function getTVM() {
  const common = getCommon()
  const tvm = createTVM({
    common,
  })
  return tvm
}

describe('EIP 5450 tests', async () => {
  const tvm = await getTVM()
  for (const key in testData.validInvalid.vectors) {
    it(`Container validation tests ${key}`, () => {
      const input = testData.validInvalid.vectors[key as keyof typeof testData.validInvalid.vectors]
      const code = hexToBytes(input.code as PrefixedHexString)

      const expected = input.results.Osaka.result

      if (expected === true) {
        validateEOF(code, tvm)
      } else {
        assert.throws(() => {
          // TODO verify that the correct error is thrown
          validateEOF(code, tvm)
        })
      }
    })
  }
})
