import { assert, describe, expect, it } from 'vitest'

import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import {
  Account,
  Address,
  bytesToBigInt,
  bytesToHex,
  generateTronContractAddress,
  generateTronCreateAddress,
  hexToBytes,
} from '@tvmjs/util'

import { Message, TVMError, createTVM, paramsTVM } from '../src/index.ts'

// TODO: This whole file was missing for quite some time and now (July 2024)
// has been side introduced along another PR. We should add basic initialization
// tests for options and the like.
describe('initialization', () => {
  it('basic initialization', async () => {
    const tvm = await createTVM()
    const msg = 'should use the correct parameter defaults'
    assert.isFalse(tvm.allowUnlimitedContractSize, msg)
  })

  it('TVM parameter customization', async () => {
    let tvm = await createTVM()
    assert.strictEqual(
      tvm.common.param('bn254AddGas'),
      BigInt(150),
      'should use default TVM parameters',
    )

    const params = JSON.parse(JSON.stringify(paramsTVM))
    params['1679']['bn254AddGas'] = 100 // 150
    tvm = await createTVM({ params })
    assert.strictEqual(
      tvm.common.param('bn254AddGas'),
      BigInt(100),
      'should use custom parameters provided',
    )
  })

  it('initializes transaction context for a top-level prebuilt Message', async () => {
    const tvm = await createTVM()
    const contract = new Address(hexToBytes('0x0000000000000000000000000000000000000100'))
    const message = new Message({
      to: contract,
      gasLimit: 100000n,
      // GASPRICE; MSTORE(0); RETURN(0, 32)
      code: hexToBytes('0x3a60005260206000f3'),
    })

    const result = await tvm.runCall({ message, gasPrice: 42n })

    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(bytesToBigInt(result.execResult.returnValue), 42n)
  })

  it('honors skipBalance for a top-level prebuilt Message', async () => {
    const tvm = await createTVM()
    const caller = new Address(hexToBytes('0x0000000000000000000000000000000000000100'))
    const recipient = new Address(hexToBytes('0x0000000000000000000000000000000000000101'))
    const message = new Message({
      caller,
      to: recipient,
      value: 1n,
      gasLimit: 100000n,
      code: hexToBytes('0x00'),
    })

    const result = await tvm.runCall({ message, skipBalance: true })

    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.balance, 0n)
    assert.strictEqual((await tvm.stateManager.getAccount(recipient))?.balance, 1n)
  })

  it('still honors skipBalance for a self-built nested call', async () => {
    const tvm = await createTVM()
    const caller = new Address(hexToBytes('0x0000000000000000000000000000000000000104'))
    const recipient = new Address(hexToBytes('0x0000000000000000000000000000000000000105'))

    const result = await tvm.runCall({
      caller,
      to: recipient,
      value: 1n,
      gasLimit: 100000n,
      depth: 1,
      skipBalance: true,
    })

    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual((await tvm.stateManager.getAccount(recipient))?.balance, 1n)
  })

  it('does not honor skipBalance for a caller-supplied nested Message', async () => {
    const tvm = await createTVM()
    const caller = new Address(hexToBytes('0x0000000000000000000000000000000000000102'))
    const recipient = new Address(hexToBytes('0x0000000000000000000000000000000000000103'))
    const message = new Message({
      caller,
      to: recipient,
      value: 1n,
      gasLimit: 100000n,
      depth: 1,
      code: hexToBytes('0x00'),
    })

    const result = await tvm.runCall({ message, skipBalance: true })

    assert.strictEqual(
      result.execResult.exceptionError?.error,
      TVMError.errorMessages.INSUFFICIENT_BALANCE,
    )
  })

  it('reverts balance, nonce, journal, and transient state when beforeMessage throws', async () => {
    const tvm = await createTVM()
    const caller = new Address(hexToBytes('0x0000000000000000000000000000000000000106'))
    const recipient = new Address(hexToBytes('0x0000000000000000000000000000000000000107'))
    await tvm.stateManager.putAccount(caller, new Account(0n, 0n))
    await tvm.stateManager.putCode(recipient, hexToBytes('0x00'))

    const before = await tvm.stateManager.getAccount(caller)
    const journalHeight = (tvm.journal as any).journalHeight
    const transientStorageDepth = (tvm.transientStorage as any)._indices.length
    tvm.events.once('beforeMessage', () => {
      throw new Error('beforeMessage listener failed')
    })

    await expect(
      tvm.runCall({
        caller,
        to: recipient,
        value: 100n,
        gasLimit: 100000n,
        skipBalance: true,
      }),
    ).rejects.toThrow('beforeMessage listener failed')

    const after = await tvm.stateManager.getAccount(caller)
    assert.strictEqual(after?.balance, before?.balance)
    assert.strictEqual(after?.nonce, before?.nonce)
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)
    assert.strictEqual((tvm.transientStorage as any)._indices.length, transientStorageDepth)

    assert.strictEqual(tvm.events.listenerCount('beforeMessage'), 0)
    const retry = await tvm.runCall({ caller, to: recipient, gasLimit: 100000n })
    assert.isUndefined(retry.execResult.exceptionError)
  })

  it('reverts balance, nonce, journal, and transient state when afterMessage throws', async () => {
    const tvm = await createTVM()
    const caller = new Address(hexToBytes('0x0000000000000000000000000000000000000106'))
    const recipient = new Address(hexToBytes('0x0000000000000000000000000000000000000107'))
    await tvm.stateManager.putAccount(caller, new Account(0n, 100n))
    await tvm.stateManager.putCode(recipient, hexToBytes('0x00'))

    const callerBefore = await tvm.stateManager.getAccount(caller)
    const recipientBefore = await tvm.stateManager.getAccount(recipient)
    const journalHeight = (tvm.journal as any).journalHeight
    const transientStorageDepth = (tvm.transientStorage as any)._indices.length
    tvm.events.once('afterMessage', () => {
      throw new Error('afterMessage listener failed')
    })

    await expect(
      tvm.runCall({
        caller,
        to: recipient,
        value: 10n,
        gasLimit: 100000n,
      }),
    ).rejects.toThrow('afterMessage listener failed')

    const callerAfter = await tvm.stateManager.getAccount(caller)
    const recipientAfter = await tvm.stateManager.getAccount(recipient)
    assert.strictEqual(callerAfter?.balance, callerBefore?.balance)
    assert.strictEqual(callerAfter?.nonce, callerBefore?.nonce)
    assert.strictEqual(recipientAfter?.balance, recipientBefore?.balance)
    assert.strictEqual(recipientAfter?.nonce, recipientBefore?.nonce)
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)
    assert.strictEqual((tvm.transientStorage as any)._indices.length, transientStorageDepth)

    assert.strictEqual(tvm.events.listenerCount('afterMessage'), 0)
    const retry = await tvm.runCall({ caller, to: recipient, gasLimit: 100000n })
    assert.isUndefined(retry.execResult.exceptionError)
  })

  it('reverts balance, nonce, journal, and transient state when newContract throws with skipBalance', async () => {
    const tvm = await createTVM()
    const caller = new Address(hexToBytes('0x0000000000000000000000000000000000000106'))
    const rootTransactionId = new Uint8Array(32)
    const createdAddress = new Address(generateTronContractAddress(rootTransactionId, caller.bytes))
    await tvm.stateManager.putAccount(caller, new Account(0n, 0n))

    const before = await tvm.stateManager.getAccount(caller)
    const journalHeight = (tvm.journal as any).journalHeight
    const transientStorageDepth = (tvm.transientStorage as any)._indices.length
    tvm.events.once('newContract', () => {
      throw new Error('newContract listener failed')
    })

    await expect(
      tvm.runCall({
        caller,
        gasLimit: 100000n,
        data: hexToBytes('0x00'),
        value: 100n,
        skipBalance: true,
        rootTransactionId,
      }),
    ).rejects.toThrow('newContract listener failed')

    const after = await tvm.stateManager.getAccount(caller)
    assert.strictEqual(after?.balance, before?.balance, 'balance should be rolled back')
    assert.strictEqual(after?.nonce, before?.nonce, 'nonce should be rolled back')
    assert.isUndefined(
      await tvm.stateManager.getAccount(createdAddress),
      'created account should be rolled back',
    )
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)
    assert.strictEqual((tvm.transientStorage as any)._indices.length, transientStorageDepth)

    assert.strictEqual(tvm.events.listenerCount('newContract'), 0)
    const retry = await tvm.runCall({
      caller,
      data: hexToBytes('0x00'),
      gasLimit: 100000n,
      rootTransactionId,
    })
    assert.isUndefined(retry.execResult.exceptionError)
  })

  it('invokes a once listener a single time and keeps ordinary listeners subscribed', async () => {
    const tvm = await createTVM()
    const recipient = new Address(hexToBytes('0x000000000000000000000000000000000000010a'))
    await tvm.stateManager.putCode(recipient, hexToBytes('0x00'))

    let onceCalls = 0
    let onCalls = 0
    tvm.events.once('beforeMessage', () => {
      onceCalls++
    })
    tvm.events.on('beforeMessage', () => {
      onCalls++
    })

    await tvm.runCall({ to: recipient, gasLimit: 100000n })
    await tvm.runCall({ to: recipient, gasLimit: 100000n })

    assert.strictEqual(onceCalls, 1)
    assert.strictEqual(onCalls, 2)
    assert.strictEqual(tvm.events.listenerCount('beforeMessage'), 1)
  })

  it('preserves mixed on/once registrations and listener context after an error', async () => {
    const tvm = await createTVM()
    const recipient = new Address(hexToBytes('0x000000000000000000000000000000000000010c'))
    await tvm.stateManager.putCode(recipient, hexToBytes('0x00'))
    const context = { calls: 0, shouldThrow: true }
    function listener(this: typeof context) {
      this.calls++
      if (this.shouldThrow) {
        throw new Error('ordinary listener failed')
      }
    }
    tvm.events.on('beforeMessage', listener, context)
    tvm.events.once('beforeMessage', listener, context)

    await expect(tvm.runCall({ to: recipient, gasLimit: 100000n })).rejects.toThrow(
      'ordinary listener failed',
    )
    assert.strictEqual(context.calls, 1)
    assert.strictEqual(tvm.events.listenerCount('beforeMessage'), 2)

    context.shouldThrow = false
    await tvm.runCall({ to: recipient, gasLimit: 100000n })
    await tvm.runCall({ to: recipient, gasLimit: 100000n })

    assert.strictEqual(context.calls, 4)
    assert.strictEqual(tvm.events.listenerCount('beforeMessage'), 1)
  })

  it('keeps the top-level nonce while reverting state for a VM execution error', async () => {
    const tvm = await createTVM()
    const caller = new Address(hexToBytes('0x0000000000000000000000000000000000000108'))
    const recipient = new Address(hexToBytes('0x0000000000000000000000000000000000000109'))
    await tvm.stateManager.putAccount(caller, new Account(0n, 100n))
    await tvm.stateManager.putCode(recipient, hexToBytes('0xfe'))

    const journalHeight = (tvm.journal as any).journalHeight
    const transientStorageDepth = (tvm.transientStorage as any)._indices.length
    const result = await tvm.runCall({
      caller,
      to: recipient,
      value: 10n,
      gasLimit: 100000n,
    })

    assert.strictEqual(
      result.execResult.exceptionError?.error,
      TVMError.errorMessages.INVALID_OPCODE,
    )
    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.nonce, 1n)
    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.balance, 100n)
    assert.strictEqual((await tvm.stateManager.getAccount(recipient))?.balance, 0n)
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)
    assert.strictEqual((tvm.transientStorage as any)._indices.length, transientStorageDepth)
  })

  it('restores journal bookkeeping when the StateManager checkpoint rejects', async () => {
    const tvm = await createTVM()
    const contract = new Address(hexToBytes('0x000000000000000000000000000000000000010a'))
    const originalCheckpoint = tvm.stateManager.checkpoint.bind(tvm.stateManager)
    const journalHeight = (tvm.journal as any).journalHeight
    let failCheckpoint = true

    tvm.stateManager.checkpoint = async () => {
      if (failCheckpoint) {
        failCheckpoint = false
        throw new Error('StateManager checkpoint failed')
      }
      await originalCheckpoint()
    }

    await expect(
      tvm.runCall({ to: contract, code: hexToBytes('0x00'), gasLimit: 100000n }),
    ).rejects.toThrow('StateManager checkpoint failed')
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)

    const retry = await tvm.runCall({ to: contract, code: hexToBytes('0x00'), gasLimit: 100000n })
    assert.isUndefined(retry.execResult.exceptionError)
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)
  })

  it('restores journal bookkeeping when the StateManager commit rejects', async () => {
    const tvm = await createTVM()
    const contract = new Address(hexToBytes('0x000000000000000000000000000000000000010b'))
    const originalCommit = tvm.stateManager.commit.bind(tvm.stateManager)
    const journalHeight = (tvm.journal as any).journalHeight
    let failCommit = true

    tvm.stateManager.commit = async () => {
      if (failCommit) {
        failCommit = false
        throw new Error('StateManager commit failed')
      }
      await originalCommit()
    }

    await expect(
      tvm.runCall({ to: contract, code: hexToBytes('0x00'), gasLimit: 100000n }),
    ).rejects.toThrow('StateManager commit failed')
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)

    const retry = await tvm.runCall({ to: contract, code: hexToBytes('0x00'), gasLimit: 100000n })
    assert.isUndefined(retry.execResult.exceptionError)
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)
  })

  it('keeps journal and StateManager checkpoints available to be retried when StateManager revert rejects', async () => {
    const tvm = await createTVM()
    const originalRevert = tvm.stateManager.revert.bind(tvm.stateManager)
    const journalHeight = (tvm.journal as any).journalHeight
    let failRevert = true

    await tvm.journal.checkpoint()
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight + 1)

    tvm.stateManager.revert = async () => {
      if (failRevert) {
        failRevert = false
        throw new Error('StateManager revert failed')
      }
      await originalRevert()
    }

    await expect(tvm.journal.revert()).rejects.toThrow('StateManager revert failed')
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight + 1)

    await tvm.journal.revert()
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)
  })

  it('fully restores an execution when the inner StateManager revert rejects once', async () => {
    const tvm = await createTVM()
    const caller = new Address(hexToBytes('0x000000000000000000000000000000000000010d'))
    const recipient = new Address(hexToBytes('0x000000000000000000000000000000000000010e'))
    await tvm.stateManager.putAccount(caller, new Account(0n, 100n))
    await tvm.stateManager.putCode(recipient, hexToBytes('0xfe'))

    const originalRevert = tvm.stateManager.revert.bind(tvm.stateManager)
    const journalHeight = (tvm.journal as any).journalHeight
    let failRevert = true
    tvm.stateManager.revert = async () => {
      if (failRevert) {
        failRevert = false
        throw new Error('inner StateManager revert failed once')
      }
      await originalRevert()
    }

    await expect(
      tvm.runCall({ caller, to: recipient, value: 10n, gasLimit: 100000n }),
    ).rejects.toThrow('inner StateManager revert failed once')

    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.nonce, 0n)
    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.balance, 100n)
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)
  })

  it('fully restores an execution when the outer StateManager revert rejects once', async () => {
    const tvm = await createTVM()
    const caller = new Address(hexToBytes('0x000000000000000000000000000000000000010f'))
    const recipient = new Address(hexToBytes('0x0000000000000000000000000000000000000110'))
    await tvm.stateManager.putAccount(caller, new Account(0n, 100n))
    await tvm.stateManager.putCode(recipient, hexToBytes('0x00'))

    const originalRevert = tvm.stateManager.revert.bind(tvm.stateManager)
    const journalHeight = (tvm.journal as any).journalHeight
    let failRevert = true
    tvm.stateManager.revert = async () => {
      if (failRevert) {
        failRevert = false
        throw new Error('outer StateManager revert failed once')
      }
      await originalRevert()
    }
    tvm.events.once('beforeMessage', () => {
      throw new Error('beforeMessage listener failed')
    })

    await expect(
      tvm.runCall({ caller, to: recipient, value: 10n, gasLimit: 100000n }),
    ).rejects.toThrow('beforeMessage listener failed')

    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.nonce, 0n)
    assert.strictEqual((await tvm.stateManager.getAccount(caller))?.balance, 100n)
    assert.strictEqual((tvm.journal as any).journalHeight, journalHeight)
  })

  it('fully restores the block access list when a host hook rejects execution', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Amsterdam })
    const tvm = await createTVM({ common })
    const recipient = new Address(hexToBytes('0x0000000000000000000000000000000000000111'))
    // PUSH1 0; SLOAD; STOP
    await tvm.stateManager.putCode(recipient, hexToBytes('0x60005400'))
    tvm.events.once('afterMessage', () => {
      throw new Error('afterMessage listener failed')
    })

    await expect(tvm.runCall({ to: recipient, gasLimit: 100000n })).rejects.toThrow(
      'afterMessage listener failed',
    )

    assert.deepEqual(tvm.blockLevelAccessList?.raw(), [])
  })

  it('resets TRON transaction context when a top-level Message is reused', async () => {
    const tvm = await createTVM()
    const contract = new Address(hexToBytes('0x0000000000000000000000000000000000000200'))
    const message = new Message({
      to: contract,
      gasLimit: 100000n,
      // CREATE with empty initcode; MSTORE(0); RETURN(0, 32)
      code: hexToBytes('0x600060006000f060005260206000f3'),
    })
    const firstRootTransactionId = new Uint8Array(32)
    const secondRootTransactionId = new Uint8Array(32)
    secondRootTransactionId[31] = 1

    const firstResult = await tvm.runCall({
      message,
      rootTransactionId: firstRootTransactionId,
    })
    const result = await tvm.runCall({ message, rootTransactionId: secondRootTransactionId })

    const firstAddress = bytesToHex(firstResult.execResult.returnValue.subarray(-20))
    const secondAddress = bytesToHex(result.execResult.returnValue.subarray(-20))

    assert.strictEqual(
      secondAddress,
      bytesToHex(generateTronCreateAddress(secondRootTransactionId, 0n)),
    )
    assert.strictEqual(message.createdAddresses?.size, 1)
    assert.isFalse(message.createdAddresses?.has(firstAddress))
    assert.isTrue(message.createdAddresses?.has(secondAddress))

    await expect(tvm.runCall({ message })).rejects.toThrow(
      /rootTransactionId is required for TRON internal CREATE/,
    )
  })

  it('does not leak selfdestruct entries when a top-level Message is reused', async () => {
    const tvm = await createTVM()
    const firstContract = new Address(hexToBytes('0x0000000000000000000000000000000000000200'))
    const secondContract = new Address(hexToBytes('0x0000000000000000000000000000000000000201'))
    const beneficiary = '00000000000000000000000000000000000000ff'
    const message = new Message({
      to: firstContract,
      gasLimit: 100000n,
      code: hexToBytes(`0x73${beneficiary}ff`),
    })

    const firstResult = await tvm.runCall({ message })
    assert.strictEqual(firstResult.execResult.selfdestruct?.size, 1)

    message.to = secondContract
    message.code = hexToBytes('0x00')
    const secondResult = await tvm.runCall({ message })

    assert.strictEqual(secondResult.execResult.selfdestruct?.size, 0)
    assert.strictEqual(message.selfdestruct?.size, 0)
  })
})

