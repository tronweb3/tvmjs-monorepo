import { Common, Hardfork, Mainnet, TronMainnet } from '@tvmjs/common'
import { BIGINT_0, bytesToBigInt, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { TVMError, createTVM, paramsTVM } from '../src/index.ts'

const MAX_CODE_SIZE = 24576
const MAX_INITCODE_SIZE = 49152
const ROOT_TRANSACTION_ID = hexToBytes(
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
)
const FACTORY = createAddressFromString('0x0000000000000000000000000000000000000100')

const OVERSIZED_RUNTIME_INITCODE = hexToBytes('0x6160016000f3')
const INVALID_EF_RUNTIME_INITCODE = hexToBytes('0x60ef60005360016000f3')

function internalCreateCode(opcode: 'f0' | 'f5', initcodeSize: number): Uint8Array {
  const size = initcodeSize.toString(16).padStart(4, '0')
  const create =
    opcode === 'f0'
      ? `61${size}60006000f0`
      : // CREATE2 stack order: salt, size, offset, value.
        `600061${size}60006000f5`
  return hexToBytes(`0x${create}60005260206000f3`)
}

async function runFactory(common: Common, code: Uint8Array, params = paramsTVM) {
  const tvm = await createTVM({ common, params })
  await tvm.stateManager.putCode(FACTORY, code)
  return tvm.runCall({
    to: FACTORY,
    gasLimit: 1000000n,
    rootTransactionId: ROOT_TRANSACTION_ID,
  })
}

describe('TRON contract creation size semantics', () => {
  it.each([
    ['default hardfork', undefined],
    ['explicit Shanghai hardfork', Hardfork.Shanghai],
  ] as const)(
    'deploys runtime code one byte above the EIP-170 limit with the %s',
    async (_name, hardfork) => {
      const common = new Common({ chain: TronMainnet, hardfork })
      const tvm = await createTVM({ common })
      const result = await tvm.runCall({
        data: OVERSIZED_RUNTIME_INITCODE,
        gasLimit: 6000000n,
        rootTransactionId: ROOT_TRANSACTION_ID,
      })

      assert.isUndefined(result.execResult.exceptionError)
      assert.isDefined(result.createdAddress)
      assert.strictEqual(
        (await tvm.stateManager.getCode(result.createdAddress!)).length,
        MAX_CODE_SIZE + 1,
      )
    },
  )

  it('keeps the EIP-170 runtime limit for Ethereum', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai })
    const tvm = await createTVM({ common })
    const result = await tvm.runCall({
      data: OVERSIZED_RUNTIME_INITCODE,
      gasLimit: 6000000n,
    })

    assert.strictEqual(
      result.execResult.exceptionError?.error,
      TVMError.errorMessages.CODESIZE_EXCEEDS_MAXIMUM,
    )
  })

  it.each([
    ['default hardfork', undefined],
    ['explicit Shanghai hardfork', Hardfork.Shanghai],
  ] as const)(
    'accepts top-level initcode one byte above the EIP-3860 limit with the %s',
    async (_name, hardfork) => {
      const common = new Common({ chain: TronMainnet, hardfork })
      const tvm = await createTVM({ common })
      const result = await tvm.runCall({
        data: new Uint8Array(MAX_INITCODE_SIZE + 1),
        gasLimit: 100000n,
        rootTransactionId: ROOT_TRANSACTION_ID,
      })

      assert.isUndefined(result.execResult.exceptionError)
      assert.isDefined(result.createdAddress)
    },
  )

  it('keeps the EIP-3860 initcode limit for Ethereum', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai })
    const tvm = await createTVM({ common })
    const result = await tvm.runCall({
      data: new Uint8Array(MAX_INITCODE_SIZE + 1),
      gasLimit: 100000n,
    })

    assert.strictEqual(
      result.execResult.exceptionError?.error,
      TVMError.errorMessages.INITCODE_SIZE_VIOLATION,
    )
  })

  it.each(['f0', 'f5'] as const)(
    'allows oversized initcode through internal CREATE opcode 0x%s',
    async (opcode) => {
      const result = await runFactory(
        new Common({ chain: TronMainnet }),
        internalCreateCode(opcode, MAX_INITCODE_SIZE + 1),
      )

      assert.isUndefined(result.execResult.exceptionError)
      assert.isTrue(bytesToBigInt(result.execResult.returnValue) > BIGINT_0)
    },
  )

  it.each(['f0', 'f5'] as const)(
    'does not charge EIP-3860 word gas for TRON opcode 0x%s',
    async (opcode) => {
      const code = internalCreateCode(opcode, 32)
      const baseline = await runFactory(new Common({ chain: TronMainnet }), code)
      const expensiveParams = JSON.parse(JSON.stringify(paramsTVM))
      expensiveParams[3860].initCodeWordGas = 1000000
      const withExpensiveWordGas = await runFactory(
        new Common({ chain: TronMainnet }),
        code,
        expensiveParams,
      )

      assert.isUndefined(baseline.execResult.exceptionError)
      assert.isUndefined(withExpensiveWordGas.execResult.exceptionError)
      assert.strictEqual(
        withExpensiveWordGas.execResult.executionGasUsed,
        baseline.execResult.executionGasUsed,
      )
    },
  )

  it('continues to reject EIP-3541 0xEF-prefixed runtime code', async () => {
    const tvm = await createTVM({ common: new Common({ chain: TronMainnet }) })
    const result = await tvm.runCall({
      data: INVALID_EF_RUNTIME_INITCODE,
      gasLimit: 100000n,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.strictEqual(
      result.execResult.exceptionError?.error,
      TVMError.errorMessages.INVALID_BYTECODE_RESULT,
    )
  })
})
