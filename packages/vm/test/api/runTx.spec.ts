import { createBlock } from '@tvmjs/block'
import { Common, Hardfork, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import {
  FeeMarket1559Tx,
  TransactionType,
  createFeeMarket1559Tx,
  createLegacyTx,
  createTx,
} from '@tvmjs/tx'
import {
  Account,
  Address,
  KECCAK256_NULL,
  MAX_INTEGER,
  bytesToHex,
  createAccount,
  createAddressFromPrivateKey,
  createAddressFromString,
  createZeroAddress,
  equalsBytes,
  generateTronContractAddress,
  hexToBytes,
} from '@tvmjs/util'

import { assert, describe, expect, it } from 'vitest'

import { createVM, runTx } from '../../src/index.ts'

import { SIGNER_A } from '@tvmjs/testdata'
import { createAccountWithDefaults, getTransaction, setBalance } from './utils.ts'

import type { LegacyTx, TypedTxData } from '@tvmjs/tx'
import type { VM } from '../../src/vm.ts'

const TRANSACTION_TYPES = [
  {
    type: TransactionType.Legacy,
    name: 'legacy tx',
  },
  {
    type: TransactionType.AccessListEIP2930,
    name: 'EIP2930 tx',
  },
  {
    type: TransactionType.FeeMarketEIP1559,
    name: 'EIP1559 tx',
  },
]

const common = new Common({ chain: TronMainnet })

describe('runTx() -> successful API parameter usage', async () => {
  async function simpleRun(vm: VM, msg: string) {
    for (const txType of TRANSACTION_TYPES) {
      const tx = getTransaction(vm.common, txType.type, true)

      const caller = tx.getSenderAddress()
      const acc = createAccountWithDefaults()
      await vm.stateManager.putAccount(caller, acc)
      let block
      if (vm.common.hasConsensus() && vm.common.consensusType() === 'poa') {
        // Setup block with correct extraData for POA
        block = createBlock({ header: { extraData: new Uint8Array(97) } }, { common: vm.common })
      }

      const res = await runTx(vm, { tx, block })
      assert.isTrue(res.totalGasSpent > BigInt(0), `${msg} (${txType.name})`)
    }
  }

  it.each([TronMainnet, TronNile, TronShasta])(
    'runs all local transaction types on $name',
    async (chain) => {
      const vm = await createVM({ common: new Common({ chain }) })
      await simpleRun(vm, chain.name)
    },
  )

  it('accepts matching TRON block and transaction configurations', async () => {
    const vm = await createVM({ common })
    const tx = getTransaction(vm.common, 0, true)
    await setBalance(vm, tx.getSenderAddress())
    const block = createBlock({}, { common: vm.common.copy() })
    const result = await runTx(vm, { tx, block })
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(vm.common.hardfork(), Hardfork.Tron)
  })

  it('rejects retired hardfork selection without changing the executable profile', async () => {
    const vm = await createVM({ common: common.copy() })
    const block = createBlock({}, { common: vm.common.copy() })
    assert.throws(() => block.common.setHardfork(Hardfork.Paris), /not supported/)
    assert.strictEqual(block.common.hardfork(), Hardfork.Tron)
    const tx = getTransaction(vm.common, 0, true)
    await setBalance(vm, tx.getSenderAddress())
    const result = await runTx(vm, { tx, block })
    assert.isUndefined(result.execResult.exceptionError)
  })

  it('default VM runs a tx bound to the same TRON chainId', async () => {
    const vm = await createVM()
    assert.strictEqual(vm.common.chainId(), 728126428n)

    const tx = createLegacyTx(
      { to: createZeroAddress(), gasLimit: 100000n, gasPrice: 100n },
      { common: new Common({ chain: TronMainnet }) },
    ).sign(hexToBytes(`0x${'42'.repeat(32)}`))

    assert.strictEqual(tx.common.chainId(), vm.common.chainId(), 'tx and vm chainId must match')
    await setBalance(vm, tx.getSenderAddress())

    const res = await runTx(vm, { tx, skipBlockGasLimitValidation: true })
    assert.strictEqual(res.totalGasSpent, 21000n)
  })

  it('rejects an EIP-155 legacy tx whose chainId does not match the vm', async () => {
    const vm = await createVM()
    // A valid TRON transaction bound to another network must still be rejected.
    const tx = createLegacyTx(
      { to: createZeroAddress(), gasLimit: 100000n, gasPrice: 100n },
      { common: new Common({ chain: TronNile }) },
    ).sign(hexToBytes(`0x${'42'.repeat(32)}`))

    assert.strictEqual(tx.common.chainId(), 3448148188n)
    await setBalance(vm, tx.getSenderAddress())

    await expect(runTx(vm, { tx, skipBlockGasLimitValidation: true })).rejects.toThrow(
      /tx has a different chainId \(3448148188\) than the vm \(728126428\)/,
    )
  })

  it('rejects a typed tx whose chainId does not match the vm', async () => {
    const vm = await createVM()
    const tx = createFeeMarket1559Tx(
      {
        to: createZeroAddress(),
        gasLimit: 100000n,
        maxFeePerGas: 100n,
      },
      { common: new Common({ chain: TronNile }) },
    ).sign(hexToBytes(`0x${'42'.repeat(32)}`))

    await expect(runTx(vm, { tx, skipBlockGasLimitValidation: true })).rejects.toThrow(
      /tx has a different chainId \(3448148188\) than the vm \(728126428\)/,
    )
  })

  it('allows an unprotected TRON envelope across networks', async () => {
    const vm = await createVM()
    // Fixed independent signature from the Tx package's eight-field TRON vector.
    const tx = createLegacyTx(
      {
        data: '0x7cf5dab00000000000000000000000000000000000000000000000000000000000000005',
        gasLimit: 90000n,
        gasPrice: 1n,
        nonce: 1n,
        to: '0xd9024df085d09398ec76fbed18cac0e1149f50dc',
        v: 27n,
        r: '0xca0c813799270d9b9ae7fb90851e6338a26f65cbcc9ce3b40125c93967908805',
        s: '0x49ea20dbe5dced20e2abb4aac25b34e76416b912ca32b32f4a19c0b5ec2ec7df',
      },
      { common: new Common({ chain: TronNile }) },
    )
    assert.isTrue(tx.verifySignature())
    assert.strictEqual(
      tx.getSenderAddress().toString(),
      '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f',
    )
    await vm.stateManager.putAccount(tx.getSenderAddress(), new Account(1n, 1000000n))
    const block = createBlock({ header: { baseFeePerGas: 0n } }, { common: vm.common })
    const result = await runTx(vm, { tx, block })
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(result.totalGasSpent, tx.getIntrinsicGas())
    assert.strictEqual((await vm.stateManager.getAccount(tx.getSenderAddress()))!.nonce, 2n)
  })

  it('should use passed in blockGasUsed to generate tx receipt', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })

    const tx = getTransaction(vm.common, 0, true)

    const caller = tx.getSenderAddress()
    const acc = createAccountWithDefaults()
    await vm.stateManager.putAccount(caller, acc)

    const blockGasUsed = BigInt(1000)
    const res = await runTx(vm, { tx, blockGasUsed })
    assert.strictEqual(
      res.receipt.cumulativeBlockGasUsed,
      blockGasUsed + res.totalGasSpent,
      'receipt.gasUsed should equal block gas used + tx gas used',
    )
  })

  it('runs legacy transactions with the TRON profile', async () => {
    const common = new Common({ chain: TronMainnet })
    const vm = await createVM({ common })

    const tx = getTransaction(vm.common, 0, true)

    const caller = tx.getSenderAddress()
    const acc = createAccountWithDefaults()
    await vm.stateManager.putAccount(caller, acc)

    const res = await runTx(vm, { tx })
    assert.isTrue(
      res.totalGasSpent > BigInt(0),
      `TRON execution should succeed (${TRANSACTION_TYPES[0].name})`,
    )
  })

  it('custom block (block option), disabled block gas limit validation (skipBlockGasLimitValidation: true)', async () => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await createVM({ common })

      const initialBalance = BigInt(10) ** BigInt(18)

      const account = await vm.stateManager.getAccount(SIGNER_A.address)
      await vm.stateManager.putAccount(
        SIGNER_A.address,
        createAccount({ ...account, balance: initialBalance }),
      )

      const transferCost = 21000
      const unsignedTx = createTx(
        {
          to: SIGNER_A.address,
          gasLimit: transferCost,
          gasPrice: 100,
          nonce: 0,
          type: txType.type,
          maxPriorityFeePerGas: 50,
          maxFeePerGas: 50,
        } as TypedTxData,
        { common },
      )
      const tx = unsignedTx.sign(SIGNER_A.privateKey)

      const coinbase = hexToBytes('0x00000000000000000000000000000000000000ff')
      const block = createBlock(
        {
          header: {
            gasLimit: transferCost - 1,
            coinbase,
            baseFeePerGas: 7,
          },
        },
        { common },
      )

      const result = await runTx(vm, {
        tx,
        block,
        skipBlockGasLimitValidation: true,
      })

      const coinbaseAccount = await vm.stateManager.getAccount(new Address(coinbase))

      // calculate expected coinbase balance
      const baseFee = block.header.baseFeePerGas!
      const inclusionFeePerGas =
        tx instanceof FeeMarket1559Tx
          ? tx.maxPriorityFeePerGas < tx.maxFeePerGas - baseFee
            ? tx.maxPriorityFeePerGas
            : tx.maxFeePerGas - baseFee
          : tx.gasPrice - baseFee
      const expectedCoinbaseBalance = common.isActivatedEIP(1559)
        ? result.totalGasSpent * inclusionFeePerGas
        : result.amountSpent

      assert.strictEqual(
        coinbaseAccount!.balance,
        expectedCoinbaseBalance,
        `should use custom block (${txType.name})`,
      )

      assert.strictEqual(
        result.execResult.exceptionError,
        undefined,
        `should run ${txType.name} without errors`,
      )
    }
  })
})