describe('profiler timer lifecycle', () => {
  it('completes a top-level prebuilt Message call with the profiler enabled', async () => {
    const tvm = await createTVM({ profiler: { enabled: true } })
    const message = new Message({
      to: new Address(hexToBytes('0x0000000000000000000000000000000000000300')),
      gasLimit: 100000n,
      code: hexToBytes('0x00'),
    })

    const result = await tvm.runCall({ message })

    assert.isUndefined(result.execResult.exceptionError)
    assert.isFalse((tvm as any).performanceLogger.hasTimer(), 'timer should be released')
  })

  it('releases the profiler timer when execution throws', async () => {
    const tvm = await createTVM({ profiler: { enabled: true } })
    const contract = new Address(hexToBytes('0x0000000000000000000000000000000000000302'))

    // Execute an internal CREATE from a top-level call so the outer profiler timer is active.
    await tvm.stateManager.putCode(contract, hexToBytes('0x600060006000f000'))

    await expect(tvm.runCall({ to: contract, gasLimit: 100000n })).rejects.toThrow(
      /rootTransactionId is required/,
    )

    assert.isFalse((tvm as any).performanceLogger.hasTimer(), 'timer must not leak after a failure')
    assert.strictEqual((tvm as any)._activeExecutions, 0, 'active execution count must be restored')

    // The next call must not fail with 'Cannot have two timers running at the same time'.
    const result = await tvm.runCall({ to: contract, code: hexToBytes('0x00'), gasLimit: 100000n })
    assert.isUndefined(result.execResult.exceptionError)
  })

  it('releases a precompile timer when a standalone nested call throws', async () => {
    const precompile = new Address(hexToBytes('0x000000000000000000000000000000000000ff01'))
    const tvm = await createTVM({
      profiler: { enabled: true },
      customPrecompiles: [
        {
          address: precompile,
          function: () => {
            throw new Error('custom precompile failure')
          },
        },
      ],
    })

    await expect(tvm.runCall({ to: precompile, depth: 1, gasLimit: 100000n })).rejects.toThrow(
      /custom precompile failure/,
    )

    assert.isFalse((tvm as any).performanceLogger.hasTimer(), 'precompile timer must be released')
    assert.strictEqual((tvm as any)._activeExecutions, 0)
    const result = await tvm.runCall({
      to: precompile,
      code: hexToBytes('0x00'),
      gasLimit: 100000n,
    })
    assert.isUndefined(result.execResult.exceptionError)
  })

  it('does not start a timer for a nested prebuilt Message', async () => {
    const tvm = await createTVM({ profiler: { enabled: true } })

    const message = new Message({
      to: new Address(hexToBytes('0x0000000000000000000000000000000000000301')),
      gasLimit: 100000n,
      depth: 1,
      code: hexToBytes('0x00'),
    })
    const result = await tvm.runCall({ message })

    assert.isUndefined(result.execResult.exceptionError)
    assert.isFalse((tvm as any).performanceLogger.hasTimer(), 'no timer for a nested call')
  })
})

