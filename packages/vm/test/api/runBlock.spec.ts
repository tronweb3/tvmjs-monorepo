import { createBlock, createSealedCliqueBlock } from '@tvmjs/block'
import {
  Common,
  Hardfork,
  TronMainnet,
  TronNile,
  TronShasta,
  createCustomCommon,
} from '@tvmjs/common'
import { SIGNER_A, SIGNER_B } from '@tvmjs/testdata'
import {
  TransactionType,
  createAccessList2930Tx,
  createFeeMarket1559Tx,
  createLegacyTx,
} from '@tvmjs/tx'
import {
  Account,
  KECCAK256_RLP,
  bytesToHex,
  createZeroAddress,
  generateTronContractAddress,
  hexToBytes,
} from '@tvmjs/util'
import { assert, describe, expect, it, vi } from 'vitest'

import { createVM, runBlock } from '../../src/index.ts'
import type { AfterBlockEvent, PostByzantiumTxReceipt } from '../../src/types.ts'
import { setupVM } from './utils.ts'

describe('runBlock() -> successful API parameter usage', async () => {
  it('rejects an invalid transaction ID policy before block hooks or BAL replacement', async () => {
    const vm = await createVM()
    const block = createBlock({}, { common: vm.common })
    const originalBlockLevelAccessList = vm.tvm.blockLevelAccessList
    let beforeBlockCalls = 0
    vm.events.on('beforeBlock', () => {
      beforeBlockCalls++
    })

    await expect(
      runBlock(vm, {
        block,
        tronTransactionIdPolicy: 'invalid' as any,
        generate: true,
        skipBlockValidation: true,
      }),
    ).rejects.toThrow('Invalid TRON transaction ID policy')

    assert.strictEqual(beforeBlockCalls, 0)
    assert.strictEqual(vm.tvm.blockLevelAccessList, originalBlockLevelAccessList)
  })

  it('forwards transaction-indexed root IDs for TRON contract deployment', async () => {
    const tronCommon = new Common({ chain: TronMainnet })
    const vm = await createVM({ common: tronCommon })
    const rootTransactionIds = [
      hexToBytes('0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
      hexToBytes('0x101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f'),
    ]
    const transactions = [0n, 1n].map((nonce) =>
      createLegacyTx(
        { nonce, gasLimit: 100000n, gasPrice: 10n, data: '0x00' },
        { common: tronCommon },
      ).sign(SIGNER_A.privateKey),
    )
    const block = createBlock(
      { header: { gasLimit: 1000000n }, transactions },
      { common: tronCommon },
    )

    const result = await runBlock(vm, {
      block,
      rootTransactionIds,
      tronTransactionIdPolicy: 'require-explicit',
      generate: true,
      skipBalance: true,
      skipBlockValidation: true,
    })

    for (const [index, rootTransactionId] of rootTransactionIds.entries()) {
      assert.strictEqual(
        result.results[index].createdAddress?.toString(),
        bytesToHex(generateTronContractAddress(rootTransactionId, SIGNER_A.address.bytes)),
      )
    }
  })

  it('uses the transaction hash fallback for a missing transaction-indexed root ID', async () => {
    const tronCommon = new Common({ chain: TronMainnet })
    const vm = await createVM({ common: tronCommon })
    const tx = createLegacyTx(
      { gasLimit: 100000n, gasPrice: 10n, data: '0x00' },
      { common: tronCommon },
    ).sign(SIGNER_A.privateKey)
    const block = createBlock(
      { header: { gasLimit: 1000000n }, transactions: [tx] },
      { common: tronCommon },
    )

    const result = await runBlock(vm, {
      block,
      generate: true,
      skipBalance: true,
      skipBlockValidation: true,
    })

    assert.strictEqual(
      result.results[0].createdAddress?.toString(),
      bytesToHex(generateTronContractAddress(tx.hash(), SIGNER_A.address.bytes)),
    )
  })

  it('forwards require-explicit when a transaction-indexed root ID is missing', async () => {
    const tronCommon = new Common({ chain: TronMainnet })
    const vm = await createVM({ common: tronCommon })
    const tx = createLegacyTx(
      { gasLimit: 100000n, gasPrice: 10n, data: '0x00' },
      { common: tronCommon },
    ).sign(SIGNER_A.privateKey)
    const block = createBlock(
      { header: { gasLimit: 1000000n }, transactions: [tx] },
      { common: tronCommon },
    )

    await expect(
      runBlock(vm, {
        block,
        tronTransactionIdPolicy: 'require-explicit',
        generate: true,
        skipBalance: true,
        skipBlockValidation: true,
      }),
    ).rejects.toThrow(/rootTransactionId is required/)
  })

  it.each([TronMainnet, TronNile, TronShasta])(
    'runs signed transactions and produces cumulative receipts on $name',
    async (chain) => {
      const common = new Common({ chain })
      const vm = await createVM({ common })
      await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 1000000n))
      const transactions = [0n, 1n].map((nonce) =>
        createLegacyTx(
          { nonce, to: SIGNER_B.address, value: 1n, gasPrice: 10n, gasLimit: 21000n },
          { common },
        ).sign(SIGNER_A.privateKey),
      )
      const root = await vm.stateManager.getStateRoot()
      const block = createBlock(
        { header: { number: 1n, gasLimit: 100000n, baseFeePerGas: 7n }, transactions },
        { common },
      )
      const result = await runBlock(vm, {
        block,
        root,
        generate: true,
        skipBlockValidation: true,
        setHardfork: true,
      })
      assert.strictEqual(result.gasUsed, 42000n)
      assert.deepEqual(
        result.receipts.map((r) => r.cumulativeBlockGasUsed),
        [21000n, 42000n],
      )
      assert.deepEqual(
        result.receipts.map((r) => (r as PostByzantiumTxReceipt).status),
        [1, 1],
      )
      assert.isFalse(result.receipts.some((r) => 'stateRoot' in r))
      assert.strictEqual((await vm.stateManager.getAccount(SIGNER_B.address))!.balance, 2n)
      assert.strictEqual((await vm.stateManager.getAccount(SIGNER_A.address))!.nonce, 2n)
      assert.deepEqual(result.stateRoot, await vm.stateManager.getStateRoot())
      assert.strictEqual(vm.common.hardfork(), Hardfork.Tron)
    },
  )

  it('supports a custom TRON chain ID without implicit genesis or consensus', async () => {
    const common = createCustomCommon({ name: 'local-tron', chainId: 123 }, TronMainnet)
    const vm = await createVM({ common })
    const tx = createLegacyTx(
      { to: SIGNER_B.address, gasPrice: 10n, gasLimit: 21000n },
      { common },
    ).sign(SIGNER_A.privateKey)
    const block = createBlock({ header: { gasLimit: 100000n }, transactions: [tx] }, { common })
    const result = await runBlock(vm, {
      block,
      generate: true,
      skipBalance: true,
      skipBlockValidation: true,
    })
    assert.isUndefined(result.results[0].execResult.exceptionError)
    assert.strictEqual(result.gasUsed, 21000n)
    assert.isFalse(common.hasConsensus())
  })

  it('rejects a block containing a transaction for another TRON network', async () => {
    const vm = await createVM()
    const common = new Common({ chain: TronNile })
    const tx = createLegacyTx(
      { to: createZeroAddress(), gasLimit: 100000n, gasPrice: 100n },
      { common },
    ).sign(SIGNER_A.privateKey)
    const block = createBlock({ header: { gasLimit: 1000000n }, transactions: [tx] }, { common })
    const root = await vm.stateManager.getStateRoot()
    await expect(
      runBlock(vm, {
        block,
        generate: true,
        skipBlockValidation: true,
        skipHardForkValidation: true,
      }),
    ).rejects.toThrow(/different chainId/)
    assert.deepEqual(await vm.stateManager.getStateRoot(), root)
  })
})