describe('runTx() -> API parameter usage/data errors', () => {
  it('simple run (reportAccessList option)', async () => {
    const vm = await createVM({ common })

    const tx = getTransaction(vm.common, 0, true)

    const caller = tx.getSenderAddress()
    const acc = createAccountWithDefaults()
    await vm.stateManager.putAccount(caller, acc)

    const res = await runTx(vm, { tx, reportAccessList: true })
    assert.isTrue(
      res.totalGasSpent > BigInt(0),
      `TRON execution should succeed (${TRANSACTION_TYPES[0].name})`,
    )
    assert.deepEqual(res.accessList, [{ address: tx.to!.toString(), storageKeys: [] }])
  })

  it('simple run (reportPreimages option)', async () => {
    const vm = await createVM({ common })

    const tx = getTransaction(vm.common, 0, true)

    const caller = tx.getSenderAddress()
    const acc = createAccountWithDefaults()
    await vm.stateManager.putAccount(caller, acc)

    const res = await runTx(vm, { tx, reportPreimages: true })

    const hashedCallerKey = vm.stateManager.getAppliedKey!(caller.bytes)

    const retrievedPreimage = res.preimages?.get(bytesToHex(hashedCallerKey))
    assert.isDefined(retrievedPreimage, 'preimage should be defined')
    assert.isTrue(
      equalsBytes(retrievedPreimage, caller.bytes),
      'preimage should be the caller address',
    )
  })

  it('run without signature', async () => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await createVM({ common })
      const tx = getTransaction(vm.common, txType.type, false)
      try {
        await runTx(vm, { tx })
        assert.fail('should throw error')
      } catch (e: any) {
        assert.isTrue(
          e.message.includes('not signed') === true ||
            e.message.includes('Invalid Signature') === true,
          `should fail for ${txType.name}`,
        )
      }
    }
  })

  it('run with insufficient funds', async () => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await createVM({ common })
      const tx = getTransaction(vm.common, txType.type, true)
      await expect(runTx(vm, { tx })).rejects.toThrow(/enough funds/i)
    }

    // EIP-1559
    // Fail if signer.balance < gas_limit * max_fee_per_gas
    const vm = await createVM({ common })
    let tx = getTransaction(vm.common, 2, true) as FeeMarket1559Tx
    const address = tx.getSenderAddress()
    tx = Object.create(tx)
    const maxCost: bigint = tx.gasLimit * tx.maxFeePerGas
    await vm.stateManager.putAccount(
      address,
      createAccountWithDefaults(BigInt(0), maxCost - BigInt(1)),
    )
    try {
      await runTx(vm, { tx })
      assert.fail('should throw error')
    } catch (e: any) {
      assert.isTrue(
        e.message.toLowerCase().includes('max cost'),
        `should fail if max cost exceeds balance`,
      )
    }
    // set sufficient balance
    await vm.stateManager.putAccount(address, createAccountWithDefaults(BigInt(0), maxCost))
    const res = await runTx(vm, { tx })
    assert.isDefined(res, 'should pass if balance is sufficient')
  })

  it('run with insufficient eip1559 funds', async () => {
    const vm = await createVM({ common })
    const tx = getTransaction(common, 2, true, '0x0', false)
    const address = tx.getSenderAddress()
    await vm.stateManager.putAccount(address, new Account())
    const account = await vm.stateManager.getAccount(address)
    account!.balance = BigInt(9000000) // This is the maxFeePerGas multiplied with the gasLimit of 90000
    await vm.stateManager.putAccount(address, account!)
    await runTx(vm, { tx })
    account!.balance = BigInt(9000000)
    await vm.stateManager.putAccount(address, account!)
    const tx2 = getTransaction(common, 2, true, '0x64', false) // Send 100 wei; now balance < maxFeePerGas*gasLimit + callvalue
    await expect(runTx(vm, { tx: tx2 })).rejects.toThrow(/max cost|enough funds/)
  })

  it('should throw on wrong nonces', async () => {
    const vm = await createVM({ common })
    const tx = getTransaction(common, 2, true, '0x0', false)
    const address = tx.getSenderAddress()
    await vm.stateManager.putAccount(address, new Account())
    const account = await vm.stateManager.getAccount(address)
    account!.balance = BigInt(9000000) // This is the maxFeePerGas multiplied with the gasLimit of 90000
    account!.nonce = BigInt(1)
    await vm.stateManager.putAccount(address, account!)
    await expect(runTx(vm, { tx })).rejects.toThrow(/nonce/)
  })

  it("run with maxBaseFee less than block's baseFee", async () => {
    // EIP-1559
    // Fail if transaction.maxFeePerGas < block.baseFeePerGas
    for (const txType of TRANSACTION_TYPES) {
      const vm = await createVM({ common })
      const tx = getTransaction(vm.common, txType.type, true)
      const block = createBlock({ header: { baseFeePerGas: 100000 } }, { common })
      try {
        await runTx(vm, { tx, block })
        assert.fail('should fail')
      } catch (e: any) {
        assert.isTrue(
          e.message.includes("is less than the block's baseFeePerGas"),
          'should fail with appropriate error',
        )
      }
    }
  })
})

