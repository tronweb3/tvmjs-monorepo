import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { SIGNER_A } from '@tvmjs/testdata'
import { createLegacyTx } from '@tvmjs/tx'
import {
  Account,
  bigIntToBytes,
  bytesToBigInt,
  createAddressFromString,
  hexToBytes,
  setLengthLeft,
} from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import { buildBlock, createVM, runBlock, runTx } from '../../src/index.ts'
import { makeParentBlockHeader } from '../util.ts'

const beaconAddress = createAddressFromString('0x000f3df6d732807ef1319fb7b8bb8522d0beac02')
const contract = createAddressFromString(`0x${'11'.repeat(20)}`)
const slot = new Uint8Array(32)
const balance = 10n ** 18n

async function createStorageVM(common: Common) {
  const vm = await createVM({ common })
  await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, balance))
  await vm.stateManager.putAccount(contract, new Account())
  await vm.stateManager.putCode(contract, hexToBytes('0x600760005500'))
  const tx = createLegacyTx(
    { to: contract, gasLimit: 100000n, gasPrice: 10n },
    { common: vm.common },
  ).sign(SIGNER_A.privateKey)
  const root = await vm.stateManager.getStateRoot()
  const parentBlock = createBlock(
    { header: { gasLimit: 1000000n, stateRoot: root } },
    { common: vm.common },
  )
  return { vm, tx, root, parentBlock }
}