describe('standalone nested Message context', () => {
  const contextCode = hexToBytes('0x326000523a60205260406000f3')

  function assertContext(
    returnValue: Uint8Array,
    expectedOrigin: Address,
    expectedGasPrice: bigint,
  ) {
    assert.strictEqual(bytesToHex(returnValue.subarray(12, 32)), expectedOrigin.toString())
    assert.strictEqual(bytesToBigInt(returnValue.subarray(32, 64)), expectedGasPrice)
  }

  it('initializes transaction context for a nested prebuilt Message on a fresh TVM', async () => {
    const tvm = await createTVM()
    const origin = new Address(hexToBytes('0x0000000000000000000000000000000000000400'))
    const message = new Message({
      to: new Address(hexToBytes('0x0000000000000000000000000000000000000401')),
      gasLimit: 100000n,
      depth: 1,
      code: contextCode,
    })

    const result = await tvm.runCall({ message, origin, gasPrice: 42n })

    assert.isUndefined(result.execResult.exceptionError)
    assertContext(result.execResult.returnValue, origin, 42n)
  })

  it('does not inherit transaction context from a previous standalone call', async () => {
    const tvm = await createTVM()
    const firstOrigin = new Address(hexToBytes('0x0000000000000000000000000000000000000402'))
    const secondOrigin = new Address(hexToBytes('0x0000000000000000000000000000000000000403'))
    await tvm.runCall({
      to: firstOrigin,
      code: hexToBytes('0x00'),
      gasLimit: 100000n,
      origin: firstOrigin,
      gasPrice: 1n,
    })

    const message = new Message({
      to: new Address(hexToBytes('0x0000000000000000000000000000000000000404')),
      gasLimit: 100000n,
      depth: 1,
      code: contextCode,
    })
    const result = await tvm.runCall({ message, origin: secondOrigin, gasPrice: 43n })

    assert.isUndefined(result.execResult.exceptionError)
    assertContext(result.execResult.returnValue, secondOrigin, 43n)
  })

  it('preserves the outer transaction context for an interpreter nested call', async () => {
    const tvm = await createTVM()
    const origin = new Address(hexToBytes('0x0000000000000000000000000000000000000405'))
    const outer = new Address(hexToBytes('0x0000000000000000000000000000000000000406'))
    const inner = new Address(hexToBytes('0x0000000000000000000000000000000000000407'))
    await tvm.stateManager.putCode(inner, contextCode)
    await tvm.stateManager.putCode(
      outer,
      hexToBytes(`0x6040600060006000600073${bytesToHex(inner.bytes).slice(2)}61fffff15060406000f3`),
    )

    const result = await tvm.runCall({ to: outer, origin, gasPrice: 44n, gasLimit: 200000n })

    assert.isUndefined(result.execResult.exceptionError)
    assertContext(result.execResult.returnValue, origin, 44n)
    assert.strictEqual((tvm as any)._activeExecutions, 0)
  })
})