describe('runTx() -> runtime behavior', () => {
  it('storage cache', async () => {
    for (const txType of TRANSACTION_TYPES) {
      const common = new Common({ chain: TronMainnet })
      const vm = await createVM({ common })
      const privateKey = SIGNER_A.privateKey
      /* Code which is deployed here:
        PUSH1 02
        PUSH1 00
        SSTORE
        INVALID
      */
      const code = hexToBytes('0x6002600055FE')
      const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
      await vm.stateManager.putCode(address, code)
      await vm.stateManager.putStorage(
        address,
        hexToBytes(`0x${'00'.repeat(32)}`),
        hexToBytes(`0x${'00'.repeat(31)}01`),
      )
      const txParams: any = {
        nonce: '0x00',
        gasPrice: 10,
        gasLimit: 100000,
        to: address,
      }
      if (txType.type === TransactionType.AccessListEIP2930) {
        txParams['chainId'] = common.chainId()
        txParams['accessList'] = []
      }
      txParams.type = txType.type
      if (txType.type === TransactionType.FeeMarketEIP1559) {
        delete txParams.gasPrice
        txParams.maxFeePerGas = 10n
        txParams.maxPriorityFeePerGas = 1n
      }
      const tx = createTx(txParams, { common }).sign(privateKey)
      assert.strictEqual(tx.type, txType.type)

      await vm.stateManager.putAccount(tx.getSenderAddress(), createAccountWithDefaults())

      const result = await runTx(vm, { tx })
      assert.strictEqual(result.execResult.exceptionError?.error, 'invalid opcode')
      assert.deepEqual(
        await vm.stateManager.getStorage(address, new Uint8Array(32)),
        hexToBytes('0x01'),
      )

      assert.strictEqual(
        (vm.stateManager.originalStorageCache as any).map.size,
        0,
        `should clear storage cache after every ${txType.name}`,
      )
    }
  })
})

