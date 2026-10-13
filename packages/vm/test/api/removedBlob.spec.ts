import { createBlock } from '@tvmjs/block'
import { SIGNER_A } from '@tvmjs/testdata'
import { createTx } from '@tvmjs/tx'
import { Account, createAddressFromString } from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import { buildBlock, createVM, runTx } from '../../src/index.ts'

const recipient = createAddressFromString(`0x${'11'.repeat(20)}`)

describe('VM after Blob removal', () => {
  it.each([0, 1, 2])(
    'builds an ordinary type %s transaction with receipts and no Blob metadata',
    async (type) => {
      const vm = await createVM()
      await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 10n ** 18n))
      const parentBlock = createBlock({ header: { gasLimit: 1000000n } }, { common: vm.common })
      const builder = await buildBlock(vm, {
        parentBlock,
        blockOpts: { putBlockIntoBlockchain: false },
      })
      const tx = createTx(
        {
          type,
          to: recipient,
          value: 1n,
          gasLimit: 50000n,
          gasPrice: type === 2 ? undefined : 10n,
          maxFeePerGas: 10n,
          maxPriorityFeePerGas: 2n,
        },
        { common: vm.common },
      ).sign(SIGNER_A.privateKey)
      const result = await builder.addTransaction(tx)
      expect(result.execResult.exceptionError).toBeUndefined()
      expect(result.receipt).toHaveProperty('status', 1)
      expect(result.receipt.cumulativeBlockGasUsed).toBe(result.totalGasSpent)
      expect(builder.transactionReceipts).toEqual([result.receipt])
      expect(result).not.toHaveProperty('blobGasUsed')
      expect(result.receipt).not.toHaveProperty('blobGasUsed')
      expect(result.receipt).not.toHaveProperty('blobGasPrice')
      expect(builder).not.toHaveProperty('blobGasUsed')
      const { block } = await builder.build()
      expect(block.header.gasUsed).toBe(result.totalGasSpent)
      expect(await block.transactionsTrieIsValid()).toBe(true)
      expect(block.transactions[0].hash()).toEqual(tx.hash())
      expect((await vm.stateManager.getAccount(recipient))?.balance).toBe(1n)
    },
  )

  it('rejects removed inputs before opening a state checkpoint', async () => {
    const vm = await createVM()
    const parentBlock = createBlock({}, { common: vm.common })
    const checkpoint = vi.spyOn(vm.tvm.journal, 'checkpoint')
    for (const field of ['blobGasUsed', 'excessBlobGas', 'blob_gas_used', 'excess_blob_gas']) {
      await expect(
        buildBlock(vm, { parentBlock, headerData: { [field]: 0n } } as any),
      ).rejects.toThrow('Blob header fields are no longer supported')
    }
    const builder = await buildBlock(vm, {
      parentBlock,
      blockOpts: { putBlockIntoBlockchain: false },
    })
    const tx = createTx({ type: 0 }, { common: vm.common })
    for (const field of ['blobGasUsed', 'excessBlobGas', 'getBlobGasPrice']) {
      const block = { ...parentBlock, header: { ...parentBlock.header, [field]: undefined } }
      await expect(runTx(vm, { tx, block } as any)).rejects.toThrow(
        `Blob block context field ${field}`,
      )
    }
    for (const value of [undefined, false, true]) {
      await expect(builder.addTransaction(tx, { allowNoBlobs: value } as any)).rejects.toThrow(
        'allowNoBlobs is no longer supported',
      )
    }
    await expect(builder.addTransaction({ type: 3 } as any)).rejects.toThrow(
      'Blob transaction type 0x03',
    )
    await expect(runTx(vm, { tx: { type: 3 } } as any)).rejects.toThrow(
      'Blob transaction type 0x03',
    )
    expect(checkpoint).not.toHaveBeenCalled()
    await builder.revert()
  })

  it('keeps transaction state revertible while building a block', async () => {
    const vm = await createVM()
    const balance = 10n ** 18n
    await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, balance))
    const parentBlock = createBlock({ header: { gasLimit: 1000000n } }, { common: vm.common })
    const builder = await buildBlock(vm, {
      parentBlock,
      blockOpts: { putBlockIntoBlockchain: false },
    })
    const tx = createTx(
      {
        type: 2,
        to: recipient,
        value: 1n,
        gasLimit: 50000n,
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 2n,
      },
      { common: vm.common },
    ).sign(SIGNER_A.privateKey)
    await builder.addTransaction(tx)
    await builder.revert()
    expect((await vm.stateManager.getAccount(SIGNER_A.address))?.balance).toBe(balance)
    expect((await vm.stateManager.getAccount(SIGNER_A.address))?.nonce).toBe(0n)
    expect(await vm.stateManager.getAccount(recipient)).toBeUndefined()
  })
})
