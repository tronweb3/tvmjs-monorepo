import { createBlock } from '@tvmjs/block'
import { createFeeMarket1559Tx } from '@tvmjs/tx'
import { Account, bytesToHex, hexToBytes } from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import { SIGNER_A } from '@tvmjs/testdata'
import { createVM, runBlock, runTx } from '../../src/index.ts'

describe('VM events', () => {
  const rootTransactionId = hexToBytes(
    '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  )

  it('should invoke a once listener once and remove it before an error is thrown', async () => {
    const vm = await createVM()
    const block = createBlock({}, { common: vm.common })
    let calls = 0
    vm.events.once('beforeBlock', () => {
      calls++
      throw new Error('beforeBlock listener failed')
    })

    await expect(vm._emit('beforeBlock', block)).rejects.toThrow('beforeBlock listener failed')
    await vm._emit('beforeBlock', block)

    assert.strictEqual(calls, 1)
    assert.strictEqual(vm.events.listenerCount('beforeBlock'), 0)
  })

  it('should preserve mixed on/once registrations and listener context after an error', async () => {
    const vm = await createVM()
    const block = createBlock({}, { common: vm.common })
    const context = { calls: 0, shouldThrow: true }
    function listener(this: typeof context) {
      this.calls++
      if (this.shouldThrow) {
        throw new Error('ordinary listener failed')
      }
    }
    vm.events.on('beforeBlock', listener, context)
    vm.events.once('beforeBlock', listener, context)

    await expect(vm._emit('beforeBlock', block)).rejects.toThrow('ordinary listener failed')
    assert.strictEqual(context.calls, 1)
    assert.strictEqual(vm.events.listenerCount('beforeBlock'), 2)

    context.shouldThrow = false
    await vm._emit('beforeBlock', block)
    await vm._emit('beforeBlock', block)

    assert.strictEqual(context.calls, 4)
    assert.strictEqual(vm.events.listenerCount('beforeBlock'), 1)
  })

  it('should emit the Block before running it', async () => {
    const vm = await createVM()

    let emitted
    const handler = (val: any) => {
      emitted = val
    }
    vm.events.once('beforeBlock', handler)

    const block = createBlock({}, { common: vm.common })

    await runBlock(vm, {
      block,
      generate: true,
      skipBlockValidation: true,
    })

    assert.strictEqual(emitted, block)
  })

  it('should emit a RunBlockResult after running a block', async () => {
    const vm = await createVM()

    let emitted
    const handler = (val: any) => {
      emitted = val
    }
    vm.events.once('afterBlock', handler)

    const block = createBlock({}, { common: vm.common })

    await runBlock(vm, {
      block,
      generate: true,
      skipBlockValidation: true,
    })

    assert.deepEqual((emitted as any).receipts, [])
    assert.deepEqual((emitted as any).results, [])
  })

  it('should emit the Transaction before running it', async () => {
    const vm = await createVM()

    let emitted
    const handler = (val: any) => {
      emitted = val
    }
    vm.events.once('beforeTx', handler)

    const tx = createFeeMarket1559Tx(
      {
        gasLimit: 90000,
        maxFeePerGas: 40000,
        to: '0x1111111111111111111111111111111111111111',
      },
      { common: vm.common },
    ).sign(SIGNER_A.privateKey)

    await runTx(vm, {
      tx,
      skipBalance: true,
      skipHardForkValidation: true,
    })

    assert.strictEqual(emitted, tx)
  })

  it('should emit RunTxResult after running a tx', async () => {
    const vm = await createVM()
    await vm.stateManager.putAccount(SIGNER_A.address, new Account(BigInt(0), BigInt(0x11111111)))
    let emitted: any
    const handler = (val: any) => {
      emitted = val
    }
    vm.events.once('afterTx', handler)

    const tx = createFeeMarket1559Tx(
      {
        gasLimit: 90000,
        maxFeePerGas: 40000,
        to: '0x1111111111111111111111111111111111111111',
        value: 1,
      },
      { common: vm.common },
    ).sign(SIGNER_A.privateKey)

    await runTx(vm, {
      tx,
      skipBalance: true,
      skipHardForkValidation: true,
    })

    assert.strictEqual(bytesToHex(emitted.execResult.returnValue), '0x')
  })

  it('should emit the Message before running it', async () => {
    const vm = await createVM()
    await vm.stateManager.putAccount(SIGNER_A.address, new Account(BigInt(0), BigInt(0x11111111)))
    let emitted: any
    const handler = (val: any, resolve?: () => void) => {
      emitted = val
      resolve?.()
    }
    vm.tvm.events!.once('beforeMessage', handler)

    const tx = createFeeMarket1559Tx(
      {
        gasLimit: 90000,
        maxFeePerGas: 40000,
        to: '0x1111111111111111111111111111111111111111',
        value: 1,
      },
      { common: vm.common },
    ).sign(SIGNER_A.privateKey)

    await runTx(vm, {
      tx,
      skipBalance: true,
      skipHardForkValidation: true,
    })

    assert.strictEqual(emitted.to.toString(), '0x1111111111111111111111111111111111111111')
    assert.strictEqual(bytesToHex(emitted.code), '0x')
  })

  it('should emit TVMResult after running a message', async () => {
    const vm = await createVM()
    await vm.stateManager.putAccount(SIGNER_A.address, new Account(BigInt(0), BigInt(0x11111111)))
    let emitted: any
    const handler = (val: any, resolve?: () => void) => {
      emitted = val
      resolve?.()
    }
    vm.tvm.events!.once('afterMessage', handler)

    const tx = createFeeMarket1559Tx(
      {
        gasLimit: 90000,
        maxFeePerGas: 40000,
        to: '0x1111111111111111111111111111111111111111',
        value: 1,
      },
      { common: vm.common },
    ).sign(SIGNER_A.privateKey)

    await runTx(vm, {
      tx,
      skipBalance: true,
      skipHardForkValidation: true,
    })

    assert.strictEqual(bytesToHex(emitted.execResult.returnValue), '0x')
  })

  it('should emit InterpreterStep on each step', async () => {
    const vm = await createVM()

    let lastEmitted
    const handler = (val: unknown) => {
      lastEmitted = val
    }
    vm.tvm.events!.on('step', handler)

    // This is a deployment transaction that pushes 0x41 (i.e. ascii A) followed by 31 0s to
    // the stack, stores that in memory, and then returns the first byte from memory.
    // This deploys a contract which has a single byte of code, 0x41.
    const tx = createFeeMarket1559Tx(
      {
        gasLimit: 90000,
        maxFeePerGas: 40000,
        data: '0x7f410000000000000000000000000000000000000000000000000000000000000060005260016000f3',
      },
      { common: vm.common },
    ).sign(SIGNER_A.privateKey)

    await runTx(vm, {
      tx,
      rootTransactionId,
      skipBalance: true,
      skipHardForkValidation: true,
    })

    assert.strictEqual((lastEmitted as any).opcode.name, 'RETURN')
    vm.tvm.events!.removeListener('step', handler)
  })

  it('should emit a NewContractEvent on new contracts', async () => {
    const vm = await createVM()

    let emitted: any
    const handler = (val: any, resolve?: () => void) => {
      emitted = val
      resolve?.()
    }
    vm.tvm.events!.once('newContract', handler)

    // This is a deployment transaction that pushes 0x41 (i.e. ascii A) followed by 31 0s to
    // the stack, stores that in memory, and then returns the first byte from memory.
    // This deploys a contract which has a single byte of code, 0x41.
    const tx = createFeeMarket1559Tx(
      {
        gasLimit: 90000,
        maxFeePerGas: 40000,
        data: '0x7f410000000000000000000000000000000000000000000000000000000000000060005260016000f3',
      },
      { common: vm.common },
    ).sign(SIGNER_A.privateKey)

    await runTx(vm, {
      tx,
      rootTransactionId,
      skipBalance: true,
      skipHardForkValidation: true,
    })

    assert.strictEqual(
      bytesToHex(emitted.code),
      '0x7f410000000000000000000000000000000000000000000000000000000000000060005260016000f3',
    )
  })
})