describe('runTx() -> runtime errors', () => {
  it('account balance overflows (call)', async () => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await createVM({ common })
      const tx = getTransaction(vm.common, txType.type, true, '0x01')

      const caller = tx.getSenderAddress()
      const from = createAccountWithDefaults()
      await vm.stateManager.putAccount(caller, from)

      const to = createAccountWithDefaults(BigInt(0), MAX_INTEGER)
      await vm.stateManager.putAccount(tx.to!, to)

      const res = await runTx(vm, { tx })

      assert.strictEqual(
        res.execResult!.exceptionError!.error,
        'value overflow',
        `result should have 'value overflow' error set (${txType.name})`,
      )
      assert.strictEqual(
        (vm.stateManager as any)._checkpointCount,
        0,
        `checkpoint count should be 0 (${txType.name})`,
      )
    }
  })

  it('account balance overflows (create)', async () => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await createVM({ common })
      const tx = getTransaction(vm.common, txType.type, true, '0x01', true)

      const caller = tx.getSenderAddress()
      const from = createAccountWithDefaults()
      await vm.stateManager.putAccount(caller, from)

      const contractAddress = new Address(generateTronContractAddress(tx.hash(), caller.bytes))
      const to = createAccountWithDefaults(BigInt(0), MAX_INTEGER)
      await vm.stateManager.putAccount(contractAddress, to)

      const res = await runTx(vm, { tx })

      assert.strictEqual(
        res.execResult!.exceptionError!.error,
        'value overflow',
        `result should have 'value overflow' error set (${txType.name})`,
      )
      assert.strictEqual(
        (vm.stateManager as any)._checkpointCount,
        0,
        `checkpoint count should be 0 (${txType.name})`,
      )
    }
  })
})