describe.each([TronMainnet, TronNile, TronShasta])(
  'VM after Beacon root removal on $name',
  (chain) => {
    it('rejects old inputs before events, checkpoints, root changes or header normalization', async () => {
      const common = new Common({ chain })
      const vm = await createVM({ common })
      const parentBlock = createBlock({}, { common })
      const tx = createLegacyTx({}, { common })
      const checkpoint = vi.spyOn(vm.tvm.journal, 'checkpoint')
      const setStateRoot = vi.spyOn(vm.stateManager, 'setStateRoot')
      const setHardfork = vi.spyOn(common, 'setHardforkBy')
      const beforeBlock = vi.fn()
      const beforeTx = vi.fn()
      vm.events.on('beforeBlock', beforeBlock)
      vm.events.on('beforeTx', beforeTx)

      for (const field of ['parentBeaconBlockRoot', 'parent_beacon_block_root']) {
        for (const value of [undefined, null, 0, '', new Uint8Array(), new Uint8Array(32)]) {
          const block = { ...parentBlock, header: { ...parentBlock.header, [field]: value } }
          const error = `Beacon root block context field ${field} is no longer supported`
          await expect(runTx(vm, { tx, block } as any)).rejects.toThrow(error)
          await expect(
            runBlock(vm, { block, root: new Uint8Array(32), setHardfork: true } as any),
          ).rejects.toThrow(error)
          await expect(buildBlock(vm, { parentBlock: block } as any)).rejects.toThrow(error)
          await expect(
            buildBlock(vm, { parentBlock, headerData: { [field]: value } }),
          ).rejects.toThrow(`Beacon root header field ${field}`)
          expect(() => makeParentBlockHeader({ [field]: value }, { common })).toThrow(
            `Beacon root environment field ${field}`,
          )
        }
      }
      expect(checkpoint).not.toHaveBeenCalled()
      expect(setStateRoot).not.toHaveBeenCalled()
      expect(setHardfork).not.toHaveBeenCalled()
      expect(beforeBlock).not.toHaveBeenCalled()
      expect(beforeTx).not.toHaveBeenCalled()
      expect(makeParentBlockHeader({ parentGasLimit: 1000000n }, { common }).raw()).toHaveLength(16)
      const builder = await buildBlock(vm, {
        parentBlock,
        blockOpts: { putBlockIntoBlockchain: false },
      })
      await builder.revert()
    })

    it.each([false, true])(
      'executes and builds ordinary blocks without accessing the Beacon account (present=%s)',
      async (present) => {
        const vm = await createVM({ common: new Common({ chain }) })
        // Exercise both slots that the retired ring buffer would have overwritten at timestamp 123.
        const timestampSlot = setLengthLeft(bigIntToBytes(123n), 32)
        const rootSlot = setLengthLeft(bigIntToBytes(123n + 8191n), 32)
        const code = hexToBytes('0x00')
        if (present) {
          await vm.stateManager.putAccount(beaconAddress, new Account(1n, 9n))
          await vm.stateManager.putCode(beaconAddress, code)
          await vm.stateManager.putStorage(beaconAddress, timestampSlot, new Uint8Array([17]))
          await vm.stateManager.putStorage(beaconAddress, rootSlot, new Uint8Array([34]))
        }
        const initialRoot = await vm.stateManager.getStateRoot()
        const accountBefore = (await vm.stateManager.getAccount(beaconAddress))?.serialize()
        const accesses = [
          vi.spyOn(vm.stateManager, 'getAccount'),
          vi.spyOn(vm.stateManager, 'putAccount'),
          vi.spyOn(vm.stateManager, 'deleteAccount'),
          vi.spyOn(vm.stateManager, 'getCode'),
          vi.spyOn(vm.stateManager, 'putCode'),
          vi.spyOn(vm.stateManager, 'getStorage'),
          vi.spyOn(vm.stateManager, 'putStorage'),
        ]
        const block = createBlock(
          { header: { number: 1n, timestamp: 123n, gasLimit: 1000000n } },
          { common: vm.common },
        )
        const result = await runBlock(vm, { block, generate: true, skipBlockValidation: true })
        expect(result.gasUsed).toBe(0n)
        expect(result.receipts).toEqual([])
        expect(result.stateRoot).toEqual(initialRoot)
        const builder = await buildBlock(vm, {
          parentBlock: block,
          headerData: { timestamp: 123n },
          blockOpts: { putBlockIntoBlockchain: false },
        })
        const built = await builder.build()
        expect(built.block.header.stateRoot).toEqual(initialRoot)
        expect(built.block.header).not.toHaveProperty('parentBeaconBlockRoot')
        expect(() => vm.common.param('historicalRootsLength')).toThrow()
        for (const access of accesses) {
          expect(
            access.mock.calls.some(([address]) => address.toString() === beaconAddress.toString()),
          ).toBe(false)
          access.mockRestore()
        }

        expect((await vm.stateManager.getAccount(beaconAddress))?.serialize()).toEqual(
          accountBefore,
        )
        if (present) {
          expect(await vm.stateManager.getCode(beaconAddress)).toEqual(code)
          expect(await vm.stateManager.getStorage(beaconAddress, timestampSlot)).toEqual(
            new Uint8Array([17]),
          )
          expect(await vm.stateManager.getStorage(beaconAddress, rootSlot)).toEqual(
            new Uint8Array([34]),
          )
        }
      },
    )

    it('reverts ordinary transaction storage, nonce and balances while building a block', async () => {
      const { vm, tx, root, parentBlock } = await createStorageVM(new Common({ chain }))
      const builder = await buildBlock(vm, {
        parentBlock,
        blockOpts: { putBlockIntoBlockchain: false },
      })
      const result = await builder.addTransaction(tx)
      expect(result.execResult.exceptionError).toBeUndefined()
      expect(result.receipt).toHaveProperty('status', 1)
      expect(bytesToBigInt(await vm.stateManager.getStorage(contract, slot))).toBe(7n)
      expect((await vm.stateManager.getAccount(SIGNER_A.address))?.nonce).toBe(1n)
      await builder.revert()
      expect(await vm.stateManager.getStateRoot()).toEqual(root)
      expect(bytesToBigInt(await vm.stateManager.getStorage(contract, slot))).toBe(0n)
      expect((await vm.stateManager.getAccount(SIGNER_A.address))?.nonce).toBe(0n)
      expect((await vm.stateManager.getAccount(SIGNER_A.address))?.balance).toBe(balance)
    })

    it('rolls back a block rejected after execution and can subsequently execute the valid block', async () => {
      const { vm, tx, root, parentBlock } = await createStorageVM(new Common({ chain }))
      const builder = await buildBlock(vm, {
        parentBlock,
        headerData: { timestamp: 123n },
        blockOpts: { putBlockIntoBlockchain: false },
      })
      await builder.addTransaction(tx)
      const { block } = await builder.build()
      await vm.stateManager.setStateRoot(root)
      const invalidBlock = createBlock(
        { header: { ...block.header, stateRoot: new Uint8Array(32) }, transactions: [tx] },
        { common: vm.common },
      )
      const afterTx = vi.fn()
      vm.events.on('afterTx', afterTx)
      await expect(
        runBlock(vm, { block: invalidBlock, skipBlockValidation: true }),
      ).rejects.toThrow('invalid block stateRoot')
      expect(afterTx).toHaveBeenCalledOnce()
      expect(await vm.stateManager.getStateRoot()).toEqual(root)
      expect(bytesToBigInt(await vm.stateManager.getStorage(contract, slot))).toBe(0n)
      expect((await vm.stateManager.getAccount(SIGNER_A.address))?.nonce).toBe(0n)
      expect((await vm.stateManager.getAccount(SIGNER_A.address))?.balance).toBe(balance)

      const result = await runBlock(vm, { block, skipBlockValidation: true })
      expect(result.stateRoot).toEqual(block.header.stateRoot)
      expect(result.receipts[0]).toHaveProperty('status', 1)
      expect(bytesToBigInt(await vm.stateManager.getStorage(contract, slot))).toBe(7n)
    })
  },
)
