import { bench, describe } from 'vitest'
import { TronMainnet } from '../../src/chains.ts'
import { Common } from '../../src/common.ts'

describe('Common _buildParamsCache Benchmark', () => {
  const common = new Common({ chain: TronMainnet, params: { tron: { testValue: 9 } } })

  bench('_buildParamsCache', () => {
    // @ts-expect-error - accessing protected method for benchmarking
    common._buildParamsCache()
  })
})