// TODO: complete on result values and add more usage scenario test cases
describe('runTx() -> API return values', () => {
  it('simple run, common return values', async () => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await createVM({ common })
      const tx = getTransaction(vm.common, txType.type, true)

      const caller = tx.getSenderAddress()
      const acc = createAccountWithDefaults()
      await vm.stateManager.putAccount(caller, acc)

      const res = await runTx(vm, { tx })
      assert.strictEqual(
        res.execResult.executionGasUsed,
        BigInt(0),
        `execution result -> gasUsed -> 0 (${txType.name})`,
      )
      assert.strictEqual(
        res.execResult.exceptionError,
        undefined,
        `execution result -> exception error -> undefined (${txType.name})`,
      )
      assert.deepEqual(
        res.execResult.returnValue,
        Uint8Array.from([]),
        `execution result -> return value -> empty Uint8Array (${txType.name})`,
      )
      assert.strictEqual(res.gasRefund, BigInt(0), `gasRefund -> 0 (${txType.name})`)
    }
  })

  it('simple run, runTx default return values', async () => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await createVM({ common })
      const tx = getTransaction(vm.common, txType.type, true)

      const caller = tx.getSenderAddress()
      const acc = createAccountWithDefaults()
      await vm.stateManager.putAccount(caller, acc)

      const res = await runTx(vm, { tx })

      assert.strictEqual(
        res.totalGasSpent,
        tx.getIntrinsicGas(),
        `runTx result -> gasUsed -> tx.getIntrinsicGas() (${txType.name})`,
      )
      if (tx instanceof FeeMarket1559Tx) {
        const baseFee = BigInt(7)
        const inclusionFeePerGas =
          tx.maxPriorityFeePerGas < tx.maxFeePerGas - baseFee
            ? tx.maxPriorityFeePerGas
            : tx.maxFeePerGas - baseFee
        const gasPrice = inclusionFeePerGas + baseFee
        assert.strictEqual(
          res.amountSpent,
          res.totalGasSpent * gasPrice,
          `runTx result -> amountSpent -> gasUsed * gasPrice (${txType.name})`,
        )
      } else {
        assert.strictEqual(
          res.amountSpent,
          res.totalGasSpent * (tx as LegacyTx).gasPrice,
          `runTx result -> amountSpent -> gasUsed * gasPrice (${txType.name})`,
        )
      }

      assert.deepEqual(
        res.bloom.bitvector,
        hexToBytes(`0x${'00'.repeat(256)}`),
        `runTx result -> bloom.bitvector -> should be empty (${txType.name})`,
      )
      assert.strictEqual(
        res.receipt.cumulativeBlockGasUsed,
        res.totalGasSpent,
        `runTx result -> receipt.gasUsed -> result.gasUsed (${txType.name})`,
      )
      assert.deepEqual(
        res.receipt.bitvector,
        res.bloom.bitvector,
        `runTx result -> receipt.bitvector -> result.bloom.bitvector (${txType.name})`,
      )
      assert.deepEqual(
        res.receipt.logs,
        [],
        `runTx result -> receipt.logs -> empty array (${txType.name})`,
      )
    }
  })
})

