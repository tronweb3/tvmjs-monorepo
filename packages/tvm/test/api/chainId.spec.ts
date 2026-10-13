import { Common, Mainnet, createTronChainIdCommon } from '@tvmjs/common'
import { hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createTVM } from '../../src/index.ts'

describe('CHAINID opcode (0x46)', () => {
  it('should default to TRON Mainnet chainId (728126428)', async () => {
    const tvm = await createTVM()
    const result = await tvm.runCode({ code: hexToBytes('0x46') })

    assert.strictEqual(tvm.common.chainId(), 728126428n)
    assert.isUndefined(result.exceptionError, 'execution should succeed')
    assert.strictEqual(result.runState!.stack.peek()[0], 728126428n)
  })

  it('rejects retired Ethereum execution configuration', () => {
    assert.throws(
      // @ts-expect-error Ethereum presets must be rejected by the execution constructor.
      () => new Common({ chain: Mainnet, hardfork: 'istanbul' }),
      /Only TRON execution configurations/,
    )
  })

  it('should return TRON Mainnet chainId (728126428) when using tron-mainnet preset', async () => {
    const common = createTronChainIdCommon('mainnet')
    const tvm = await createTVM({ common })
    const result = await tvm.runCode({ code: hexToBytes('0x46') })
    assert.isUndefined(result.exceptionError, 'execution should succeed')
    assert.strictEqual(result.executionGasUsed, 2n)
    assert.strictEqual(result.runState!.stack.length, 1)
    assert.strictEqual(result.runState!.stack.peek()[0], 728126428n, 'chainId should be 728126428')
  })

  it('should return TRON Nile chainId (3448148188) when using tron-nile preset', async () => {
    const common = createTronChainIdCommon('nile')
    const tvm = await createTVM({ common })
    const result = await tvm.runCode({ code: hexToBytes('0x46') })
    assert.isUndefined(result.exceptionError, 'execution should succeed')
    assert.strictEqual(result.executionGasUsed, 2n)
    assert.strictEqual(result.runState!.stack.length, 1)
    assert.strictEqual(
      result.runState!.stack.peek()[0],
      3448148188n,
      'chainId should be 3448148188',
    )
  })

  it('should return TRON Shasta chainId (2494104990) when using tron-shasta preset', async () => {
    const common = createTronChainIdCommon('shasta')
    const tvm = await createTVM({ common })
    const result = await tvm.runCode({ code: hexToBytes('0x46') })
    assert.isUndefined(result.exceptionError, 'execution should succeed')
    assert.strictEqual(result.executionGasUsed, 2n)
    assert.strictEqual(result.runState!.stack.length, 1)
    assert.strictEqual(
      result.runState!.stack.peek()[0],
      2494104990n,
      'chainId should be 2494104990',
    )
  })
})
