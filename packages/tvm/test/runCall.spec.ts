import { keccak_256 } from '@noble/hashes/sha3.js'
import { Common, Hardfork, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { SIGNER_G } from '@tvmjs/testdata'
import {
  Account,
  Address,
  MAX_UINT64,
  MIN_TOKEN_ID,
  bytesToHex,
  concatBytes,
  createAddressFromString,
  createZeroAddress,
  hexToBytes,
  padToEven,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { TVMError } from '../src/errors.ts'
import { createTVM } from '../src/index.ts'

// Independent TRON CREATE2 formula: keccak256(0x41 || creator20 || salt32 || initcodeHash).
function tronCreate2Address(
  sourceAddress: Address,
  codeHash: Uint8Array,
  salt: Uint8Array,
): Address {
  const prefix = Uint8Array.of(0x41)
  const hashBytes = concatBytes(prefix, sourceAddress.bytes, salt, codeHash)
  return new Address(keccak_256(hashBytes).slice(12))
}

describe('RunCall tests', () => {
  it('creates a TRON deployment when the caller nonce is zero', async () => {
    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })
    const res = await tvm.runCall({ to: undefined, rootTransactionId: new Uint8Array(32) })
    assert.isUndefined(res.execResult.exceptionError)
    assert.strictEqual(
      res.createdAddress?.toString(),
      '0x675e991f2dbd1a61dd0d257de5be78e4fa9dd48c',
      'derives the address from the root transaction ID and 21-byte owner',
    )
  })

  /*
    This test:
        Setups a contract at address 0x00..ff
        Instantiates the TVM with the TRON execution profile
        Calls the address with various arguments (callvalue is used as argument). VMs `runCall` is used.
        The CREATE2 address which the contract creates is checked against the expected CREATE2 value.
*/

  it('TRON CREATE2 returns the 21-byte address for every salt', async () => {
    // setup the accounts for this test
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee')) // caller address
    const contractAddress = new Address(hexToBytes('0x00000000000000000000000000000000000000ff')) // contract address
    // setup the vm

    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })
    const code = '0x3460008080F560005260206000F3'
    /*
      code:             remarks: (top of the stack is at the zero index)
        CALLVALUE
        PUSH1 0x00
        DUP1
        DUP1
        CREATE2         [0, 0, 0, CALLVALUE]
        PUSH1 0x00
        MSTORE          [0x00, <created address>]
        PUSH1 0x20
        PUSH1 0x00
        RETURN          [0x00, 0x20]
    */

    await tvm.stateManager.putCode(contractAddress, hexToBytes(code)) // setup the contract code
    await tvm.stateManager.putAccount(caller, new Account(BigInt(0), BigInt(0x11111111))) // give the calling account a big balance so we don't run out of funds
    const codeHash = keccak_256(new Uint8Array())
    for (let value = 0; value <= 1000; value += 20) {
      // setup the call arguments
      const runCallArgs = {
        caller, // call address
        gasLimit: BigInt(0xffffffffff), // ensure we pass a lot of gas, so we do not run out of gas
        to: contractAddress, // call to the contract address
        value: BigInt(value), // call with this value (the value is used in the contract as an argument, see above's code)
      }

      let valueBytes = hexToBytes(`0x${padToEven(value.toString(16))}`)
      // pad bytes
      if (valueBytes.length < 32) {
        const diff = 32 - valueBytes.length
        valueBytes = concatBytes(new Uint8Array(diff), valueBytes)
      }
      // calculate expected CREATE2 address
      const expectedAddress = tronCreate2Address(contractAddress, codeHash, valueBytes)
      // run the actual call
      const res = await tvm.runCall(runCallArgs)
      assert.isUndefined(res.execResult.exceptionError)
      assert.strictEqual(res.execResult.returnValue.length, 32)
      assert.strictEqual(res.execResult.returnValue[11], 0x41)
      // The stack word contains the 21-byte TRON address; Address stores its low 20 bytes.
      const executionReturnValue = new Address(res.execResult.returnValue.slice(12))
      if (!expectedAddress.equals(executionReturnValue)) {
        assert.fail('contract address not equal')
      }
    }
  })

  it.each([TronMainnet, TronNile, TronShasta])(
    '$name keeps SHL available when an Ethereum hardfork switch is rejected',
    async (chain) => {
      const common = new Common({ chain })
      const tvm = await createTVM({ common })
      assert.throws(() => common.setHardfork(Hardfork.Byzantium), /not supported/)
      assert.strictEqual(common.hardfork(), Hardfork.Tron)
      const result = await tvm.runCode({ code: hexToBytes('0x600160011b00'), gasLimit: 9n })
      assert.isUndefined(result.exceptionError)
      assert.deepEqual(result.runState!.stack.peek(), [2n])
      assert.strictEqual(result.executionGasUsed, 9n)
    },
  )

  it('charges TRON writes from a padded original value without a reset refund', async () => {
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee'))
    const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
    const tvm = await createTVM({ common: new Common({ chain: TronMainnet }) })
    const key = new Uint8Array(32)
    await tvm.stateManager.putCode(address, hexToBytes('0x61000260005561000160005500'))
    await tvm.stateManager.putStorage(address, key, hexToBytes(`0x${'00'.repeat(31)}01`))
    const result = await tvm.runCall({ caller, to: address, gasLimit: 50000n })
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(result.execResult.executionGasUsed, 10012n)
    assert.strictEqual(result.execResult.gasRefund, 0n)
    assert.deepEqual(await tvm.stateManager.getStorage(address, key), Uint8Array.of(1))
  })

  it('charges TRON zero-to-nonzero storage writes', async () => {
    // setup the accounts for this test
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee')) // caller address
    const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
    // setup the vm
    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })
    // push 1 push 0 sstore stop
    const code = '0x600160015500'

    await tvm.stateManager.putCode(address, hexToBytes(code))

    // setup the call arguments
    const runCallArgs = {
      caller, // call address
      to: address,
      gasLimit: BigInt(0xffffffffff), // ensure we pass a lot of gas, so we do not run out of gas
    }

    const result = await tvm.runCall(runCallArgs)

    assert.strictEqual(result.execResult.executionGasUsed, BigInt(20006), 'gas used correct')
    assert.strictEqual(result.execResult.gasRefund, BigInt(0), 'gas refund correct')
  })

  it('charges TRON zero-value CALL without creating an absent recipient', async () => {
    // setup the accounts for this test
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee')) // caller address
    const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
    // setup the vm

    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })
    // code to call 0x00..00dd, which does not exist
    const code = '0x6000600060006000600060DD61FFFF5A03F100'

    await tvm.stateManager.putCode(address, hexToBytes(code))

    // setup the call arguments
    const runCallArgs = {
      caller, // call address
      to: address,
      gasLimit: BigInt(0xffffffffff), // ensure we pass a lot of gas, so we do not run out of gas
    }

    const result = await tvm.runCall(runCallArgs)

    // 7 PUSH instructions + GAS + SUB + CALL: 21 + 2 + 3 + 40 = 66.
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(result.execResult.executionGasUsed, 66n, 'Energy used correctly')
    assert.isUndefined(
      await tvm.stateManager.getAccount(
        createAddressFromString('0x00000000000000000000000000000000000000dd'),
      ),
    )
    assert.strictEqual(result.execResult.gasRefund, BigInt(0), 'gas refund correct')
  })

  it('rejects CALLCODE when memory expansion exceeds the available Energy', async () => {
    // setup the accounts for this test
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee')) // caller address
    const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
    // setup the vm

    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })
    // code to call back into the calling account (0x00..00EE),
    // but using too much memory
    const code = '0x61FFFF60FF60006000600060EE6000F200'

    await tvm.stateManager.putCode(address, hexToBytes(code))

    // setup the call arguments
    const runCallArgs = {
      caller, // call address
      to: address,
      gasLimit: BigInt(200),
    }

    const result = await tvm.runCall(runCallArgs)

    assert.strictEqual(runCallArgs.gasLimit, result.execResult.executionGasUsed, 'gas used correct')
    assert.strictEqual(result.execResult.gasRefund, BigInt(0), 'gas refund correct')
    assert.strictEqual(
      result.execResult.exceptionError?.error,
      TVMError.errorMessages.OUT_OF_GAS,
      'call went out of gas',
    )
  })

  it('ensure selfdestruct pays for creating new accounts', async () => {
    // setup the accounts for this test
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee')) // caller address
    const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
    // setup the vm

    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })
    // SELFDESTRUCT to the missing beneficiary 0x00..00fe.
    const code = '0x60FEFF'

    await tvm.stateManager.putCode(address, hexToBytes(code))

    // setup the call arguments
    const runCallArgs = {
      caller, // call address
      to: address,
      gasLimit: BigInt(0xffffffffff),
    }

    const result = await tvm.runCall(runCallArgs)
    // gas: 5000 (selfdestruct) + 25000 (call new account)  + push (1) = 30003
    assert.strictEqual(result.execResult.executionGasUsed, BigInt(30003), 'gas used correct')
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(result.execResult.gasRefund, 0n, 'TRON does not refund SELFDESTRUCT Energy')
  })

  const selfdestructNewAccountCases = (['missing', 'empty', 'existing', 'self'] as const).flatMap(
    (beneficiaryState) =>
      [0n, 1n].flatMap((trxBalance) =>
        [0n, 100n].map((tokenBalance) => ({ beneficiaryState, tokenBalance, trxBalance })),
      ),
  )

  it.each(selfdestructNewAccountCases)(
    'charges SELFDESTRUCT new-account gas correctly for beneficiary=$beneficiaryState, TRX=$trxBalance, Token=$tokenBalance',
    async ({ beneficiaryState, tokenBalance, trxBalance }) => {
      const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee'))
      const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
      const externalBeneficiary = new Address(
        hexToBytes('0x00000000000000000000000000000000000000fe'),
      )
      const beneficiary = beneficiaryState === 'self' ? address : externalBeneficiary
      const tokenId = MIN_TOKEN_ID + 1n
      const common = new Common({ chain: TronMainnet })
      const tvm = await createTVM({ common })
      const code = `0x73${beneficiary.toString().slice(2)}ff` as `0x${string}`
      let initialBeneficiaryBalance = 0n

      if (beneficiaryState === 'empty') {
        await tvm.stateManager.putAccount(beneficiary, new Account())
      } else if (beneficiaryState === 'existing') {
        initialBeneficiaryBalance = 1n
        await tvm.stateManager.putAccount(beneficiary, new Account(0n, 1n))
      }

      await tvm.stateManager.putCode(address, hexToBytes(code))
      const contractAccount = await tvm.stateManager.getAccount(address)
      contractAccount!.balance = trxBalance
      contractAccount!.asset = { [Number(tokenId)]: tokenBalance }
      await tvm.stateManager.putAccount(address, contractAccount!)

      const result = await tvm.runCall({
        caller,
        to: address,
        gasLimit: BigInt(0xffffffffff),
      })

      // TRON: java-tron getSuicideCost2/3 + isDeadAccount logic:
      // - Charges newAccountGas ONLY when beneficiary does NOT exist (account === undefined)
      // - Does NOT check isEmpty() (existing empty accounts don't charge)
      // - Does NOT check transfer amount (charges even if TRX=0 and Token=0)
      // This differs from EIP-161 which requires both transfersValue AND isEmpty().
      const beneficiaryDoesNotExist = beneficiaryState === 'missing'
      const expectedGas = 5003n + (beneficiaryDoesNotExist ? 25000n : 0n)
      assert.strictEqual(result.execResult.executionGasUsed, expectedGas, 'gas used correct')
      assert.strictEqual(result.execResult.gasRefund, 0n, 'TRON has no selfdestruct refund')

      if (beneficiaryState !== 'self') {
        const beneficiaryAccount = await tvm.stateManager.getAccount(beneficiary)
        assert.strictEqual(
          beneficiaryAccount?.balance,
          initialBeneficiaryBalance + trxBalance,
          'TRX balance transferred to beneficiary',
        )
        assert.strictEqual(
          beneficiaryAccount?.getTokenBalance(tokenId),
          tokenBalance,
          'token balance transferred to beneficiary',
        )
        // Verify source account is cleared
        const sourceAccount = await tvm.stateManager.getAccount(address)
        assert.strictEqual(sourceAccount?.balance, 0n, 'source TRX balance cleared')
        assert.strictEqual(
          sourceAccount?.getTokenBalance(tokenId),
          0n,
          'source token balance cleared',
        )
      } else {
        // The current tron profile activates EIP-6780. A pre-existing contract
        // that selfdestructs to itself retains its balance and token state.
        const selfAccount = await tvm.stateManager.getAccount(address)
        assert.strictEqual(selfAccount?.balance, trxBalance, 'self TRX balance preserved')
        assert.strictEqual(
          selfAccount?.getTokenBalance(tokenId),
          tokenBalance,
          'self token balance preserved',
        )
      }
    },
  )

  it('charges SELFDESTRUCT new-account gas without cold access pricing on tron', async () => {
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee'))
    const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
    const beneficiary = new Address(hexToBytes('0x00000000000000000000000000000000000000fe'))
    const tokenId = MIN_TOKEN_ID + 1n
    const tokenBalance = 100n
    const common = new Common({ chain: TronMainnet })
    assert.isFalse(common.isActivatedEIP(2929))
    assert.isFalse(common.isActivatedEIP(3529))
    assert.isTrue(common.isActivatedEIP(6780))
    const tvm = await createTVM({ common })
    const code = `0x73${beneficiary.toString().slice(2)}ff` as `0x${string}`

    await tvm.stateManager.putCode(address, hexToBytes(code))
    const contractAccount = await tvm.stateManager.getAccount(address)
    contractAccount!.asset = { [Number(tokenId)]: tokenBalance }
    await tvm.stateManager.putAccount(address, contractAccount!)

    const result = await tvm.runCall({
      caller,
      to: address,
      gasLimit: BigInt(0xffffffffff),
    })

    // PUSH20 3 + SELFDESTRUCT 5000 + new account 25000 = 30003 Energy.
    assert.strictEqual(result.execResult.executionGasUsed, 30003n, 'gas used correct on tron')
    assert.strictEqual(result.execResult.gasRefund, 0n, 'TRON has no selfdestruct refund')

    const beneficiaryAccount = await tvm.stateManager.getAccount(beneficiary)
    assert.strictEqual(
      beneficiaryAccount?.getTokenBalance(tokenId),
      tokenBalance,
      'token transferred on tron hardfork',
    )
  })

  it('rolls back SELFDESTRUCT token transfer when new-account gas runs out', async () => {
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee'))
    const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
    const beneficiary = new Address(hexToBytes('0x00000000000000000000000000000000000000fe'))
    const tokenId = MIN_TOKEN_ID + 1n
    const tokenBalance = 100n
    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })

    await tvm.stateManager.putCode(address, hexToBytes('0x60FEFF'))
    const contractAccount = await tvm.stateManager.getAccount(address)
    contractAccount!.asset = { [Number(tokenId)]: tokenBalance }
    await tvm.stateManager.putAccount(address, contractAccount!)

    // One less than PUSH1 3 + SELFDESTRUCT 5000 + new account 25000.
    const result = await tvm.runCall({ caller, to: address, gasLimit: 30002n })

    assert.strictEqual(result.execResult.executionGasUsed, 30002n, 'all available gas consumed')
    assert.strictEqual(result.execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
    assert.isUndefined(await tvm.stateManager.getAccount(beneficiary), 'beneficiary not created')
    assert.strictEqual(
      (await tvm.stateManager.getAccount(address))?.getTokenBalance(tokenId),
      tokenBalance,
      'source token balance preserved',
    )
  })

  it('charges each TRON call from the current slot value without storage refunds', async () => {
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee'))
    const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
    const tvm = await createTVM({ common: new Common({ chain: TronMainnet }) })
    await tvm.stateManager.putAccount(caller, new Account(0n, 100n))
    await tvm.stateManager.putCode(address, hexToBytes('0x3460005500'))

    // Four separate calls store CALLVALUE: 0 -> 0 -> 1 -> 2 -> 0.
    for (const [value, energy] of [
      [0n, 5005n],
      [1n, 20005n],
      [2n, 5005n],
      [0n, 5005n],
    ]) {
      const result = await tvm.runCall({ caller, to: address, value, gasLimit: 50000n })
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.executionGasUsed, energy)
      assert.strictEqual(result.execResult.gasRefund, 0n)
      assert.deepEqual(
        await tvm.stateManager.getStorage(address, new Uint8Array(32)),
        value === 0n ? new Uint8Array() : Uint8Array.of(Number(value)),
      )
    }
    assert.strictEqual((await tvm.stateManager.getAccount(caller))!.balance, 97n)
    assert.strictEqual((await tvm.stateManager.getAccount(address))!.balance, 3n)
  })

  it('Ensure that contracts cannot exceed nonce of MAX_UINT64 when creating new contracts (EIP-2681)', async () => {
    // setup the accounts for this test
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee')) // caller address
    const address = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))
    const slot = hexToBytes(`0x${'00'.repeat(32)}`)
    const emptyBytes = hexToBytes('0x')
    // setup the vm

    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })
    const code = '0x60008080F060005500'
    /*
      This simple code tries to create an empty contract and then stores the address of the contract in the zero slot.
        CODE:
          PUSH 0
          DUP1
          DUP1
          CREATE -> Stack is now [0,0,0] ([value, offset, length])
          PUSH 0
          SSTORE -> stack is now [0, <Created Address>], so this stores the <Created Address> at slot 0
          STOP
    */

    await tvm.stateManager.putCode(address, hexToBytes(code))

    const account = await tvm.stateManager.getAccount(address)
    account!.nonce = MAX_UINT64 - BigInt(1)
    await tvm.stateManager.putAccount(address, account!)

    // setup the call arguments
    const runCallArgs = {
      caller, // call address
      to: address,
      rootTransactionId: new Uint8Array(32).fill(1),
      gasLimit: BigInt(0xffffffffff), // ensure we pass a lot of gas, so we do not run out of gas
    }

    const first = await tvm.runCall(runCallArgs)
    assert.isUndefined(first.execResult.exceptionError)
    assert.strictEqual((await tvm.stateManager.getAccount(address))!.nonce, MAX_UINT64)
    let storage = await tvm.stateManager.getStorage(address, slot)

    // The nonce is MAX_UINT64 - 1, so we are allowed to create a contract (nonce of creating contract is now MAX_UINT64)
    assert.notDeepEqual(storage, emptyBytes, 'successfully created contract')

    // A new transaction ID prevents an address collision from masking the nonce limit.
    const second = await tvm.runCall({
      ...runCallArgs,
      rootTransactionId: new Uint8Array(32).fill(2),
    })
    assert.isUndefined(second.execResult.exceptionError)
    assert.strictEqual((await tvm.stateManager.getAccount(address))!.nonce, MAX_UINT64)

    // The nonce is MAX_UINT64, so we are NOT allowed to create a contract (nonce of creating contract is now MAX_UINT64)
    storage = await tvm.stateManager.getStorage(address, slot)
    assert.deepEqual(
      storage,
      emptyBytes,
      'failed to create contract; nonce of creating contract is too high (MAX_UINT64)',
    )
  })

  it('Ensure that IDENTITY precompile copies the memory', async () => {
    // This test replays the Geth chain split; https://etherscan.io/tx/0x1cb6fb36633d270edefc04d048145b4298e67b8aa82a9e5ec4aa1435dd770ce4
    // Exploit post-mortem: https://github.com/ethereum/go-ethereum/blob/master/docs/postmortems/2021-08-22-split-postmortem.md
    // Permalink: https://github.com/ethereum/go-ethereum/blob/90987db7334c1d10eb866ca550efedb66dea8a20/docs/postmortems/2021-08-22-split-postmortem.md
    // setup the accounts for this test
    const caller = new Address(hexToBytes('0x1a02a619e51cc5f8a2a61d2a60f6c80476ee8ead')) // caller address
    // setup the vm

    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })
    const code = '0x3034526020600760203460045afa602034343e604034f3'

    const account = new Account()
    account!.nonce = BigInt(1) // ensure nonce for contract is correct
    account!.balance = BigInt(10000000000000000)
    await tvm.stateManager.putAccount(caller, account!)

    // setup the call arguments
    const runCallArgs = {
      caller, // call address
      gasLimit: BigInt(150000),
      data: hexToBytes(code),
      rootTransactionId: new Uint8Array(32),
      gasPrice: BigInt(70000000000),
    }

    const result = await tvm.runCall(runCallArgs)
    assert.isUndefined(result.execResult.exceptionError)
    const expectedAddress = '0xc823b6d87a2cf17a731af1b6e150e58c13b2ee7f'
    // ADDRESS uses the internal 20-byte account address; CREATE/CREATE2 return 21 bytes.
    const addressWord = hexToBytes(`0x${'00'.repeat(12)}${expectedAddress.slice(2)}`)
    const expectedMemory = new Uint8Array(64)
    expectedMemory.set(addressWord, 7)
    expectedMemory.set(addressWord, 0)

    assert.strictEqual(
      result.createdAddress?.toString(),
      expectedAddress,
      'created address correct',
    )
    const deployedCode = await tvm.stateManager.getCode(result.createdAddress!)
    assert.deepEqual(
      deployedCode,
      expectedMemory,
      'IDENTITY keeps an independent copy across overlapping memory writes',
    )
  })

  it('Throws on negative call value', async () => {
    // setup the vm

    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })

    // setup the call arguments
    const runCallArgs = {
      to: createZeroAddress(),
      value: BigInt(-10),
    }

    try {
      await tvm.runCall(runCallArgs)
      assert.fail('should not accept a negative call value')
    } catch (err: any) {
      assert.isTrue(
        err.message.includes('value field cannot be negative'),
        'throws on negative call value',
      )
    }
  })

  it('runCall() -> skipBalance behavior', async () => {
    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })

    // runCall against a contract to reach `_reduceSenderBalance`
    const contractCode = hexToBytes('0x00') // 00: STOP
    const contractAddress = createAddressFromString('0x000000000000000000000000636F6E7472616374')
    await tvm.stateManager.putCode(contractAddress, contractCode)

    const sender = SIGNER_G.address

    const runCallArgs = {
      gasLimit: BigInt(21000),
      value: BigInt(6),
      caller: sender,
      to: contractAddress,
      skipBalance: true,
    }

    for (const balance of [undefined, 5n, 10n]) {
      await tvm.stateManager.modifyAccountFields(contractAddress, { balance: 0n })
      await tvm.stateManager.modifyAccountFields(sender, { nonce: BigInt(0), balance })
      const res = await tvm.runCall(runCallArgs)
      const senderBalance = (await tvm.stateManager.getAccount(sender))!.balance
      assert.strictEqual(
        senderBalance,
        balance !== undefined && balance >= 6n ? balance - 6n : 0n,
        'skipBalance funds only a shortfall and the call still debits the sender',
      )
      assert.strictEqual((await tvm.stateManager.getAccount(contractAddress))!.balance, 6n)
      assert.strictEqual(
        res.execResult.exceptionError,
        undefined,
        'no exceptionError with skipBalance',
      )
    }

    await tvm.stateManager.modifyAccountFields(sender, { balance: 5n })
    const res2 = await tvm.runCall({ ...runCallArgs, skipBalance: false })
    assert.include(
      res2.execResult.exceptionError?.error,
      'insufficient balance',
      'runCall reverts when insufficient sender balance and skipBalance is false',
    )
    assert.strictEqual((await tvm.stateManager.getAccount(sender))!.balance, 5n)
    assert.strictEqual((await tvm.stateManager.getAccount(contractAddress))!.balance, 6n)
  })

  it('runCall() => permits runtime code above the former EIP-170 limit', async () => {
    // setup the accounts for this test
    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee')) // caller address
    // setup the tvm
    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })

    // setup the call arguments
    const runCallArgs = {
      caller, // call address
      gasLimit: 4918868n,
      rootTransactionId: new Uint8Array(32),
      data: hexToBytes('0x6160016000f3'),
    }

    const result = await tvm.runCall(runCallArgs)
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(result.execResult.executionGasUsed, 4918868n)
    assert.strictEqual((await tvm.stateManager.getCode(result.createdAddress!)).length, 24577)
  })

  it('step event: ensure TVM memory and not internal memory gets reported', async () => {
    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })

    const contractCode = hexToBytes('0x600060405200') // PUSH 0 PUSH 40 MSTORE STOP
    const contractAddress = createAddressFromString('0x000000000000000000000000636F6E7472616374')
    await tvm.stateManager.putCode(contractAddress, contractCode)

    const runCallArgs = {
      gasLimit: BigInt(21000),
      to: contractAddress,
    }

    let verifyMemoryExpanded = false

    tvm.events.on('step', (e) => {
      assert.isTrue(e.memory.length <= 96)
      if (e.memory.length > 0) {
        verifyMemoryExpanded = true
      }
    })
    await tvm.runCall(runCallArgs)
    assert.isTrue(verifyMemoryExpanded, 'memory did expand')
  })

  it('reports Energy shortages during code deposit and memory expansion', async () => {
    const common = new Common({ chain: TronMainnet })
    const tvm = await createTVM({ common })

    // Execution succeeds but the remaining Energy cannot pay the code deposit fee.
    const runCallArgs = {
      gasLimit: BigInt(10000000),
      data: hexToBytes('0x61FFFF6000F3'),
      rootTransactionId: new Uint8Array(32),
    }

    const res = await tvm.runCall(runCallArgs)
    assert.strictEqual(res.execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
    assert.strictEqual(res.execResult.executionGasUsed, runCallArgs.gasLimit)
    assert.isUndefined(await tvm.stateManager.getAccount(res.createdAddress!))

    // Create a contract which goes OOG when creating
    const runCallArgs2 = {
      gasLimit: BigInt(100000),
      data: hexToBytes('0x62FFFFFF6000F3'),
      rootTransactionId: new Uint8Array(32),
    }

    const res2 = await tvm.runCall(runCallArgs2)
    assert.strictEqual(res2.execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
    assert.strictEqual(res2.execResult.executionGasUsed, runCallArgs2.gasLimit)
    assert.isUndefined(await tvm.stateManager.getAccount(res2.createdAddress!))
  })

  it('ensure call and callcode handle gas stipend correctly', async () => {
    // See: https://github.com/ethereumjs/ethereumjs-monorepo/issues/3194

    const common = new Common({ chain: TronMainnet })

    for (const [opcode, gas, expectedOutput] of [
      ['f1', 34040, '0x'], // CALL base 40 + value transfer 9000 + new account 25000
      ['f2', 9040, '0x'], // CALLCODE base 40 + value transfer 9000
      ['f1', 34040 + 7 * 3, '0x01'], // Fee plus seven PUSH instructions
      ['f2', 9040 + 7 * 3, '0x01'], // Fee plus seven PUSH instructions
    ] as const) {
      const tvm = await createTVM({ common: common.copy() })
      // Code to either CALL or CALLCODE into AACC empty contract, with value 1 // cspell:disable-line
      // If enough gas is provided, then since nonzero value is sent, the gas limit
      // in the call(coded) contract will get the "bonus gas" stipend of 2300
      // Previously, we added this gas stipend to the current gas available (which is wrong)

      /***
       * Bytecode for AAAA contract (used to check CALL/CALLCODE execution when gas is less than required)
       * PUSH1 0x00
       * PUSH1 0x00
       * PUSH1 0x00
       * PUSH1 0x00
       * PUSH1 0x01
       * PUSH2 0xAACC
       * PUSH2 0x1a90 // Note: this is the gas available in the new call(code) frame, this value does not matter
       * CALLCODE/CALL
       */
      const callCodeAddress = createAddressFromString('0x000000000000000000000000000000000000aaaa')
      const callCode = hexToBytes(`0x6000600060006000600161AACC611a90${opcode}`)

      const gasLimit = gas.toString(16).padStart(4, '0')

      /***
       * Bytecode for AAAB contract (used to call contract AAAA and stores result of call execution) // cspell:disable-line
       * PUSH1 0x00
       * DUP1
       * DUP1
       * DUP1
       * DUP1
       * PUSH2 0xAAAA
       * PUSH2 0x{gas}  <- This is the gas limit set for the CALL/CODE execution
       * CALL
       * PUSH1 0x00
       * SSTORE
       */
      const callerAddress = createAddressFromString('0x000000000000000000000000000000000000aaab')
      const callerCode = hexToBytes(`0x60008080808061AAAA61${gasLimit}f1600055`)

      await tvm.stateManager.putAccount(callCodeAddress, new Account(0n, 1n))
      await tvm.stateManager.putCode(callCodeAddress, callCode)

      await tvm.stateManager.putAccount(callerAddress, new Account(undefined, BigInt(1)))
      await tvm.stateManager.putCode(callerAddress, callerCode)

      const runCallArgs = {
        to: callerAddress,
        gasLimit: 0xfffffffn,
      }
      const result = await tvm.runCall(runCallArgs)
      assert.isUndefined(result.execResult.exceptionError)

      const callResult = bytesToHex(
        await tvm.stateManager.getStorage(callerAddress, new Uint8Array(32)),
      )
      // Expect slot to have value of either: 0 since CALLCODE and CODE did not have enough gas to execute
      // Or 1, if CALL(CODE) has enough gas to enter the new call frame
      assert.strictEqual(callResult, expectedOutput, `should have result ${expectedOutput}`)
      const target = createAddressFromString('0x000000000000000000000000000000000000aacc')
      if (opcode === 'f1' && expectedOutput === '0x01') {
        assert.strictEqual((await tvm.stateManager.getAccount(target))!.balance, 1n)
        assert.strictEqual((await tvm.stateManager.getAccount(callCodeAddress))!.balance, 0n)
      } else {
        assert.isUndefined(await tvm.stateManager.getAccount(target))
        assert.strictEqual((await tvm.stateManager.getAccount(callCodeAddress))!.balance, 1n)
      }
    }
  })
})