describe('runTx() -> exception accounting', () => {
  it('consumes the execution budget on OOG and rolls back storage without refunds', async () => {
    const vm = await createVM()
    const contract = createAddressFromString('0x' + '31'.repeat(20))
    // Clear a slot, then spend the remaining budget in a loop.
    await vm.stateManager.putCode(contract, hexToBytes('0x60006000555b600556'))
    const slot = new Uint8Array(32)
    await vm.stateManager.putStorage(contract, slot, hexToBytes('0x01'))
    await setBalance(vm, SIGNER_A.address, 1000000n)
    const tx = createLegacyTx(
      { to: contract, gasLimit: 30000n, gasPrice: 10n },
      { common: vm.common },
    ).sign(SIGNER_A.privateKey)
    const result = await runTx(vm, { tx })
    assert.strictEqual(result.execResult.exceptionError?.error, 'out of gas')
    assert.strictEqual(result.totalGasSpent, 30000n)
    assert.strictEqual(result.gasRefund, 0n)
    assert.strictEqual(result.amountSpent, 300000n)
    assert.strictEqual((await vm.stateManager.getAccount(SIGNER_A.address))!.balance, 700000n)
    assert.deepEqual(await vm.stateManager.getStorage(contract, slot), hexToBytes('0x01'))
    assert.strictEqual((result.receipt as { status: number }).status, 0)
  })

  it('returns oversized REVERT data without depositing code or consuming the full budget', async () => {
    const vm = await createVM()
    await setBalance(vm, SIGNER_A.address, 10000000n)
    // PUSH2 24577, PUSH1 0, REVERT; memory expands to 769 words.
    const tx = createFeeMarket1559Tx(
      { data: '0x6160016000fd', gasLimit: 100000n, maxFeePerGas: 10n },
      { common: vm.common },
    ).sign(SIGNER_A.privateKey)
    const result = await runTx(vm, { tx })
    assert.strictEqual(result.execResult.exceptionError?.error, 'revert')
    assert.strictEqual(result.execResult.returnValue.length, 24577)
    assert.strictEqual(result.execResult.executionGasUsed, 6n + 3n * 769n + (769n * 769n) / 512n)
    assert.strictEqual(
      result.totalGasSpent,
      tx.getIntrinsicGas() + result.execResult.executionGasUsed,
    )
    assert.isTrue(result.totalGasSpent < tx.gasLimit)
    assert.isUndefined(await vm.stateManager.getAccount(result.createdAddress!))
    assert.strictEqual((result.receipt as { status: number }).status, 0)
  })
})

describe('runTx() -> RunTxOptions', () => {
  it('should throw on negative value args', async () => {
    const vm = await createVM({ common })
    await setBalance(vm, createZeroAddress(), BigInt(10000000000))
    for (const txType of TRANSACTION_TYPES) {
      const tx = getTransaction(vm.common, txType.type, false)
      tx.getSenderAddress = () => createZeroAddress()
      //@ts-expect-error overwrite read-only property
      tx.value -= BigInt(1)

      for (const skipBalance of [true, false]) {
        try {
          await runTx(vm, {
            tx,
            skipBalance,
          })
          assert.fail('should not accept a negative call value')
        } catch (err: any) {
          assert.isTrue(
            err.message.includes('value field cannot be negative'),
            'throws on negative call value',
          )
        }
      }
    }
  })
})

it('runTx() -> skipBalance behavior', async () => {
  const common = new Common({ chain: TronMainnet })
  const vm = await createVM({ common })

  for (const balance of [undefined, BigInt(5)]) {
    if (balance !== undefined) {
      await vm.stateManager.modifyAccountFields(SIGNER_A.address, { nonce: BigInt(0), balance })
    }
    const tx = createLegacyTx({
      gasLimit: BigInt(21000),
      value: BigInt(1),
      to: createZeroAddress(),
    }).sign(SIGNER_A.privateKey)

    const block = createBlock({ header: { baseFeePerGas: 0n } }, { common })
    const res = await runTx(vm, { tx, block, skipBalance: true })
    assert.isTrue(true, 'runTx should not throw with no balance and skipBalance')
    const afterTxBalance = (await vm.stateManager.getAccount(SIGNER_A.address))!.balance
    assert.strictEqual(
      afterTxBalance,
      balance !== undefined ? balance - 1n : BigInt(0),
      `sender balance should be >= 0 after transaction with skipBalance`,
    )
    assert.strictEqual(
      res.execResult.exceptionError,
      undefined,
      'no exceptionError with skipBalance',
    )
  }
})

