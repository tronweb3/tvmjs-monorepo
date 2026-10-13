import {
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  createAccount,
  createAddressFromString,
  createZeroAddress,
  hexToBytes,
  setLengthLeft,
  tokenIdToKey,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createTVM } from '../src/index.ts'

const LOW = 2n ** 53n
const HIGH = LOW + 1n
const MAX = 2n ** 63n - 1n
const EXTERNAL = createAddressFromString('0x0000000000000000000000000000000000000001')
const SOURCE = createAddressFromString('0x1000000000000000000000000000000000000001')
const BENEFICIARY = createAddressFromString('0x2000000000000000000000000000000000000002')
const GAS_LIMIT = 100000n

function push32(value: bigint): Uint8Array {
  return concatBytes(Uint8Array.of(0x7f), setLengthLeft(bigIntToBytes(value), 32))
}

function tokenBalanceCode(address: bigint, tokenId: bigint): Uint8Array {
  return concatBytes(push32(address), push32(tokenId), Uint8Array.of(0xd1, 0x00))
}

function callTokenCode(tokenId: bigint, tokenValue: bigint): Uint8Array {
  // CALLTOKEN pops: gas, to, value, tokenId, inOffset, inLength, outOffset, outLength.
  return concatBytes(
    push32(0n),
    push32(0n),
    push32(0n),
    push32(0n),
    push32(tokenId),
    push32(tokenValue),
    push32(bytesToBigInt(EXTERNAL.bytes)),
    push32(50000n),
    Uint8Array.of(0xd0, 0x00),
  )
}

describe('TRC-10 token ID precision in the TVM', () => {
  it('TOKENBALANCE distinguishes adjacent IDs above 2^53', async () => {
    const tvm = await createTVM()
    await tvm.stateManager.putAccount(
      EXTERNAL,
      createAccount({
        asset: { [tokenIdToKey(LOW)]: 11n, [tokenIdToKey(HIGH)]: 22n, [tokenIdToKey(MAX)]: 33n },
      }),
    )
    for (const [tokenId, expected] of [
      [LOW, 11n],
      [HIGH, 22n],
      [MAX, 33n],
      [HIGH + 1n, 0n],
    ] as const) {
      const result = await tvm.runCode({
        code: tokenBalanceCode(bytesToBigInt(EXTERNAL.bytes), tokenId),
        gasLimit: GAS_LIMIT,
      })
      assert.isUndefined(result.exceptionError)
      assert.strictEqual(result.runState!.stack.peek()[0], expected)
    }
  })

  it('CALLTOKEN moves only the addressed high ID', async () => {
    const tvm = await createTVM()
    await tvm.stateManager.putAccount(
      createZeroAddress(),
      createAccount({ asset: { [tokenIdToKey(LOW)]: 5n, [tokenIdToKey(HIGH)]: 5n } }),
    )
    const result = await tvm.runCode({ code: callTokenCode(HIGH, 3n), gasLimit: GAS_LIMIT })
    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.runState!.stack.peek()[0], 1n)

    const sender = (await tvm.stateManager.getAccount(createZeroAddress()))!
    const recipient = (await tvm.stateManager.getAccount(EXTERNAL))!
    assert.strictEqual(sender.getTokenBalance(HIGH), 2n)
    assert.strictEqual(sender.getTokenBalance(LOW), 5n)
    assert.strictEqual(recipient.getTokenBalance(HIGH), 3n)
    assert.strictEqual(recipient.getTokenBalance(LOW), 0n)
    assert.deepEqual(Object.keys(recipient.asset), [tokenIdToKey(HIGH)])
  })

  it('CALLTOKEN fails without trapping when only the adjacent ID is funded', async () => {
    const tvm = await createTVM()
    await tvm.stateManager.putAccount(
      createZeroAddress(),
      createAccount({ asset: { [tokenIdToKey(LOW)]: 5n } }),
    )
    const result = await tvm.runCode({ code: callTokenCode(HIGH, 1n), gasLimit: GAS_LIMIT })
    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.runState!.stack.peek()[0], 0n)
    assert.isUndefined(await tvm.stateManager.getAccount(EXTERNAL))
    assert.strictEqual(
      (await tvm.stateManager.getAccount(createZeroAddress()))!.getTokenBalance(LOW),
      5n,
    )
  })

  it('SELFDESTRUCT transfers each high ID separately', async () => {
    const tvm = await createTVM()
    await tvm.stateManager.putAccount(
      SOURCE,
      createAccount({
        balance: 7n,
        asset: { [tokenIdToKey(LOW)]: 1n, [tokenIdToKey(HIGH)]: 2n },
      }),
    )
    await tvm.stateManager.putCode(SOURCE, hexToBytes(`0x73${BENEFICIARY.toString().slice(2)}ff`))
    const result = await tvm.runCall({ to: SOURCE, gasLimit: 50000n })
    assert.isUndefined(result.execResult.exceptionError)

    const beneficiary = (await tvm.stateManager.getAccount(BENEFICIARY))!
    assert.strictEqual(beneficiary.balance, 7n)
    assert.strictEqual(beneficiary.getTokenBalance(LOW), 1n)
    assert.strictEqual(beneficiary.getTokenBalance(HIGH), 2n)
    assert.deepEqual(Object.keys(beneficiary.asset).sort(), [tokenIdToKey(LOW), tokenIdToKey(HIGH)])
    const source = (await tvm.stateManager.getAccount(SOURCE))!
    assert.strictEqual(source.getTokenBalance(LOW), 0n)
    assert.strictEqual(source.getTokenBalance(HIGH), 0n)
  })
})
