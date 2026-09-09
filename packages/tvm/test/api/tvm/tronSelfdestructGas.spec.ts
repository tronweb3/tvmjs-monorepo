// cspell:ignore deaddeaddeaddeaddeaddeaddeaddeaddeaddead
import { Common, Hardfork, Mainnet, TronMainnet } from '@tvmjs/common'
import { Account, MIN_TOKEN_ID, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createTVM } from '../../../src/index.ts'

describe('TRON SELFDESTRUCT new account gas (java-tron alignment)', () => {
  const common = new Common({ chain: TronMainnet })

  it('should charge new account gas when beneficiary does NOT exist (TRX=0, Token=0)', async () => {
    // java-tron: charges newAccountGas when account === undefined, regardless of transfer amount
    // Bytecode: PUSH20(beneficiary) SELFDESTRUCT
    // PUSH20 = 0x73 + 20 bytes, SELFDESTRUCT = 0xff
    const beneficiaryHex = 'deaddeaddeaddeaddeaddeaddeaddeaddeaddead'
    const code = hexToBytes(`0x73${beneficiaryHex}ff`)
    const tvm = await createTVM({ common })

    const result = await tvm.runCode({
      code,
      gasLimit: BigInt(50000),
    })

    // 5003 base + 25000 new-account + 2600 EIP-2929 cold beneficiary access.
    assert.isUndefined(result.exceptionError, 'Should not error')
    assert.equal(result.executionGasUsed, 32603n, 'Should charge new account gas')
    assert.equal(result.gasRefund, 0n, 'EIP-3529 removes the selfdestruct refund')
  })

  it('should NOT charge new account gas when beneficiary exists but is empty', async () => {
    // java-tron: only checks account === undefined, NOT isEmpty()
    // Existing empty account should NOT charge newAccountGas
    const beneficiaryHex = 'deaddeaddeaddeaddeaddeaddeaddeaddeaddead'
    const beneficiary = createAddressFromString(`0x${beneficiaryHex}`)
    const code = hexToBytes(`0x73${beneficiaryHex}ff`)
    const tvm = await createTVM({ common })

    // Pre-create an empty account (nonce=0, balance=0, but EXISTS)
    const emptyAccount = new Account()
    await tvm.stateManager.putAccount(beneficiary, emptyAccount)

    const result = await tvm.runCode({
      code,
      gasLimit: BigInt(50000),
    })

    // 5003 base + 2600 EIP-2929 cold beneficiary access, with no new-account gas.
    assert.isUndefined(result.exceptionError, 'Should not error')
    assert.equal(
      result.executionGasUsed,
      7603n,
      'Should NOT charge new account gas for existing empty account',
    )
    assert.equal(result.gasRefund, 0n, 'EIP-3529 removes the selfdestruct refund')
  })

  it('should charge new account gas when only a TRC-10 token is transferred', async () => {
    const source = createAddressFromString('0x1000000000000000000000000000000000000001')
    const beneficiary = createAddressFromString('0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead')
    const tokenId = MIN_TOKEN_ID + 1n
    const tokenBalance = 100n
    const code = hexToBytes(`0x73${beneficiary.toString().slice(2)}ff`)
    const tvm = await createTVM({ common })

    await tvm.stateManager.putCode(source, code)
    const sourceAccount = await tvm.stateManager.getAccount(source)
    sourceAccount!.asset = { [Number(tokenId)]: tokenBalance }
    await tvm.stateManager.putAccount(source, sourceAccount!)

    const result = await tvm.runCall({ to: source, gasLimit: 50000n })

    assert.isUndefined(result.execResult.exceptionError, 'Should not error')
    assert.equal(result.execResult.executionGasUsed, 32603n, 'Should charge new account gas')
    assert.equal(
      (await tvm.stateManager.getAccount(beneficiary))?.getTokenBalance(tokenId),
      tokenBalance,
      'Should transfer the token balance',
    )
  })

  it('runCode should transfer without duplicating balance under EIP-6780', async () => {
    const source = createAddressFromString('0x1000000000000000000000000000000000000001')
    const beneficiary = createAddressFromString('0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead')
    const code = hexToBytes(`0x73${beneficiary.toString().slice(2)}ff`)
    const tvm = await createTVM({ common })

    await tvm.stateManager.putAccount(source, new Account(0n, 100n))
    const result = await tvm.runCode({ code, to: source, gasLimit: 50000n })

    assert.isUndefined(result.exceptionError, 'Should not error')
    assert.equal((await tvm.stateManager.getAccount(source))?.balance, 0n)
    assert.equal((await tvm.stateManager.getAccount(beneficiary))?.balance, 100n)
  })
})

describe('Ethereum EIP-161 SELFDESTRUCT regression (ensure not broken by TRON changes)', () => {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.SpuriousDragon })

  it('EIP-161: should charge newAccountGas when transferring value to empty account', async () => {
    const beneficiaryHex = 'deaddeaddeaddeaddeaddeaddeaddeaddeaddead'
    const beneficiary = createAddressFromString(`0x${beneficiaryHex}`)
    const code = hexToBytes(`0x73${beneficiaryHex}ff`)
    const caller = createAddressFromString('0x1000000000000000000000000000000000000001')
    const tvm = await createTVM({ common })

    // Pre-create an empty beneficiary account
    const emptyAccount = new Account()
    await tvm.stateManager.putAccount(beneficiary, emptyAccount)

    // Give caller some TRX balance so SELFDESTRUCT transfers value
    const callerAccount = new Account(0n, 1000n)
    await tvm.stateManager.putAccount(caller, callerAccount)
    await tvm.stateManager.putCode(caller, code)

    const result = await tvm.runCall({
      to: caller,
      gasLimit: BigInt(50000),
    })

    // EIP-161: should charge newAccountGas because transfersValue && isEmpty()
    // PUSH20 (3) + base SELFDESTRUCT (5000) + new account (25000) = 30003
    assert.isUndefined(result.execResult.exceptionError, 'Should not error')
    assert.equal(
      result.execResult.executionGasUsed,
      30003n,
      'EIP-161: should charge newAccountGas when transferring value to empty account',
    )
  })

  it('EIP-161: should NOT charge newAccountGas when balance=0 (no value transfer)', async () => {
    const beneficiaryHex = 'deaddeaddeaddeaddeaddeaddeaddeaddeaddead'
    const beneficiary = createAddressFromString(`0x${beneficiaryHex}`)
    const code = hexToBytes(`0x73${beneficiaryHex}ff`)
    const caller = createAddressFromString('0x1000000000000000000000000000000000000001')
    const tvm = await createTVM({ common })

    // Pre-create an empty beneficiary account
    const emptyAccount = new Account()
    await tvm.stateManager.putAccount(beneficiary, emptyAccount)

    // Caller has ZERO balance - no value transfer
    const callerAccount = new Account(0n, 0n)
    await tvm.stateManager.putAccount(caller, callerAccount)
    await tvm.stateManager.putCode(caller, code)

    const result = await tvm.runCall({
      to: caller,
      gasLimit: BigInt(50000),
    })

    // EIP-161: should NOT charge because balance=0 (no value transfer)
    // PUSH20 (3) + base SELFDESTRUCT (5000) = 5003
    assert.isUndefined(result.execResult.exceptionError, 'Should not error')
    assert.equal(
      result.execResult.executionGasUsed,
      5003n,
      'EIP-161: should NOT charge newAccountGas when balance=0',
    )
  })
})