describe('public execution concurrency', () => {
  it('rejects an overlapping public call even when it claims to be nested', async () => {
    const tvm = await createTVM()
    let releaseFirstCall!: () => void
    let markFirstCallEntered!: () => void
    const firstCallEntered = new Promise<void>((resolve) => {
      markFirstCallEntered = resolve
    })
    const firstCallGate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve
    })
    tvm.events.once('beforeMessage', (_message, resolve) => {
      markFirstCallEntered()
      void firstCallGate.then(resolve)
    })

    const target = new Address(hexToBytes('0x0000000000000000000000000000000000000500'))
    const firstCall = tvm.runCall({ to: target, code: hexToBytes('0x00'), gasLimit: 100000n })
    await firstCallEntered
    try {
      await expect(
        tvm.runCall({ to: target, code: hexToBytes('0x00'), gasLimit: 100000n, depth: 1 }),
      ).rejects.toThrow(/Concurrent public TVM execution/)
    } finally {
      releaseFirstCall()
    }

    const result = await firstCall
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual((tvm as any)._activeExecutions, 0)
  })

  it('rejects overlapping runCode invocations', async () => {
    const tvm = await createTVM()
    let releaseFirstExecution!: () => void
    let markFirstLookup!: () => void
    const firstLookup = new Promise<void>((resolve) => {
      markFirstLookup = resolve
    })
    const executionGate = new Promise<void>((resolve) => {
      releaseFirstExecution = resolve
    })
    const stateManager = tvm.stateManager as any
    const getAccount = stateManager.getAccount.bind(stateManager)
    let isFirstLookup = true
    stateManager.getAccount = async (...args: any[]) => {
      if (isFirstLookup) {
        isFirstLookup = false
        markFirstLookup()
        await executionGate
      }
      return getAccount(...args)
    }

    const firstRunCode = tvm.runCode({ code: hexToBytes('0x00'), gasLimit: 100000n })
    await firstLookup
    try {
      await expect(tvm.runCode({ code: hexToBytes('0x00'), gasLimit: 100000n })).rejects.toThrow(
        /Concurrent public TVM execution/,
      )
    } finally {
      releaseFirstExecution()
    }

    await firstRunCode
    assert.strictEqual((tvm as any)._activeExecutions, 0)
  })

  it('rejects overlapping runCode and runCall invocations', async () => {
    const tvm = await createTVM()
    let releaseFirstExecution!: () => void
    let markFirstLookup!: () => void
    const firstLookup = new Promise<void>((resolve) => {
      markFirstLookup = resolve
    })
    const executionGate = new Promise<void>((resolve) => {
      releaseFirstExecution = resolve
    })
    const stateManager = tvm.stateManager as any
    const getAccount = stateManager.getAccount.bind(stateManager)
    let isFirstLookup = true
    stateManager.getAccount = async (...args: any[]) => {
      if (isFirstLookup) {
        isFirstLookup = false
        markFirstLookup()
        await executionGate
      }
      return getAccount(...args)
    }

    const firstRunCode = tvm.runCode({ code: hexToBytes('0x00'), gasLimit: 100000n })
    await firstLookup
    try {
      await expect(tvm.runCall({ code: hexToBytes('0x00'), gasLimit: 100000n })).rejects.toThrow(
        /Concurrent public TVM execution/,
      )
    } finally {
      releaseFirstExecution()
    }

    await firstRunCode
    assert.strictEqual((tvm as any)._activeExecutions, 0)
  })
})
