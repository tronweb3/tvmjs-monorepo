import {
  Account,
  BIGINT_0,
  MIN_TOKEN_ID,
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  createAddressFromString,
  setLengthLeft,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { TVMError, createTVM } from '../src/index.ts'

const MAX_TRON_TOKEN_ID = (1n << 63n) - 1n
const UNISSUED_TOKEN_IDS = [1007700n, 1009999n, 4294967295n, 0xdeadbeefn, MAX_TRON_TOKEN_ID]
const GAS_LIMIT = 100000n
const EXTERNAL_ACCOUNT = createAddressFromString('0x0000000000000000000000000000000000000001')

function push32(value: bigint): Uint8Array {
  return concatBytes(Uint8Array.of(0x7f), setLengthLeft(bigIntToBytes(value), 32))
}

function tokenBalanceCode(address: bigint, tokenId: bigint): Uint8Array {
  return concatBytes(push32(address), push32(tokenId), Uint8Array.of(0xd1, 0x00))
}

function callTokenCode(tokenId: bigint, tokenValue: bigint = BIGINT_0): Uint8Array {
  // CALLTOKEN pops: gas, to, value, tokenId, inOffset, inLength, outOffset, outLength.
  return concatBytes(
    push32(BIGINT_0),
    push32(BIGINT_0),
    push32(BIGINT_0),
    push32(BIGINT_0),
    push32(tokenId),
    push32(tokenValue),
    push32(bytesToBigInt(EXTERNAL_ACCOUNT.bytes)),
    push32(50000n),
    Uint8Array.of(0xd0, 0x00),
  )
}

describe('TRON token opcodes', () => {
  it.each(UNISSUED_TOKEN_IDS)(
    'returns zero for valid but unissued TOKENBALANCE ID %s with SimpleStateManager',
    async (tokenId) => {
      const tvm = await createTVM()

      const result = await tvm.runCode({
        code: tokenBalanceCode(BIGINT_0, tokenId),
        gasLimit: GAS_LIMIT,
      })

      assert.isUndefined(result.exceptionError)
      assert.strictEqual(result.runState!.stack.peek()[0], BIGINT_0)
    },
  )

  it('returns the balance for an issued TOKENBALANCE ID', async () => {
    const tvm = await createTVM()
    const account = new Account()
    const tokenId = UNISSUED_TOKEN_IDS[0]
    account.asset = { [Number(tokenId)]: 42n }
    await tvm.stateManager.putAccount(EXTERNAL_ACCOUNT, account)

    const result = await tvm.runCode({
      code: tokenBalanceCode(bytesToBigInt(EXTERNAL_ACCOUNT.bytes), tokenId),
      gasLimit: GAS_LIMIT,
    })

    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.runState!.stack.peek()[0], 42n)
  })

  it.each([BIGINT_0, MIN_TOKEN_ID, MAX_TRON_TOKEN_ID + 1n])(
    'rejects TOKENBALANCE token ID %s outside the valid TRC-10 range',
    async (tokenId) => {
      const tvm = await createTVM()
      const result = await tvm.runCode({
        code: tokenBalanceCode(BIGINT_0, tokenId),
        gasLimit: GAS_LIMIT,
      })

      assert.strictEqual(result.exceptionError?.error, TVMError.errorMessages.INVALID_TOKENID)
      assert.strictEqual(result.executionGasUsed, GAS_LIMIT)
    },
  )

  it('allows CALLTOKEN with a valid unissued ID and zero token value', async () => {
    const tvm = await createTVM()

    const result = await tvm.runCode({
      code: callTokenCode(UNISSUED_TOKEN_IDS[0]),
      gasLimit: GAS_LIMIT,
    })

    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.runState!.stack.peek()[0], 1n)
  })

  it('lets CALLTOKEN handle insufficient balance for an unissued ID without trapping', async () => {
    const tvm = await createTVM()
    const result = await tvm.runCode({
      code: callTokenCode(UNISSUED_TOKEN_IDS[0], 1n),
      gasLimit: GAS_LIMIT,
    })

    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.runState!.stack.peek()[0], BIGINT_0)
  })

  it.each([MIN_TOKEN_ID, MAX_TRON_TOKEN_ID + 1n])(
    'rejects CALLTOKEN token ID %s outside the valid TRC-10 range',
    async (tokenId) => {
      const tvm = await createTVM()
      const result = await tvm.runCode({
        code: callTokenCode(tokenId),
        gasLimit: GAS_LIMIT,
      })

      assert.strictEqual(result.exceptionError?.error, TVMError.errorMessages.INVALID_TOKENID)
      assert.strictEqual(result.executionGasUsed, GAS_LIMIT)
    },
  )
})