describe('runBlock() validation and rollback', () => {
  it('reverts the block checkpoint when state-root generation fails after execution', async () => {
    const vm = await createVM()
    const block = createBlock({}, { common: vm.common })
    const root = await vm.stateManager.getStateRoot()
    const spy = vi
      .spyOn(vm.stateManager, 'getStateRoot')
      .mockRejectedValue(new Error('state-root generation failed'))
    try {
      await expect(
        runBlock(vm, { block, generate: true, skipBlockValidation: true }),
      ).rejects.toThrow('state-root generation failed')
    } finally {
      spy.mockRestore()
    }
    assert.strictEqual((vm.stateManager as any)._checkpointCount, 0)
    assert.deepEqual(await vm.stateManager.getStateRoot(), root)
  })

  it('rolls back earlier transactions when a later transaction is invalid', async () => {
    const vm = await createVM()
    await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 300000n))
    const root = await vm.stateManager.getStateRoot()
    const transactions = [0n, 1n].map((nonce) =>
      createLegacyTx(
        { nonce, to: SIGNER_B.address, value: 1n, gasPrice: 10n, gasLimit: 21000n },
        { common: vm.common },
      ).sign(SIGNER_A.privateKey),
    )
    const block = createBlock(
      { header: { gasLimit: 100000n }, transactions },
      { common: vm.common },
    )
    await expect(
      runBlock(vm, { block, generate: true, skipBlockValidation: true }),
    ).rejects.toThrow(/enough funds/)
    assert.deepEqual(await vm.stateManager.getStateRoot(), root)
    assert.isUndefined(await vm.stateManager.getAccount(SIGNER_B.address))
    assert.strictEqual((await vm.stateManager.getAccount(SIGNER_A.address))!.nonce, 0n)
    assert.strictEqual((vm.stateManager as any)._checkpointCount, 0)
  })

  it('rejects a block gas limit greater than 2^63 - 1', async () => {
    const vm = await createVM()
    const block = createBlock({ header: { gasLimit: 1n << 63n } }, { common: vm.common })
    await expect(runBlock(vm, { block })).rejects.toThrow('Invalid block')
  })

  it('rejects a missing parent header', async () => {
    const vm = await setupVM()
    const block = createBlock(
      { header: { number: 1n, parentHash: new Uint8Array(32).fill(1) } },
      { common: vm.common },
    )
    await expect(runBlock(vm, { block })).rejects.toThrow(/not found in DB/)
  })

  it('rejects validation without a blockchain validateHeader method', async () => {
    const vm = await createVM()
    // @ts-expect-error Deliberately test an incomplete external blockchain implementation.
    vm.blockchain.validateHeader = undefined
    await expect(runBlock(vm, { block: createBlock({}, { common: vm.common }) })).rejects.toThrow(
      'blockchain has no `validateHeader` method',
    )
  })

  it('rejects a transaction exceeding the remaining block budget', async () => {
    const vm = await createVM()
    const tx = createLegacyTx({ gasLimit: 100001n, gasPrice: 10n }, { common: vm.common }).sign(
      SIGNER_A.privateKey,
    )
    const block = createBlock(
      { header: { gasLimit: 100000n }, transactions: [tx] },
      { common: vm.common },
    )
    await expect(
      runBlock(vm, { block, generate: true, skipBlockValidation: true }),
    ).rejects.toThrow(/higher gas limit/)
  })
})

