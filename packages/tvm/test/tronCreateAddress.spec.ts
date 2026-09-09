// cspell:ignore selfdestructor
import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import {
  Address,
  bigIntToBytes,
  bytesToHex,
  concatBytes,
  generateAddress,
  generateAddress2,
  generateTronAddress2,
  generateTronContractAddress,
  generateTronCreateAddress,
  hexToBytes,
  setLengthLeft,
} from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import { createTVM } from '../src/index.ts'

const ROOT_TRANSACTION_ID = hexToBytes(
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
)
const CREATOR = new Address(hexToBytes('0x0000000000000000000000000000000000000100'))

function returnedAddress(returnValue: Uint8Array): string {
  return bytesToHex(returnValue.subarray(-20))
}

function tronStackAddress(address: Uint8Array): Uint8Array {
  return setLengthLeft(concatBytes(Uint8Array.of(0x41), address), 32)
}

describe('TRON CREATE address derivation', () => {
  it('derives a top-level deployment address from the transaction ID and owner address', async () => {
    const tvm = await createTVM()

    const result = await tvm.runCall({
      caller: CREATOR,
      data: hexToBytes('0x00'),
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.strictEqual(
      result.createdAddress?.toString(),
      bytesToHex(generateTronContractAddress(ROOT_TRANSACTION_ID, CREATOR.bytes)),
    )
  })

  it('requires rootTransactionId for a top-level TRON deployment', async () => {
    const tvm = await createTVM({ profiler: { enabled: true } })

    for (let i = 0; i < 3; i++) {
      await expect(tvm.runCall({ caller: CREATOR, data: hexToBytes('0x00') })).rejects.toThrow(
        /rootTransactionId is required for TRON contract deployment/,
      )
      assert.isFalse((tvm as any).performanceLogger.hasTimer())
    }

    assert.isUndefined(
      await tvm.stateManager.getAccount(CREATOR),
      'invalid deployment must not create or increment the caller account',
    )

    const result = await tvm.runCall({
      caller: CREATOR,
      data: hexToBytes('0x00'),
      rootTransactionId: ROOT_TRANSACTION_ID,
    })
    assert.strictEqual(
      result.createdAddress?.toString(),
      bytesToHex(generateTronContractAddress(ROOT_TRANSACTION_ID, CREATOR.bytes)),
    )
    assert.strictEqual((await tvm.stateManager.getAccount(CREATOR))?.nonce, 1n)
  })

  it('uses rootTransactionId and the transaction-wide internal nonce', async () => {
    const tvm = await createTVM()
    // CREATE with empty initcode, then return the created address.
    await tvm.stateManager.putCode(CREATOR, hexToBytes('0x600060006000f060005260206000f3'))

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.deepEqual(
      result.execResult.returnValue,
      tronStackAddress(generateTronCreateAddress(ROOT_TRANSACTION_ID, 0n)),
    )
  })

  it('returns the 0x41-prefixed TRON address word from CREATE2', async () => {
    const tvm = await createTVM()
    const salt = new Uint8Array(32)
    salt[31] = 1
    const emptyCode = new Uint8Array(0)

    await tvm.stateManager.putCode(CREATOR, hexToBytes('0x6001600060006000f560005260206000f3'))
    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.deepEqual(
      result.execResult.returnValue,
      tronStackAddress(generateTronAddress2(CREATOR.bytes, salt, emptyCode)),
    )
  })

  it('tracks a successful CREATE through runCode when EIP-6780 is active', async () => {
    const tvm = await createTVM()
    const expectedAddress = generateTronCreateAddress(ROOT_TRANSACTION_ID, 0n)

    const result = await tvm.runCode({
      // CREATE with empty initcode, then return the created address.
      code: hexToBytes('0x600060006000f060005260206000f3'),
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
      gasLimit: 200000n,
    })

    assert.isUndefined(result.exceptionError)
    assert.deepEqual(result.returnValue, tronStackAddress(expectedAddress))
    assert.isTrue(result.createdAddresses?.has(bytesToHex(expectedAddress)))
    assert.isDefined(await tvm.stateManager.getAccount(new Address(expectedAddress)))
  })

  it('tracks a successful CREATE2 in a caller-provided runCode set', async () => {
    const tvm = await createTVM()
    const salt = new Uint8Array(32)
    salt[31] = 1
    const expectedAddress = generateTronAddress2(CREATOR.bytes, salt, new Uint8Array())
    const createdAddresses = new Set<`0x${string}`>()

    const result = await tvm.runCode({
      // CREATE2 with salt 1 and empty initcode, then return the created address.
      code: hexToBytes('0x6001600060006000f560005260206000f3'),
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
      gasLimit: 200000n,
      createdAddresses,
    })

    assert.isUndefined(result.exceptionError)
    assert.deepEqual(result.returnValue, tronStackAddress(expectedAddress))
    assert.strictEqual(result.createdAddresses, createdAddresses)
    assert.isTrue(createdAddresses.has(bytesToHex(expectedAddress)))
    assert.isDefined(await tvm.stateManager.getAccount(new Address(expectedAddress)))
  })

  it('returns zero when CREATE fails', async () => {
    const tvm = await createTVM()
    // The creator has no balance, so CREATE with value=1 fails before address generation.
    await tvm.stateManager.putCode(CREATOR, hexToBytes('0x600060006001f060005260206000f3'))

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.deepEqual(result.execResult.returnValue, new Uint8Array(32))
  })

  it('increments the shared internal nonce for consecutive CREATE operations', async () => {
    const tvm = await createTVM()
    // CREATE once and discard the result, then CREATE again and return its address.
    await tvm.stateManager.putCode(
      CREATOR,
      hexToBytes('0x600060006000f050600060006000f060005260206000f3'),
    )

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.strictEqual(
      returnedAddress(result.execResult.returnValue),
      bytesToHex(generateTronCreateAddress(ROOT_TRANSACTION_ID, 1n)),
    )
  })

  it('increments the shared internal nonce for a CALL before CREATE', async () => {
    const tvm = await createTVM()
    const callee = new Address(hexToBytes('0x0000000000000000000000000000000000000200'))
    await tvm.stateManager.putCode(callee, hexToBytes('0x00'))

    const callThenCreate =
      (`0x6000600060006000600073${bytesToHex(callee.bytes).slice(2)}61fffff150` +
        '600060006000f060005260206000f3') as `0x${string}`
    await tvm.stateManager.putCode(CREATOR, hexToBytes(callThenCreate))

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.strictEqual(
      returnedAddress(result.execResult.returnValue),
      bytesToHex(generateTronCreateAddress(ROOT_TRANSACTION_ID, 1n)),
    )
  })

  it('does not increment the shared nonce when CALLTOKEN has insufficient balance', async () => {
    const tvm = await createTVM()
    const callee = new Address(hexToBytes('0x0000000000000000000000000000000000000200'))
    const tokenId = 1000001n
    ;(tvm.stateManager as any).tokenIdExists = async () => true

    const callTokenThenCreate =
      (`0x600060006000600062${tokenId.toString(16).padStart(6, '0')}600173${bytesToHex(callee.bytes).slice(2)}` +
        '61ffffd050600060006000f060005260206000f3') as `0x${string}`
    await tvm.stateManager.putCode(CREATOR, hexToBytes(callTokenThenCreate))

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.strictEqual(
      returnedAddress(result.execResult.returnValue),
      bytesToHex(generateTronCreateAddress(ROOT_TRANSACTION_ID, 0n)),
    )
  })

  it('increments the shared internal nonce for CREATE2 before CREATE', async () => {
    const tvm = await createTVM()
    // CREATE2 with salt 1 and empty initcode, discard it, then CREATE and return its address.
    await tvm.stateManager.putCode(
      CREATOR,
      hexToBytes('0x6001600060006000f550600060006000f060005260206000f3'),
    )

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.strictEqual(
      returnedAddress(result.execResult.returnValue),
      bytesToHex(generateTronCreateAddress(ROOT_TRANSACTION_ID, 1n)),
    )
  })

  it('requires rootTransactionId when TRON execution reaches internal CREATE', async () => {
    const tvm = await createTVM()
    await tvm.stateManager.putCode(CREATOR, hexToBytes('0x600060006000f000'))

    assert.strictEqual((tvm.journal as any).journalHeight, 0)
    await expect(tvm.runCall({ to: CREATOR })).rejects.toThrow(
      /rootTransactionId is required for TRON internal CREATE/,
    )
    assert.strictEqual(
      (tvm.journal as any).journalHeight,
      0,
      'an unexpected execution error must revert the active message checkpoint',
    )

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(
      (tvm.journal as any).journalHeight,
      0,
      'a later successful call must still start and finish at journal height zero',
    )
  })

  it('rejects a rootTransactionId that is not 32 bytes', async () => {
    const tvm = await createTVM()

    await expect(
      tvm.runCall({ to: CREATOR, rootTransactionId: new Uint8Array(31) }),
    ).rejects.toThrow(/rootTransactionId to be of length 32/)
  })

  it('keeps Ethereum CREATE derivation unchanged', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Constantinople })
    const tvm = await createTVM({ common })
    await tvm.stateManager.putCode(CREATOR, hexToBytes('0x600060006000f060005260206000f3'))

    const result = await tvm.runCall({ to: CREATOR })

    assert.deepEqual(
      result.execResult.returnValue,
      setLengthLeft(generateAddress(CREATOR.bytes, bigIntToBytes(0n)), 32),
    )
  })

  it('keeps the pre-TRON CREATE2 stack result unprefixed', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Constantinople })
    const tvm = await createTVM({ common })
    const salt = new Uint8Array(32)
    salt[31] = 1
    const emptyCode = new Uint8Array(0)

    await tvm.stateManager.putCode(CREATOR, hexToBytes('0x6001600060006000f560005260206000f3'))
    const result = await tvm.runCall({ to: CREATOR })

    assert.deepEqual(
      result.execResult.returnValue,
      setLengthLeft(generateAddress2(CREATOR.bytes, salt, emptyCode), 32),
    )
  })

  it('advances nonce even when CREATE collides, so the next CREATE uses nonce+1', async () => {
    const tvm = await createTVM()
    const firstAddr = generateTronCreateAddress(ROOT_TRANSACTION_ID, 1n)
    const collisionHelper = new Address(hexToBytes('0x0000000000000000000000000000000000000201'))
    const createHelper = new Address(hexToBytes('0x0000000000000000000000000000000000000202'))
    // Pre-occupy the first address
    await tvm.stateManager.putCode(new Address(firstAddr), hexToBytes('0x00'))

    // Run the colliding CREATE in a bounded child call so TRON's full gas
    // forwarding cannot consume the outer frame before the second CREATE.
    await tvm.stateManager.putCode(collisionHelper, hexToBytes('0x600060006000f000'))
    await tvm.stateManager.putCode(createHelper, hexToBytes('0x600060006000f060005260206000f3'))
    await tvm.stateManager.putCode(
      CREATOR,
      hexToBytes(
        (`0x6000600060006000600073${bytesToHex(collisionHelper.bytes).slice(2)}61fffff150` +
          `6020600060006000600073${bytesToHex(createHelper.bytes).slice(2)}61fffff160206000f3`) as `0x${string}`,
      ),
    )

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    // The two helper CALLs consume nonces 0 and 1, then the colliding CREATE
    // advances the shared nonce to 2 before the successful CREATE.
    assert.strictEqual(
      returnedAddress(result.execResult.returnValue),
      bytesToHex(generateTronCreateAddress(ROOT_TRANSACTION_ID, 3n)),
    )
  })

  it('advances nonce even when CREATE2 collides, so the next CREATE uses nonce+1', async () => {
    const tvm = await createTVM()

    // Calculate the actual CREATE2 target address
    const salt = new Uint8Array(32)
    salt[31] = 1
    const emptyCode = new Uint8Array(0)
    const collisionHelper = new Address(hexToBytes('0x0000000000000000000000000000000000000201'))
    const createHelper = new Address(hexToBytes('0x0000000000000000000000000000000000000202'))
    const create2Addr = generateTronAddress2(collisionHelper.bytes, salt, emptyCode)

    // Pre-occupy the address CREATE2 will attempt to use
    await tvm.stateManager.putCode(new Address(create2Addr), hexToBytes('0x00'))

    // CREATE2 (collides) then CREATE. Keep the collision in a bounded child
    // call because TRON version-0 forwards all requested child energy.
    await tvm.stateManager.putCode(collisionHelper, hexToBytes('0x6001600060006000f55000'))
    await tvm.stateManager.putCode(createHelper, hexToBytes('0x600060006000f060005260206000f3'))
    await tvm.stateManager.putCode(
      CREATOR,
      hexToBytes(
        (`0x6000600060006000600073${bytesToHex(collisionHelper.bytes).slice(2)}61fffff150` +
          `6020600060006000600073${bytesToHex(createHelper.bytes).slice(2)}61fffff160206000f3`) as `0x${string}`,
      ),
    )

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    // The two helper CALLs consume nonces 0 and 1, then the colliding CREATE2
    // advances the shared nonce to 2 before the successful CREATE.
    assert.strictEqual(
      returnedAddress(result.execResult.returnValue),
      bytesToHex(generateTronCreateAddress(ROOT_TRANSACTION_ID, 3n)),
    )
  })

  it('advances nonce when SELFDESTRUCT executes in a nested call before CREATE', async () => {
    const tvm = await createTVM()
    const selfdestructor = new Address(hexToBytes('0x0000000000000000000000000000000000000200'))
    // SELFDESTRUCT to caller
    await tvm.stateManager.putCode(selfdestructor, hexToBytes('0x33ff'))

    // CALL selfdestructor, then CREATE
    const callThenCreate =
      (`0x6000600060006000600073${bytesToHex(selfdestructor.bytes).slice(2)}61fffff150` +
        '600060006000f060005260206000f3') as `0x${string}`
    await tvm.stateManager.putCode(CREATOR, hexToBytes(callThenCreate))

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    // CALL advances nonce to 1, SELFDESTRUCT advances to 2, so CREATE uses nonce=2
    assert.strictEqual(
      returnedAddress(result.execResult.returnValue),
      bytesToHex(generateTronCreateAddress(ROOT_TRANSACTION_ID, 2n)),
    )
  })

  it('advances nonce for every repeated SELFDESTRUCT invocation', async () => {
    const tvm = await createTVM()
    const selfdestructor = new Address(hexToBytes('0x0000000000000000000000000000000000000200'))
    await tvm.stateManager.putCode(selfdestructor, hexToBytes('0x33ff'))

    // A pre-existing contract remains callable until transaction finalization.
    // Invoke it twice from the outer frame, then CREATE and return the address.
    const callSelfdestructor = `6000600060006000600073${bytesToHex(selfdestructor.bytes).slice(2)}61fffff150`
    const callTwiceThenCreate = (`0x${callSelfdestructor}${callSelfdestructor}` +
      '600060006000f060005260206000f3') as `0x${string}`
    await tvm.stateManager.putCode(CREATOR, hexToBytes(callTwiceThenCreate))

    const result = await tvm.runCall({
      to: CREATOR,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    // CALL1 -> 1, SELFDESTRUCT1 -> 2, CALL2 -> 3, SELFDESTRUCT2 -> 4.
    assert.strictEqual(
      returnedAddress(result.execResult.returnValue),
      bytesToHex(generateTronCreateAddress(ROOT_TRANSACTION_ID, 4n)),
    )
  })

  it('advances nonce when SELFDESTRUCT executes at transaction depth zero', async () => {
    const tvm = await createTVM()
    const selfdestructor = new Address(hexToBytes('0x0000000000000000000000000000000000000200'))
    await tvm.stateManager.putCode(selfdestructor, hexToBytes('0x33ff'))

    let transactionContext: { nonce: bigint } | undefined
    tvm.events.once('beforeMessage', (message) => {
      transactionContext = message.tronTransactionContext
    })

    const result = await tvm.runCall({
      to: selfdestructor,
      rootTransactionId: ROOT_TRANSACTION_ID,
    })

    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(transactionContext?.nonce, 1n)
  })
})
