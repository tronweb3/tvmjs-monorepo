import { bytesToBigInt, bytesToHex, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { parseTronAddress, toTronHex } from '../../src/dialect/tron/address.ts'
import { genDeployAddress } from '../../src/dialect/tron/wallet/contractAdapter.ts'
import { TronNode } from '../../src/node.ts'

// hand-assembled "increment" contract:
//   runtime: sstore(0, sload(0)+1); return the new value (any calldata)
//   600054 600101 80 600055 600052 60206000f3
const INC_RUNTIME = '0x6000546001018060005560005260206000f3'
// initcode: codecopy(0, 0x0b, 0x12); return(0, 0x12)
const INC_INITCODE = `0x601280600b6000396000f3${INC_RUNTIME.slice(2)}` as const

describe('write path core', () => {
  it('execute deploys at the TRON-derived address (client-side deploy, no tvm change)', async () => {
    const config = resolveConfig()
    const node = await TronNode.create(config)
    // a prefunded account: energy is bought with balance, so a broke sender
    // cannot deploy at all
    const owner = parseTronAddress(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[0].privateKey) as string,
    )
    const fakeTxID = 'ab'.repeat(32)
    const deployAddress = genDeployAddress(toTronHex(owner), fakeTxID)

    const result = await nodeCore(node).execute({
      caller: owner,
      to: owner, // ignored on the create path
      create: true,
      deployAddress,
      rootTransactionId: hexToBytes(`0x${fakeTxID}`),
      data: hexToBytes(INC_INITCODE),
      energyLimit: 10_000_000n,
    })

    assert.isFalse(result.reverted)
    assert.isTrue(result.createdAddress?.equals(deployAddress))
    assert.strictEqual(bytesToHex(await nodeCore(node).getCode(deployAddress)), INC_RUNTIME)
  })

  it('execute runs state-changing calls and charges the energy fee', async () => {
    const config = resolveConfig()
    const node = await TronNode.create(config)
    const ownerBase58 = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const owner = parseTronAddress(ownerBase58)
    const contract = parseTronAddress(utils.accounts.generateAccount().address.base58)
    await nodeCore(node).setCode(contract, hexToBytes(INC_RUNTIME))

    const balanceBefore = await nodeCore(node).getBalance(owner)
    const first = await nodeCore(node).execute({
      caller: owner,
      to: contract,
      data: new Uint8Array(),
      energyLimit: 1_000_000n,
    })
    assert.strictEqual(bytesToBigInt(first.returnValue), 1n)
    assert.isAbove(Number(first.energyUsed), 0)
    // energy fee deducted from the sender
    const balanceAfter = await nodeCore(node).getBalance(owner)
    assert.strictEqual(balanceBefore - balanceAfter, first.energyFeeSun)
    assert.strictEqual(
      first.energyFeeSun,
      first.energyUsed * BigInt(config.chainParameters.energyFee),
    )

    const second = await nodeCore(node).execute({
      caller: owner,
      to: contract,
      data: new Uint8Array(),
      energyLimit: 1_000_000n,
    })
    assert.strictEqual(bytesToBigInt(second.returnValue), 2n)
  })

  it('genDeployAddress matches the genContractAddress formula', () => {
    // reference helper: '41' + keccak256(bytes(txID ++ owner41)).slice(2).slice(24)
    const owner41 = `41${'11'.repeat(20)}`
    const txID = 'cd'.repeat(32)
    const expected = `41${utils.ethersUtils
      .keccak256(hexToBytes(`0x${txID}${owner41}`))
      .slice(2)
      .slice(24)}`
    assert.strictEqual(toTronHex(genDeployAddress(owner41, txID)), expected)
  })

  it('the energy budget is bounded by the balance, not settled against it after', async () => {
    const config = resolveConfig()
    const node = await TronNode.create(config)
    const poor = parseTronAddress(utils.accounts.generateAccount().address.base58)
    const store = parseTronAddress(utils.accounts.generateAccount().address.base58)
    await nodeCore(node).setCode(store, hexToBytes('0x600160005560006000f3')) // sstore(0, 1)
    await nodeCore(node).setBalance(poor, 1n)

    const result = await nodeCore(node).execute({
      caller: poor,
      to: store,
      data: new Uint8Array(),
      energyLimit: 10_000_000n,
    })

    // 1 sun buys no energy at all, so nothing runs and nothing is stored
    assert.isTrue(result.reverted)
    assert.strictEqual(await nodeCore(node).getBalance(poor), 1n)
    const slot0 = await nodeCore(node).stateManager.getStorage(
      store,
      hexToBytes(`0x${'00'.repeat(32)}`),
    )
    assert.strictEqual(bytesToBigInt(slot0), 0n)
  })

  it('a deploy that cannot pay the code deposit stores neither code nor account', async () => {
    const config = resolveConfig()
    const node = await TronNode.create(config)
    const owner = parseTronAddress(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[0].privateKey) as string,
    )
    const rootTransactionId = 'ef'.repeat(32)
    const deployAddress = genDeployAddress(toTronHex(owner), rootTransactionId)

    // enough for the constructor, not for 200 energy per runtime byte
    const result = await nodeCore(node).execute({
      caller: owner,
      to: owner,
      create: true,
      deployAddress,
      rootTransactionId: hexToBytes(`0x${rootTransactionId}`),
      data: hexToBytes(INC_INITCODE),
      energyLimit: 100n,
    })

    assert.isTrue(result.reverted)
    assert.isTrue(result.createdAddress?.equals(deployAddress))
    assert.strictEqual((await nodeCore(node).getCode(deployAddress)).length, 0)
    assert.isUndefined(await nodeCore(node).getAccount(deployAddress))
  })

  it('rejects an EIP-3541 runtime-code prefix before it reaches chain state', async () => {
    const config = resolveConfig()
    const node = await TronNode.create(config)
    const owner = parseTronAddress(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[0].privateKey) as string,
    )
    const rootTransactionId = 'fe'.repeat(32)
    const deployAddress = genDeployAddress(toTronHex(owner), rootTransactionId)

    // constructor: store one byte (0xef) at memory[0], then return it as runtime code
    const result = await nodeCore(node).execute({
      caller: owner,
      create: true,
      deployAddress,
      rootTransactionId: hexToBytes(`0x${rootTransactionId}`),
      data: hexToBytes('0x60ef60005360016000f3'),
      energyLimit: 10_000_000n,
    })

    assert.isTrue(result.reverted)
    assert.isTrue(result.createdAddress?.equals(deployAddress))
    assert.strictEqual((await nodeCore(node).getCode(deployAddress)).length, 0)
    assert.isUndefined(await nodeCore(node).getAccount(deployAddress))
  })
})