it('allocates local transaction fees to the signer with explicit Clique metadata', async () => {
  // Synthetic consensus fixture; this does not describe TRON DPoS.
  const common = new Common({
    chain: {
      ...TronMainnet,
      consensus: { type: 'poa', algorithm: 'clique', clique: { period: 10, epoch: 30000 } },
    },
  })
  const vm = await createVM({ common })
  await vm.stateManager.putAccount(SIGNER_B.address, new Account(0n, 420000n))
  const transactions = [0n, 1n].map((nonce) =>
    createLegacyTx(
      { nonce, to: createZeroAddress(), gasLimit: 21000n, gasPrice: 10n },
      { common },
    ).sign(SIGNER_B.privateKey),
  )
  const block = createSealedCliqueBlock(
    {
      header: { extraData: new Uint8Array(97), gasLimit: 100000n, baseFeePerGas: 7n },
      transactions,
    },
    SIGNER_A.privateKey,
    { common },
  )
  await runBlock(vm, { block, skipBlockValidation: true, generate: true })
  assert.strictEqual((await vm.stateManager.getAccount(SIGNER_A.address))!.balance, 42000n * 3n)
})

it('reflects generated header fields in the afterBlock event', async () => {
  const vm = await createVM()
  const root = await vm.stateManager.getStateRoot()
  const block = createBlock(
    {
      header: {
        receiptTrie: new Uint8Array(32),
        transactionsTrie: new Uint8Array(32),
        gasUsed: 1n,
      },
    },
    { common: vm.common },
  )
  let event: AfterBlockEvent | undefined
  vm.events.once('afterBlock', (result) => {
    event = result
  })
  await runBlock(vm, { block, generate: true, skipBlockValidation: true })
  assert.isDefined(event)
  assert.deepEqual(event!.block.header.receiptTrie, KECCAK256_RLP)
  assert.deepEqual(event!.block.header.transactionsTrie, KECCAK256_RLP)
  assert.deepEqual(event!.block.header.stateRoot, root)
  assert.strictEqual(event!.block.header.gasUsed, 0n)
})

it.each([
  TransactionType.Legacy,
  TransactionType.AccessListEIP2930,
  TransactionType.FeeMarketEIP1559,
])('runs local transaction type %s with status receipts', async (type) => {
  const vm = await createVM()
  await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 1000000n))
  const data = { to: SIGNER_B.address, gasLimit: 21000n }
  const opts = { common: vm.common }
  const tx = (
    type === TransactionType.FeeMarketEIP1559
      ? createFeeMarket1559Tx({ ...data, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }, opts)
      : type === TransactionType.AccessListEIP2930
        ? createAccessList2930Tx({ ...data, gasPrice: 10n }, opts)
        : createLegacyTx({ ...data, gasPrice: 10n }, opts)
  ).sign(SIGNER_A.privateKey)
  const block = createBlock(
    { header: { gasLimit: 100000n }, transactions: [tx] },
    { common: vm.common },
  )
  const result = await runBlock(vm, { block, generate: true, skipBlockValidation: true })
  assert.strictEqual(block.transactions[0].type, type)
  assert.strictEqual(result.gasUsed, 21000n)
  assert.strictEqual(result.receipts[0].cumulativeBlockGasUsed, 21000n)
  assert.strictEqual((result.receipts[0] as PostByzantiumTxReceipt).status, 1)
})
