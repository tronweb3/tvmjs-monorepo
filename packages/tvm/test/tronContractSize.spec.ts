import { Common, Hardfork, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { Account, BIGINT_0, bytesToBigInt, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { TVMError, type TVMResult, createTVM, paramsTVM } from '../src/index.ts'

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
    ['explicit TRON profile', Hardfork.Tron],
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

  it.each([
    ['default hardfork', undefined],
    ['explicit TRON profile', Hardfork.Tron],
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
      // Even custom data in an active parameter group cannot restore retired metering.
      expensiveParams[1].initCodeWordGas = 1000000
      expensiveParams[1].maxInitCodeSize = 1
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

describe.each([TronMainnet, TronNile, TronShasta])('TRON code deposit on $name', (chain) => {
  const caller = createAddressFromString(`0x${'11'.repeat(20)}`)
  const expectedAddress = '0x83406c6537ca51e460302d2b2ef235ea1cad2f46'

  it.each([
    [24575, 4918462n],
    [24576, 4918662n],
    [24577, 4918868n],
  ] as const)('deploys %s runtime bytes with exactly %s Energy', async (size, energy) => {
    const params = structuredClone(paramsTVM)
    params[1].maxCodeSize = 1
    const tvm = await createTVM({ common: new Common({ chain }), params })
    await tvm.stateManager.putAccount(caller, new Account(0n, 100n))
    const result = await tvm.runCall({
      caller,
      data: hexToBytes(`0x61${size.toString(16).padStart(4, '0')}6000f3`),
      value: 7n,
      gasLimit: energy,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(result.execResult.executionGasUsed, energy)
    assert.strictEqual(result.createdAddress?.toString(), expectedAddress)
    assert.deepEqual(await tvm.stateManager.getCode(result.createdAddress!), new Uint8Array(size))
    const account = await tvm.stateManager.getAccount(result.createdAddress!)
    assert.strictEqual(account?.nonce, 1n)
    assert.strictEqual(account?.balance, 7n)
    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.balance, 93n)
  })

  it.each([
    [
      'code deposit Energy shortage',
      OVERSIZED_RUNTIME_INITCODE,
      4918867n,
      'out of gas',
      4918867n,
      0,
    ],
    [
      'EF-prefixed runtime',
      INVALID_EF_RUNTIME_INITCODE,
      100000n,
      'invalid bytecode deployed',
      100000n,
      0,
    ],
    ['large REVERT data', hexToBytes('0x6160016000fd'), 100000n, 'revert', 3468n, 24577],
  ] as const)('rolls back %s', async (_name, data, gasLimit, error, energy, returnSize) => {
    const tvm = await createTVM({ common: new Common({ chain }) })
    await tvm.stateManager.putAccount(caller, new Account(0n, 100n))
    const result = await tvm.runCall({
      caller,
      data,
      gasLimit,
      value: 7n,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })
    assert.strictEqual(result.execResult.exceptionError?.error, error)
    assert.strictEqual(result.execResult.executionGasUsed, energy)
    assert.strictEqual(result.execResult.returnValue.length, returnSize)
    assert.strictEqual(result.createdAddress?.toString(), expectedAddress)
    assert.isUndefined(await tvm.stateManager.getAccount(result.createdAddress!))
    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.balance, 100n)
    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.nonce, 1n)
  })

  it.each(['f0', 'f5'] as const)(
    'reverts a successful large deployment from opcode 0x%s with its parent',
    async (opcode) => {
      const tvm = await createTVM({ common: new Common({ chain }) })
      await tvm.stateManager.putAccount(FACTORY, new Account(0n, 100n))
      const code = hexToBytes(
        `0x${opcode === 'f5' ? '6000' : ''}61c00160006007${opcode}60005260006000fd`,
      )
      await tvm.stateManager.putCode(FACTORY, code)
      let child: TVMResult | undefined
      tvm.events.on('afterMessage', (result) => {
        if (result.createdAddress !== undefined) child = result
      })
      const result = await tvm.runCall({
        to: FACTORY,
        gasLimit: 100000n,
        rootTransactionId: ROOT_TRANSACTION_ID,
      })
      assert.strictEqual(result.execResult.exceptionError?.error, 'revert')
      assert.isDefined(child?.createdAddress)
      assert.isUndefined(child!.execResult.exceptionError)
      assert.isUndefined(await tvm.stateManager.getAccount(child!.createdAddress!))
      const account = await tvm.stateManager.getAccount(FACTORY)
      assert.strictEqual(account?.nonce, 0n)
      assert.strictEqual(account?.balance, 100n)
      assert.deepEqual(await tvm.stateManager.getCode(FACTORY), code)
    },
  )
})
