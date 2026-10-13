import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { SIGNER_A } from '@tvmjs/testdata'
import { createTx } from '@tvmjs/tx'
import {
  Account,
  bytesToBigInt,
  concatBytes,
  createAddressFromString,
  hexToBytes,
} from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import { buildBlock, createVM, runBlock, runTx } from '../../src/index.ts'
import { makeTx } from '../util.ts'

const recipient = createAddressFromString(`0x${'11'.repeat(20)}`)
const target = createAddressFromString(`0x${'22'.repeat(20)}`)
const designator = concatBytes(hexToBytes('0xef0100'), target.bytes)
const slot = new Uint8Array(32)
const balance = 10n ** 18n

function signedTx(common: Common, type = 0, nonce = 0n) {
  return createTx(
    {
      type,
      nonce,
      to: recipient,
      value: 5n,
      gasLimit: 100000n,
      ...(type === 2 ? { maxFeePerGas: 10n, maxPriorityFeePerGas: 2n } : { gasPrice: 10n }),
    },
    { common },
  ).sign(SIGNER_A.privateKey)
}

describe.each([TronMainnet, TronNile, TronShasta])('EIP-7702 removal in VM on $name', (chain) => {
  it('rejects retired transaction contexts before any transaction, event or checkpoint', async () => {
    const vm = await createVM({ common: new Common({ chain }) })
    await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, balance))
    const root = await vm.stateManager.getStateRoot()
    const parentBlock = createBlock({ header: { gasLimit: 1000000n } }, { common: vm.common })
    const builder = await buildBlock(vm, {
      parentBlock,
      blockOpts: { putBlockIntoBlockchain: false },
    })
    const checkpoint = vi.spyOn(vm.tvm.journal, 'checkpoint')
    const setStateRoot = vi.spyOn(vm.stateManager, 'setStateRoot')
    const setHardfork = vi.spyOn(vm.common, 'setHardforkBy')
    const putAccount = vi.spyOn(vm.stateManager, 'putAccount')
    const beforeTx = vi.fn()
    const beforeBlock = vi.fn()
    vm.events.on('beforeTx', beforeTx)
    vm.events.on('beforeBlock', beforeBlock)
    const validTx = signedTx(vm.common)
    const retired = [
      ...[4, 4n, '0x04'].map((type) => ({ type })),
      ...['authorizationList', 'authorization_list'].flatMap((field) =>
        [undefined, null, []].map((value) => ({ type: 0, [field]: value })),
      ),
      Object.assign(Object.create({ authorizationList: undefined }), { type: 0 }),
    ]
    for (const tx of retired) {
      await expect(runTx(vm, { tx } as any)).rejects.toThrow(/EIP-7702 transaction/)
      await expect(builder.addTransaction(tx as any)).rejects.toThrow(/EIP-7702 transaction/)
      // Even a valid first transaction must not execute before a later retired input is rejected.
      const block = { ...parentBlock, transactions: [validTx, tx] }
      await expect(
        runBlock(vm, { block, root: new Uint8Array(32), setHardfork: true } as any),
      ).rejects.toThrow(/EIP-7702 transaction/)
    }
    expect(checkpoint).not.toHaveBeenCalled()
    expect(setStateRoot).not.toHaveBeenCalled()
    expect(setHardfork).not.toHaveBeenCalled()
    expect(putAccount).not.toHaveBeenCalled()
    expect(beforeTx).not.toHaveBeenCalled()
    expect(beforeBlock).not.toHaveBeenCalled()
    expect(await vm.stateManager.getStateRoot()).toEqual(root)
    expect(await vm.stateManager.getAccount(recipient)).toBeUndefined()
    expect(builder.transactionReceipts).toEqual([])
    // Rejecting an append must leave the builder usable and its ordinary state revertible.
    const result = await builder.addTransaction(validTx)
    expect(result.receipt).toHaveProperty('status', 1)
    await builder.revert()
    expect(await vm.stateManager.getStateRoot()).toEqual(root)
  })

  it('preserves pending builder state when rejecting a later authorization input', async () => {
    const vm = await createVM({ common: new Common({ chain }) })
    await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, balance))
    await vm.stateManager.putAccount(recipient, new Account())
    await vm.stateManager.putCode(recipient, hexToBytes('0x600760005500'))
    const root = await vm.stateManager.getStateRoot()
    const parentBlock = createBlock({ header: { gasLimit: 1000000n } }, { common: vm.common })
    const builder = await buildBlock(vm, {
      parentBlock,
      blockOpts: { putBlockIntoBlockchain: false },
    })
    const result = await builder.addTransaction(signedTx(vm.common))
    expect(result.receipt).toHaveProperty('status', 1)
    const pendingRoot = await vm.stateManager.getStateRoot()
    const checkpoint = vi.spyOn(vm.tvm.journal, 'checkpoint')
    await expect(
      builder.addTransaction({ type: 2, authorizationList: undefined } as any),
    ).rejects.toThrow('EIP-7702 transaction field authorizationList')
    expect(checkpoint).not.toHaveBeenCalled()
    expect(builder.transactionReceipts).toEqual([result.receipt])
    expect(await vm.stateManager.getStateRoot()).toEqual(pendingRoot)
    expect(bytesToBigInt(await vm.stateManager.getStorage(recipient, slot))).toBe(7n)
    await builder.revert()
    expect(await vm.stateManager.getStateRoot()).toEqual(root)
    expect((await vm.stateManager.getAccount(SIGNER_A.address))?.nonce).toBe(0n)
    expect((await vm.stateManager.getAccount(SIGNER_A.address))?.balance).toBe(balance)
    expect(await vm.stateManager.getStorage(recipient, slot)).toHaveLength(0)
  })

  it.each([false, true])(
    'rejects a sender with deployed code (designator=%s)',
    async (delegated) => {
      const vm = await createVM({ common: new Common({ chain }) })
      await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, balance))
      const code = delegated ? designator : hexToBytes('0x00')
      await vm.stateManager.putCode(SIGNER_A.address, code)
      const root = await vm.stateManager.getStateRoot()
      const account = (await vm.stateManager.getAccount(SIGNER_A.address))!.serialize()
      const getCode = vi.spyOn(vm.stateManager, 'getCode')
      for (const type of [0, 1, 2]) {
        await expect(runTx(vm, { tx: signedTx(vm.common, type) })).rejects.toThrow(
          'invalid sender address, address is not EOA (EIP-3607)',
        )
        expect(await vm.stateManager.getStateRoot()).toEqual(root)
        expect((await vm.stateManager.getAccount(SIGNER_A.address))!.serialize()).toEqual(account)
        expect(await vm.stateManager.getAccount(recipient)).toBeUndefined()
      }
      expect(getCode.mock.calls.some(([address]) => address.equals(target))).toBe(false)
      expect(await vm.stateManager.getCode(SIGNER_A.address)).toEqual(code)
    },
  )

  it.each([0, 1, 2])(
    'rolls back a type %s call to invalid delegation code and then executes normally',
    async (type) => {
      const vm = await createVM({ common: new Common({ chain }) })
      await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, balance))
      await vm.stateManager.putAccount(recipient, new Account())
      await vm.stateManager.putCode(recipient, designator)
      await vm.stateManager.putAccount(target, new Account())
      await vm.stateManager.putCode(target, hexToBytes('0x600760005500'))
      const getCode = vi.spyOn(vm.stateManager, 'getCode')
      const failed = await runTx(vm, { tx: signedTx(vm.common, type) })
      expect(failed.execResult.exceptionError?.error).toBe('invalid opcode')
      expect(failed.receipt).toHaveProperty('status', 0)
      expect(failed.gasRefund).toBe(0n)
      expect(failed.totalGasSpent).toBe(100000n)
      expect(getCode.mock.calls.some(([address]) => address.equals(target))).toBe(false)
      expect((await vm.stateManager.getAccount(SIGNER_A.address))?.nonce).toBe(1n)
      expect((await vm.stateManager.getAccount(SIGNER_A.address))?.balance).toBeLessThan(balance)
      expect((await vm.stateManager.getAccount(recipient))?.balance).toBe(0n)
      expect(await vm.stateManager.getStorage(recipient, slot)).toHaveLength(0)
      expect(await vm.stateManager.getStorage(target, slot)).toHaveLength(0)
      expect(await vm.stateManager.getCode(recipient)).toEqual(designator)

      await vm.stateManager.putCode(recipient, hexToBytes('0x600760005500'))
      const success = await runTx(vm, { tx: signedTx(vm.common, type, 1n) })
      expect(success.execResult.exceptionError).toBeUndefined()
      expect(success.receipt).toHaveProperty('status', 1)
      expect(success.gasRefund).toBe(0n)
      expect((await vm.stateManager.getAccount(SIGNER_A.address))?.nonce).toBe(2n)
      expect((await vm.stateManager.getAccount(recipient))?.balance).toBe(5n)
      expect(bytesToBigInt(await vm.stateManager.getStorage(recipient, slot))).toBe(7n)
      expect(await vm.stateManager.getStorage(target, slot)).toHaveLength(0)
    },
  )
})

it('rejects old authorization fixtures before the VM test harness chooses a transaction type', () => {
  for (const data of [
    { type: '0x04' },
    { type: 0, authorizationList: undefined },
    { type: 1, accessLists: [], authorization_list: [] },
    { type: 2, maxFeePerGas: 10n, authorizationList: null },
  ]) {
    expect(() => makeTx(data, {})).toThrow(/EIP-7702 transaction/)
  }
})
