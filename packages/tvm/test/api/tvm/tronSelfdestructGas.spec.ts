// cspell:ignore deaddeaddeaddeaddeaddeaddeaddeaddeaddead
import { Common, TronMainnet } from '@tvmjs/common'
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

    // PUSH20 (3) + SELFDESTRUCT (5000) + missing beneficiary (25000).
    assert.isUndefined(result.exceptionError, 'Should not error')
    assert.equal(result.executionGasUsed, 30003n, 'Should charge new account gas')
    assert.equal(result.gasRefund, 0n, 'TRON does not refund SELFDESTRUCT Energy')
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

    // PUSH20 (3) + SELFDESTRUCT (5000), with no new-account or access charge.
    assert.isUndefined(result.exceptionError, 'Should not error')
    assert.equal(
      result.executionGasUsed,
      5003n,
      'Should NOT charge new account gas for existing empty account',
    )
    assert.equal(result.gasRefund, 0n, 'TRON does not refund SELFDESTRUCT Energy')
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
    assert.equal(result.execResult.executionGasUsed, 30003n, 'Should charge new account gas')
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

describe('TRON SELFDESTRUCT existing beneficiary transfer', () => {
  it('transfers TRX without charging creation for an existing empty beneficiary', async () => {
    const common = new Common({ chain: TronMainnet })
    const source = createAddressFromString('0x1000000000000000000000000000000000000001')
    const beneficiary = createAddressFromString('0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead')
    const tvm = await createTVM({ common })
    await tvm.stateManager.putAccount(beneficiary, new Account())
    await tvm.stateManager.putAccount(source, new Account(0n, 1000n))
    await tvm.stateManager.putCode(source, hexToBytes(`0x73${beneficiary.toString().slice(2)}ff`))
    const result = await tvm.runCall({ to: source, gasLimit: 50000n })
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(result.execResult.executionGasUsed, 5003n)
    assert.strictEqual((await tvm.stateManager.getAccount(beneficiary))!.balance, 1000n)
    assert.strictEqual((await tvm.stateManager.getAccount(source))!.balance, 0n)
  })
})

describe('TRON SELFDESTRUCT Energy balance matrix', () => {
  for (const trx of [0n, 100n]) {
    for (const tokens of [0n, 100n]) {
      for (const exists of [false, true]) {
        it(`TRX=${trx}, tokens=${tokens}, beneficiary exists=${exists}`, async () => {
          const source = createAddressFromString('0x1000000000000000000000000000000000000001')
          const beneficiary = createAddressFromString('0x2000000000000000000000000000000000000002')
          const tokenId = MIN_TOKEN_ID + 1n
          const tvm = await createTVM()
          const account = new Account(0n, trx)
          account.asset = { [Number(tokenId)]: tokens }
          await tvm.stateManager.putAccount(source, account)
          await tvm.stateManager.putCode(
            source,
            hexToBytes(`0x73${beneficiary.toString().slice(2)}ff`),
          )
          if (exists) await tvm.stateManager.putAccount(beneficiary, new Account())
          const result = await tvm.runCall({ to: source, gasLimit: 40000n })
          assert.isUndefined(result.execResult.exceptionError)
          assert.strictEqual(result.execResult.executionGasUsed, exists ? 5003n : 30003n)
          assert.strictEqual(result.execResult.gasRefund, 0n)
          assert.strictEqual((await tvm.stateManager.getAccount(beneficiary))!.balance, trx)
          assert.strictEqual(
            (await tvm.stateManager.getAccount(beneficiary))!.getTokenBalance(tokenId),
            tokens,
          )
        })
      }
    }
  }

  it('does not charge creation or refund Energy when the beneficiary is self', async () => {
    const source = createAddressFromString('0x1000000000000000000000000000000000000001')
    const tvm = await createTVM()
    const account = new Account(0n, 100n)
    account.asset = { [Number(MIN_TOKEN_ID + 1n)]: 100n }
    await tvm.stateManager.putAccount(source, account)
    await tvm.stateManager.putCode(source, hexToBytes(`0x73${source.toString().slice(2)}ff`))
    const result = await tvm.runCall({ to: source, gasLimit: 10000n })
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(result.execResult.executionGasUsed, 5003n)
    assert.strictEqual(result.execResult.gasRefund, 0n)
    assert.strictEqual((await tvm.stateManager.getAccount(source))!.balance, 100n)
    assert.strictEqual(
      (await tvm.stateManager.getAccount(source))!.getTokenBalance(MIN_TOKEN_ID + 1n),
      100n,
    )
  })
})