it('Validate EXTCODEHASH puts KECCAK256_NULL on stack if calling account has no balance and zero nonce (but it did exist)', async () => {
  const common = new Common({ chain: TronMainnet })
  const vm = await createVM({ common })

  const pkey = new Uint8Array(32).fill(1)

  // CALLER EXTCODEHASH PUSH 0 SSTORE STOP
  // Puts EXTCODEHASH of CALLER into slot 0
  const code = hexToBytes('0x333F60005500')
  const codeAddr = createAddressFromString('0x' + '20'.repeat(20))
  await vm.stateManager.putCode(codeAddr, code)

  const tx = createLegacyTx({
    gasLimit: 100000,
    gasPrice: 10,
    to: codeAddr,
  }).sign(pkey)

  const addr = createAddressFromPrivateKey(pkey)
  await vm.stateManager.putAccount(addr, new Account())
  const acc = await vm.stateManager.getAccount(addr)
  acc!.balance = BigInt(tx.gasLimit * tx.gasPrice)
  await vm.stateManager.putAccount(addr, acc!)
  await runTx(vm, { tx, skipHardForkValidation: true })

  const hash = await vm.stateManager.getStorage(codeAddr, new Uint8Array(32))
  assert.deepEqual(hash, KECCAK256_NULL, 'hash ok')
})

it('Validate CALL does not charge new account gas when calling CALLER and caller is non-empty', async () => {
  const common = new Common({ chain: TronMainnet })
  const vm = await createVM({ common })

  const pkey = new Uint8Array(32).fill(1)

  // PUSH 0 DUP DUP DUP
  // CALLVALUE CALLER GAS
  // CALL
  // STOP

  // Calls CALLER and sends back the TRX just sent with the transaction
  const code = hexToBytes('0x600080808034335AF100')
  const codeAddr = createAddressFromString('0x' + '20'.repeat(20))
  await vm.stateManager.putCode(codeAddr, code)

  const tx = createLegacyTx({
    gasLimit: 100000,
    gasPrice: 10,
    value: 1,
    to: codeAddr,
  }).sign(pkey)

  const addr = createAddressFromPrivateKey(pkey)
  await vm.stateManager.putAccount(addr, new Account())
  const acc = await vm.stateManager.getAccount(addr)
  acc!.balance = BigInt(tx.gasLimit * tx.gasPrice + tx.value)
  await vm.stateManager.putAccount(addr, acc!)
  assert.strictEqual(
    (await runTx(vm, { tx, skipHardForkValidation: true })).totalGasSpent,
    21000n + 3n * 4n + 2n * 3n + 40n + 9000n - 2300n,
    'did not charge callNewAccount',
  )
})

it('Validate SELFDESTRUCT does not charge new account gas when calling CALLER and caller is non-empty', async () => {
  const common = new Common({ chain: TronMainnet })
  const vm = await createVM({ common })

  const pkey = new Uint8Array(32).fill(1)

  // CALLER EXTCODEHASH PUSH 0 SSTORE STOP
  // Puts EXTCODEHASH of CALLER into slot 0
  const code = hexToBytes('0x33FF')
  const codeAddr = createAddressFromString('0x' + '20'.repeat(20))
  await vm.stateManager.putCode(codeAddr, code)

  const tx = createLegacyTx({
    gasLimit: 100000,
    gasPrice: 10,
    value: 1,
    to: codeAddr,
  }).sign(pkey)

  const addr = createAddressFromPrivateKey(pkey)
  await vm.stateManager.putAccount(addr, new Account())
  const acc = await vm.stateManager.getAccount(addr)
  acc!.balance = BigInt(tx.gasLimit * tx.gasPrice + tx.value)
  await vm.stateManager.putAccount(addr, acc!)
  assert.strictEqual(
    (await runTx(vm, { tx, skipHardForkValidation: true })).totalGasSpent,
    21000n + 2n + 5000n,
    'did not charge callNewAccount',
  )
})
