import {
  Account,
  BIGINT_0,
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  createAccount,
  createAddressFromString,
  setLengthLeft,
  tokenIdToKey,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { TVMError, createTVM } from '../src/index.ts'

function push32(value: bigint): Uint8Array {
  return concatBytes(Uint8Array.of(0x7f), setLengthLeft(bigIntToBytes(value), 32))
}

describe('TRON self-transfer and delegatecall behavior', () => {
  it('traps CAN_NOT_TRANSFER_TRX_YOURSELF on direct CALL to self with value > 0', async () => {
    const tvm = await createTVM()
    const selfAddress = createAddressFromString('0x00000000000000000000000000000000000000aa')
    await tvm.stateManager.putAccount(selfAddress, new Account(BIGINT_0, 1000n))

    // CALL pops: gas, to, value, inOffset, inLength, outOffset, outLength
    const code = concatBytes(
      push32(BIGINT_0), // outLength
      push32(BIGINT_0), // outOffset
      push32(BIGINT_0), // inLength
      push32(BIGINT_0), // inOffset
      push32(10n), // value > 0
      push32(bytesToBigInt(selfAddress.bytes)), // to = self
      push32(50000n), // gas
      Uint8Array.of(0xf1), // CALL
    )

    const result = await tvm.runCode({
      code,
      gasLimit: 100000n,
      to: selfAddress,
    })

    assert.strictEqual(
      result.exceptionError?.error,
      TVMError.errorMessages.CAN_NOT_TRANSFER_TRX_YOURSELF,
    )
  })

  it('allows DELEGATECALL to self with inherited value > 0 without trapping', async () => {
    const tvm = await createTVM()
    const selfAddress = createAddressFromString('0x00000000000000000000000000000000000000bb')
    // Target code that delegatecall executes: simple STOP (0x00)
    await tvm.stateManager.putAccount(selfAddress, new Account(BIGINT_0, 1000n))
    await tvm.stateManager.putCode(selfAddress, Uint8Array.of(0x00))

    // DELEGATECALL pops: gas, to, inOffset, inLength, outOffset, outLength
    const code = concatBytes(
      push32(BIGINT_0), // outLength
      push32(BIGINT_0), // outOffset
      push32(BIGINT_0), // inLength
      push32(BIGINT_0), // inOffset
      push32(bytesToBigInt(selfAddress.bytes)), // to = self
      push32(50000n), // gas
      Uint8Array.of(0xf4), // DELEGATECALL
    )

    const result = await tvm.runCode({
      code,
      gasLimit: 100000n,
      to: selfAddress,
      value: 100n, // inherited callValue > 0
    })

    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.runState!.stack.peek()[0], 1n) // success = 1
  })

  it('allows CALLCODE to self with value > 0 without trapping', async () => {
    const tvm = await createTVM()
    const selfAddress = createAddressFromString('0x00000000000000000000000000000000000000cc')
    await tvm.stateManager.putAccount(selfAddress, new Account(BIGINT_0, 1000n))
    await tvm.stateManager.putCode(selfAddress, Uint8Array.of(0x00))

    // CALLCODE pops: gas, to, value, inOffset, inLength, outOffset, outLength
    const code = concatBytes(
      push32(BIGINT_0), // outLength
      push32(BIGINT_0), // outOffset
      push32(BIGINT_0), // inLength
      push32(BIGINT_0), // inOffset
      push32(10n), // value > 0
      push32(bytesToBigInt(selfAddress.bytes)), // to (code address) = self
      push32(50000n), // gas
      Uint8Array.of(0xf2), // CALLCODE
    )

    const result = await tvm.runCode({
      code,
      gasLimit: 100000n,
      to: selfAddress,
    })

    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.runState!.stack.peek()[0], 1n) // success = 1
  })

  it('traps CAN_NOT_TRANSFER_ASSET_YOURSELF on direct CALLTOKEN to self with tokenValue > 0', async () => {
    const tvm = await createTVM()
    const selfAddress = createAddressFromString('0x00000000000000000000000000000000000000dd')
    const account = createAccount({
      balance: 1000n,
      asset: { [tokenIdToKey(1000001n)]: 100n },
    })
    await tvm.stateManager.putAccount(selfAddress, account)

    // CALLTOKEN (0xd0) pops 8 items:
    // gas, to, value (tokenValue), tokenId, inOffset, inLength, outOffset, outLength
    const code = concatBytes(
      push32(BIGINT_0), // outLength
      push32(BIGINT_0), // outOffset
      push32(BIGINT_0), // inLength
      push32(BIGINT_0), // inOffset
      push32(1000001n), // tokenId
      push32(5n), // value (tokenValue) > 0
      push32(bytesToBigInt(selfAddress.bytes)), // to = self
      push32(50000n), // gas
      Uint8Array.of(0xd0), // CALLTOKEN
    )

    const result = await tvm.runCode({
      code,
      gasLimit: 100000n,
      to: selfAddress,
    })

    assert.strictEqual(
      result.exceptionError?.error,
      TVMError.errorMessages.CAN_NOT_TRANSFER_ASSET_YOURSELF,
    )
  })

  it('allows CALLCODE to self and preserves callValue and execution context', async () => {
    const tvm = await createTVM()
    const selfAddress = createAddressFromString('0x00000000000000000000000000000000000000ee')
    await tvm.stateManager.putAccount(selfAddress, new Account(BIGINT_0, 1000n))

    // Code executed by CALLCODE:
    // PUSH1 0x2a (42) -> CALLVALUE (which is 15) -> SSTORE (key 42 = 15) -> STOP
    // 0x34 (CALLVALUE), 0x60 0x2a (PUSH1 42), 0x55 (SSTORE), 0x00 (STOP)
    const targetCode = Uint8Array.of(
      0x34, // CALLVALUE
      0x60,
      0x2a, // PUSH1 0x2a (key)
      0x55, // SSTORE(key 42, value CALLVALUE)
      0x00, // STOP
    )
    await tvm.stateManager.putCode(selfAddress, targetCode)

    // Caller code executes CALLCODE to self with value 15
    const code = concatBytes(
      push32(BIGINT_0), // outLength
      push32(BIGINT_0), // outOffset
      push32(BIGINT_0), // inLength
      push32(BIGINT_0), // inOffset
      push32(15n), // value = 15
      push32(bytesToBigInt(selfAddress.bytes)), // to = self
      push32(50000n), // gas
      Uint8Array.of(0xf2), // CALLCODE
    )

    const result = await tvm.runCode({
      code,
      gasLimit: 100000n,
      to: selfAddress,
    })

    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.runState!.stack.peek()[0], 1n) // success = 1

    // Verify storage was written to selfAddress context
    const stored = await tvm.stateManager.getStorage(
      selfAddress,
      setLengthLeft(Uint8Array.of(0x2a), 32),
    )
    assert.strictEqual(bytesToBigInt(stored), 15n)
  })
})
