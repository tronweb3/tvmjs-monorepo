import {
  cliqueSigner,
  cliqueVerifySignature,
  createBlock,
  createSealedCliqueBlock,
} from '@tvmjs/block'
import { createBlockchain } from '@tvmjs/blockchain'
import { Common, TronMainnet } from '@tvmjs/common'
import { createFeeMarket1559Tx, createLegacyTx } from '@tvmjs/tx'
import { concatBytes, createAccount, createZeroAddress } from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import { buildBlock, createVM, runBlock } from '../../src/index.ts'

import { setBalance } from './utils.ts'

import { SIGNER_A } from '@tvmjs/testdata'

describe('BlockBuilder', () => {
  it('rejects an invalid transaction ID policy without changing the builder checkpoint', async () => {
    const common = new Common({ chain: TronMainnet })
    const parentBlock = createBlock({ header: { gasLimit: 1000000n } }, { common })
    const vm = await createVM({ common })
    const blockBuilder = await buildBlock(vm, { parentBlock })
    const checkpointed = (blockBuilder as any).checkpointed
    const journalHeight = (vm.tvm.journal as any).journalHeight
    const tx = createLegacyTx({ gasLimit: 100000n, gasPrice: 10n }, { common }).sign(
      SIGNER_A.privateKey,
    )

    await expect(
      blockBuilder.addTransaction(tx, { tronTransactionIdPolicy: 'invalid' as any }),
    ).rejects.toThrow('Invalid TRON transaction ID policy')

    assert.strictEqual((blockBuilder as any).checkpointed, checkpointed)
    assert.strictEqual((vm.tvm.journal as any).journalHeight, journalHeight)
  })

  it('forwards the TRON transaction ID policy to runTx', async () => {
    const common = new Common({ chain: TronMainnet })
    const parentBlock = createBlock({ header: { gasLimit: 1000000n } }, { common })
    const vm = await createVM({ common })
    await setBalance(vm, SIGNER_A.address)
    const blockBuilder = await buildBlock(vm, { parentBlock })
    const tx = createLegacyTx({ gasLimit: 100000n, gasPrice: 10n, data: '0x00' }, { common }).sign(
      SIGNER_A.privateKey,
    )

    await expect(
      blockBuilder.addTransaction(tx, {
        tronTransactionIdPolicy: 'require-explicit',
      }),
    ).rejects.toThrow(/rootTransactionId is required/)

    const result = await blockBuilder.addTransaction(tx)
    assert.isDefined(result.createdAddress)
    await blockBuilder.revert()
  })

  it('should build a valid block', async () => {
    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock({ header: { gasLimit: 50000 } }, { common })
    const blockchain = await createBlockchain({ genesisBlock, common, validateConsensus: false })
    const vm = await createVM({ common, blockchain })

    await setBalance(vm, SIGNER_A.address)

    const vmCopy = await vm.shallowCopy()

    const blockBuilder = await buildBlock(vm, {
      parentBlock: genesisBlock,
      headerData: { coinbase: '0x96dc73c8b5969608c77375f085949744b5177660', timestamp: 1n },
      blockOpts: { freeze: false },
    })

    // Set up tx
    const tx = createLegacyTx(
      { to: createZeroAddress(), value: 1000, gasLimit: 21000, gasPrice: 10 },
      { common, freeze: false },
    ).sign(SIGNER_A.privateKey)

    await blockBuilder.addTransaction(tx)
    const { block } = await blockBuilder.build()
    assert.strictEqual(
      blockBuilder.transactionReceipts.length,
      1,
      'should have the correct number of tx receipts',
    )
    const result = await runBlock(vmCopy, { block })
    assert.strictEqual(result.gasUsed, block.header.gasUsed)
    assert.deepEqual(result.receiptsRoot, block.header.receiptTrie)
    assert.deepEqual(result.stateRoot, block.header.stateRoot)
    assert.deepEqual(result.logsBloom, block.header.logsBloom)
  })

  it('should throw if adding a transaction exceeds the block gas limit', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })
    const genesis = createBlock({}, { common })

    const blockBuilder = await buildBlock(vm, { parentBlock: genesis })
    const gasLimit = genesis.header.gasLimit + BigInt(1)
    const tx = createLegacyTx({ gasLimit }, { common })
    try {
      await blockBuilder.addTransaction(tx)
      assert.fail('should throw error')
    } catch (error: any) {
      if (
        (error.message as string).includes(
          'tx has a higher gas limit than the remaining gas in the block',
        )
      ) {
        assert.isTrue(true, 'correct error thrown')
      } else {
        assert.fail('wrong error thrown')
      }
    }
    assert.strictEqual(
      blockBuilder.transactionReceipts.length,
      0,
      'should have the correct number of tx receipts',
    )
  })

  it('should correctly seal a block with explicit Clique metadata', async () => {
    // Synthetic consensus fixture; this does not define TRON network consensus.
    const common = new Common({
      chain: {
        ...TronMainnet,
        name: 'clique-sealing-fixture',
        chainId: 123456,
        consensus: {
          type: 'poa',
          algorithm: 'clique',
          clique: { period: 10, epoch: 30000 },
        },
      },
    })

    // extraData: [vanity, activeSigner, seal]
    const extraData = concatBytes(
      new Uint8Array(32),
      SIGNER_A.address.toBytes(),
      new Uint8Array(65),
    )
    const cliqueSignerKey = SIGNER_A.privateKey
    const genesisBlock = createSealedCliqueBlock(
      { header: { gasLimit: 50000, extraData } },
      cliqueSignerKey,
      { common },
    )
    const blockchain = await createBlockchain({ genesisBlock, common })
    const vm = await createVM({ common, blockchain })

    // add balance for tx
    await vm.stateManager.putAccount(SIGNER_A.address, createAccount({ balance: 1000000 }))

    const blockBuilder = await buildBlock(vm, {
      parentBlock: genesisBlock,
      headerData: { difficulty: 2, extraData: new Uint8Array(97) },
      blockOpts: { cliqueSigner: cliqueSignerKey, freeze: false },
    })

    // Set up tx
    const tx = createLegacyTx(
      { to: createZeroAddress(), value: 1000, gasLimit: 21000, gasPrice: 10 },
      { common, freeze: false },
    ).sign(SIGNER_A.privateKey)

    await blockBuilder.addTransaction(tx)

    const { block } = await blockBuilder.build()

    assert.isTrue(
      cliqueVerifySignature(block.header, [SIGNER_A.address]),
      'should verify signature',
    )
    assert.deepEqual(
      cliqueSigner(block.header),
      SIGNER_A.address,
      'should recover the correct signer address',
    )
  })

  it('should throw if block already built or reverted', async () => {
    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock({ header: { gasLimit: 50000 } }, { common })
    const blockchain = await createBlockchain({ genesisBlock, common, validateConsensus: false })
    const vm = await createVM({ common, blockchain })

    await setBalance(vm, SIGNER_A.address)

    let blockBuilder = await buildBlock(vm, {
      parentBlock: genesisBlock,
      headerData: { timestamp: 1n },
    })

    const tx = createLegacyTx(
      { to: createZeroAddress(), value: 1000, gasLimit: 21000, gasPrice: 10 },
      { common, freeze: false },
    ).sign(SIGNER_A.privateKey)

    await blockBuilder.addTransaction(tx)
    await blockBuilder.build()
    await expect(blockBuilder.addTransaction(tx)).rejects.toThrow(/already been built/)
    await expect(blockBuilder.build()).rejects.toThrow(/already been built/)

    try {
      await blockBuilder.revert()
      assert.strictEqual(
        blockBuilder.getStatus().status,
        'reverted',
        'block should be in reverted status',
      )
    } catch {
      assert.fail('should not throw')
    }

    blockBuilder = await buildBlock(vm, { parentBlock: genesisBlock })

    const tx2 = createLegacyTx(
      { to: createZeroAddress(), value: 1000, gasLimit: 21000, gasPrice: 10, nonce: 1 },
      { common, freeze: false },
    ).sign(SIGNER_A.privateKey)

    const root = await vm.stateManager.getStateRoot()
    await blockBuilder.addTransaction(tx2)
    await blockBuilder.revert()
    assert.deepEqual(await vm.stateManager.getStateRoot(), root)
    await expect(blockBuilder.addTransaction(tx2)).rejects.toThrow(/reverted/)
    await expect(blockBuilder.build()).rejects.toThrow(/reverted/)

    try {
      await blockBuilder.revert()
      assert.strictEqual(
        blockBuilder.getStatus().status,
        'reverted',
        'block should be in reverted status',
      )
    } catch {
      assert.fail('should not throw')
    }
  })

  it('should build a block without any txs', async () => {
    const common = new Common({ chain: TronMainnet })
    const genesisBlock = createBlock({ header: { gasLimit: 50000 } }, { common })
    const blockchain = await createBlockchain({ genesisBlock, common, validateConsensus: false })
    const vm = await createVM({ common, blockchain })
    const vmCopy = await vm.shallowCopy()

    const blockBuilder = await buildBlock(vm, {
      parentBlock: genesisBlock,
      headerData: { timestamp: 1n },
      blockOpts: { freeze: false },
    })

    const { block } = await blockBuilder.build()

    // block should successfully execute with VM.runBlock and have same outputs
    const result = await runBlock(vmCopy, { block })
    assert.strictEqual(result.gasUsed, block.header.gasUsed)
    assert.deepEqual(result.receiptsRoot, block.header.receiptTrie)
    assert.deepEqual(result.stateRoot, block.header.stateRoot)
    assert.deepEqual(result.logsBloom, block.header.logsBloom)
  })

  it('should build a 1559 block with legacy and 1559 txs', async () => {
    const common = new Common({ chain: TronMainnet, eips: [1559] })
    const genesisBlock = createBlock(
      { header: { gasLimit: 50000, baseFeePerGas: 100 } },
      { common },
    )
    const blockchain = await createBlockchain({ genesisBlock, common, validateConsensus: false })
    const vm = await createVM({ common, blockchain })

    await setBalance(vm, SIGNER_A.address)

    const vmCopy = await vm.shallowCopy()

    const blockBuilder = await buildBlock(vm, {
      parentBlock: genesisBlock,
      headerData: { coinbase: '0x96dc73c8b5969608c77375f085949744b5177660', timestamp: 1n },
      blockOpts: { freeze: false },
    })

    // Set up underpriced txs to test error response
    const tx1 = createLegacyTx(
      { to: createZeroAddress(), value: 1000, gasLimit: 21000, gasPrice: 10 },
      { common, freeze: false },
    ).sign(SIGNER_A.privateKey)

    const tx2 = createFeeMarket1559Tx(
      { to: createZeroAddress(), value: 1000, gasLimit: 21000, maxFeePerGas: 10 },
      { common, freeze: false },
    ).sign(SIGNER_A.privateKey)

    for (const tx of [tx1, tx2]) {
      await expect(async () => {
        await blockBuilder.addTransaction(tx)
        assert.fail('should throw error')
      }).rejects.toThrow(/is less than the block's baseFeePerGas/)
    }

    // Set up correctly priced txs
    const tx3 = createLegacyTx(
      { to: createZeroAddress(), value: 1000, gasLimit: 21000, gasPrice: 101 },
      { common, freeze: false },
    ).sign(SIGNER_A.privateKey)

    const tx4 = createFeeMarket1559Tx(
      { to: createZeroAddress(), value: 1000, gasLimit: 21000, maxFeePerGas: 101, nonce: 1 },
      { common, freeze: false },
    ).sign(SIGNER_A.privateKey)

    for (const tx of [tx3, tx4]) {
      await blockBuilder.addTransaction(tx)
      assert.isTrue(true, 'should pass')
    }

    const { block } = await blockBuilder.build()
    assert.strictEqual(
      blockBuilder.transactionReceipts.length,
      2,
      'should have the correct number of tx receipts',
    )

    assert.strictEqual(
      block.header.baseFeePerGas,
      genesisBlock.header.calcNextBaseFee(),
      "baseFeePerGas should equal parentHeader's calcNextBaseFee",
    )

    const result = await runBlock(vmCopy, { block })
    assert.strictEqual(result.gasUsed, block.header.gasUsed)
    assert.deepEqual(result.receiptsRoot, block.header.receiptTrie)
    assert.deepEqual(result.stateRoot, block.header.stateRoot)
    assert.deepEqual(result.logsBloom, block.header.logsBloom)
  })
})
