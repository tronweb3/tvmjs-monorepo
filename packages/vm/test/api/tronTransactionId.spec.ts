import { Common, Hardfork, Mainnet, TronMainnet } from '@tvmjs/common'
import { SIGNER_A } from '@tvmjs/testdata'
import { createLegacyTx } from '@tvmjs/tx'
import {
  bytesToHex,
  createAccount,
  createAddressFromString,
  createZeroAddress,
  generateTronContractAddress,
  generateTronCreateAddress,
  hexToBytes,
} from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import { createVM, runTx } from '../../src/index.ts'

describe('TRON rootTransactionId propagation', () => {
  it('rejects an invalid transaction ID policy before events or journal cleanup', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })
    const tx = createLegacyTx({ gasLimit: 100000n, gasPrice: 10n, data: '0x00' }, { common }).sign(
      SIGNER_A.privateKey,
    )
    let beforeTxCalls = 0
    let cleanupCalls = 0
    const originalCleanup = vm.tvm.journal.cleanup.bind(vm.tvm.journal)
    vm.tvm.journal.cleanup = async () => {
      cleanupCalls++
      await originalCleanup()
    }
    vm.events.on('beforeTx', () => {
      beforeTxCalls++
    })

    await expect(
      runTx(vm, {
        tx,
        skipBalance: true,
        tronTransactionIdPolicy: 'invalid' as any,
      }),
    ).rejects.toThrow('Invalid TRON transaction ID policy')

    assert.strictEqual(beforeTxCalls, 0)
    assert.strictEqual(cleanupCalls, 0)
    assert.isUndefined(vm.tvm.blockLevelAccessList)
  })

  it('uses the signed TVMJS transaction hash for a top-level TRON deployment by default', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })
    const tx = createLegacyTx({ gasLimit: 100000n, gasPrice: 10n, data: '0x00' }, { common }).sign(
      SIGNER_A.privateKey,
    )

    const result = await runTx(vm, { tx, skipBalance: true })

    assert.strictEqual(
      result.createdAddress?.toString(),
      bytesToHex(generateTronContractAddress(tx.hash(), SIGNER_A.address.bytes)),
    )
  })

  it('prefers an explicit rootTransactionId over the transaction hash fallback', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })
    const rootTransactionId = hexToBytes(
      '0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0',
    )
    const tx = createLegacyTx({ gasLimit: 100000n, gasPrice: 10n, data: '0x00' }, { common }).sign(
      SIGNER_A.privateKey,
    )

    const result = await runTx(vm, { tx, rootTransactionId, skipBalance: true })

    assert.strictEqual(
      result.createdAddress?.toString(),
      bytesToHex(generateTronContractAddress(rootTransactionId, SIGNER_A.address.bytes)),
    )
    assert.notStrictEqual(
      result.createdAddress?.toString(),
      bytesToHex(generateTronContractAddress(tx.hash(), SIGNER_A.address.bytes)),
    )
  })

  it('propagates rootTransactionId from runTx to internal CREATE', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })

    const deployer = createAddressFromString('0x0000000000000000000000000000000000000100')
    await vm.stateManager.putAccount(deployer, createAccount({ balance: 10n ** 18n }))

    // Simple CREATE: deploy empty contract and return its address
    const deployCode = hexToBytes('0x600060006000f060005260206000f3')
    await vm.stateManager.putCode(deployer, deployCode)

    const rootTxId = hexToBytes(
      '0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0',
    )

    const tx = createLegacyTx(
      {
        to: deployer,
        gasLimit: 100000,
        gasPrice: 10,
        nonce: 0,
      },
      { common },
    ).sign(SIGNER_A.privateKey)

    const result = await runTx(vm, { tx, rootTransactionId: rootTxId, skipBalance: true })

    // Extract the created address from return value (last 20 bytes)
    const createdAddress = result.execResult.returnValue.subarray(-20)

    // Verify it matches TRON CREATE derivation with the exact rootTransactionId and nonce=0
    assert.strictEqual(
      bytesToHex(createdAddress),
      bytesToHex(generateTronCreateAddress(rootTxId, 0n)),
      'runTx should propagate rootTransactionId to internal CREATE with correct derivation',
    )
  })

  it('uses the signed TVMJS transaction hash for internal CREATE by default', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })
    const deployer = createAddressFromString('0x0000000000000000000000000000000000000100')
    await vm.stateManager.putCode(deployer, hexToBytes('0x600060006000f060005260206000f3'))

    const tx = createLegacyTx(
      {
        to: deployer,
        gasLimit: 100000,
        gasPrice: 10,
        nonce: 0,
      },
      { common },
    ).sign(SIGNER_A.privateKey)

    const result = await runTx(vm, { tx, skipBalance: true })

    assert.strictEqual(
      bytesToHex(result.execResult.returnValue.subarray(-20)),
      bytesToHex(generateTronCreateAddress(tx.hash(), 0n)),
    )
  })

  it('rejects an Ethereum deployment configuration', () => {
    assert.throws(
      // @ts-expect-error Ethereum data is deliberately passed to test rejection.
      () => new Common({ chain: Mainnet, hardfork: Hardfork.Constantinople }),
      /Only TRON execution configurations are supported/,
    )
  })

  it('does not require an explicit ID for a TRON transaction that does not create a contract', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })
    const tx = createLegacyTx(
      { to: createZeroAddress(), gasLimit: 21000n, gasPrice: 10n },
      { common },
    ).sign(SIGNER_A.privateKey)

    const result = await runTx(vm, {
      tx,
      skipBalance: true,
      tronTransactionIdPolicy: 'require-explicit',
    })

    assert.isUndefined(result.execResult.exceptionError)
  })

  it('requires an explicit ID when the compatibility fallback is disabled', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })
    const deployer = createAddressFromString('0x0000000000000000000000000000000000000100')
    await vm.stateManager.putCode(deployer, hexToBytes('0x600060006000f000'))

    const tx = createLegacyTx(
      {
        to: deployer,
        gasLimit: 100000,
        gasPrice: 10,
        nonce: 0,
      },
      { common },
    ).sign(SIGNER_A.privateKey)

    let error: unknown
    try {
      await runTx(vm, {
        tx,
        skipBalance: true,
        tronTransactionIdPolicy: 'require-explicit',
      })
    } catch (caught) {
      error = caught
    }

    assert.match((error as Error).message, /rootTransactionId is required/)
    assert.strictEqual(
      (vm.tvm.journal as any).journalHeight,
      0,
      'runTx and runCall checkpoints must both be reverted',
    )
    assert.strictEqual(vm.stateManager, vm.tvm.stateManager)
  })
})
