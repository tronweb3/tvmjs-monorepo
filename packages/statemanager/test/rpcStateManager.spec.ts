import { createBlockFromJSONRPCProvider } from '@tvmjs/block'
import { verifyMerkleProof } from '@tvmjs/mpt'
import { createTVM } from '@tvmjs/tvm'
import type { TVMRunCallOpts } from '@tvmjs/tvm'
import {
  Address,
  bigIntToBytes,
  bytesToHex,
  bytesToUnprefixedHex,
  createAccountFromRLP,
  createAddressFromString,
  equalsBytes,
  hexToBytes,
  setLengthLeft,
  utf8ToBytes,
} from '@tvmjs/util'
import { assert, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MerkleStateManager } from '../src/merkleStateManager.ts'
import { getRPCStateProof } from '../src/proof/index.ts'
import { RPCBlockChain, RPCStateManager } from '../src/rpcStateManager.ts'

import { mockRPC, provider } from './rpcHelpers.ts'
import { getValues } from './testdata/providerData/mockProvider.ts'
import type { SupportedMethods } from './testdata/providerData/mockProvider.ts'
// Fixed historical RPC fixtures exercise the data adapter, not Ethereum execution.
beforeEach(() => {
  mockRPC(async ({ method, params }) => {
    const response = await getValues(method as SupportedMethods, 1, params)
    return response.result
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RPC State Manager initialization tests', () => {
  it('should work', () => {
    let state = new RPCStateManager({ provider, blockTag: 1n })
    assert.instanceOf(state, RPCStateManager, 'was able to instantiate state manager')
    assert.strictEqual(
      state['_blockTag'],
      '0x1',
      'State manager starts with default block tag of 1',
    )

    state = new RPCStateManager({ provider, blockTag: 1n })
    assert.strictEqual(
      state['_blockTag'],
      '0x1',
      'State Manager instantiated with predefined blocktag',
    )

    state = new RPCStateManager({ provider: 'https://google.com', blockTag: 1n })
    assert.instanceOf(
      state,
      RPCStateManager,
      'was able to instantiate state manager with valid url',
    )

    const invalidProvider = 'google.com'
    assert.throws(
      () => new RPCStateManager({ provider: invalidProvider, blockTag: 1n }),
      undefined,
      undefined,
      'cannot instantiate state manager with invalid provider',
    )
  })
})

describe('RPC State Manager API tests', () => {
  it('should work', async () => {
    const state = new RPCStateManager({ provider, blockTag: 1n })
    const vitalikDotEth = createAddressFromString('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
    const account = await state.getAccount(vitalikDotEth)

    assert.isTrue(account!.nonce > 0n, 'Vitalik.eth returned a valid nonce')

    await state.putAccount(vitalikDotEth, account!)

    const retrievedVitalikAccount = createAccountFromRLP(
      state['_caches'].account!.get(vitalikDotEth)!.accountRLP!,
    )

    assert.isTrue(retrievedVitalikAccount.nonce > 0n, 'Vitalik.eth is stored in cache')
    const address = createAddressFromString('0xccAfdD642118E5536024675e776d32413728DD07')
    const proof = await getRPCStateProof(state, address)
    const proofBuf = proof.accountProof.map((proofNode) => hexToBytes(proofNode))
    const doesThisAccountExist = await verifyMerkleProof(address.bytes, proofBuf, {
      useKeyHashing: true,
    })
    assert.isNull(doesThisAccountExist, 'getAccount returns undefined for non-existent account')

    assert.isDefined(await state.getAccount(vitalikDotEth), 'vitalik.eth does exist')

    const UniswapERC20ContractAddress = createAddressFromString(
      '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    )
    const UNIContractCode = await state.getCode(UniswapERC20ContractAddress)
    assert.isNotEmpty(UNIContractCode, 'was able to retrieve UNI contract code')

    await state.putCode(UniswapERC20ContractAddress, UNIContractCode)
    assert.isDefined(
      state['_caches'].code?.get(UniswapERC20ContractAddress),
      'UNI ERC20 contract code was found in cache',
    )

    const storageSlot = await state.getStorage(
      UniswapERC20ContractAddress,
      setLengthLeft(bigIntToBytes(1n), 32),
    )
    assert.isNotEmpty(storageSlot, 'was able to retrieve storage slot 1 for the UNI contract')

    await expect(async () => {
      await state.getStorage(UniswapERC20ContractAddress, setLengthLeft(bigIntToBytes(1n), 31))
    }).rejects.toThrowError('Storage key must be 32 bytes long')

    await state.putStorage(
      UniswapERC20ContractAddress,
      setLengthLeft(bigIntToBytes(2n), 32),
      utf8ToBytes('abcd'),
    )
    const slotValue = await state.getStorage(
      UniswapERC20ContractAddress,
      setLengthLeft(bigIntToBytes(2n), 32),
    )
    assert.isTrue(equalsBytes(slotValue, utf8ToBytes('abcd')), 'should retrieve slot 2 value')

    const dumpedStorage = await state.dumpStorage(UniswapERC20ContractAddress)
    assert.deepEqual(dumpedStorage, {
      [bytesToUnprefixedHex(setLengthLeft(bigIntToBytes(1n), 32))]: '0xabcd',
      [bytesToUnprefixedHex(setLengthLeft(bigIntToBytes(2n), 32))]: bytesToHex(utf8ToBytes('abcd')),
    })

    const spy = vi.spyOn(state, 'getAccountFromProvider')
    spy.mockImplementation(() => {
      throw new Error("shouldn't call me")
    })

    await state.checkpoint()

    await state.putStorage(
      UniswapERC20ContractAddress,
      setLengthLeft(bigIntToBytes(2n), 32),
      new Uint8Array(0),
    )

    await state.modifyAccountFields(vitalikDotEth, { nonce: 39n })
    assert.strictEqual(
      (await state.getAccount(vitalikDotEth))?.nonce,
      39n,
      'modified account fields successfully',
    )

    await expect(state.getAccount(vitalikDotEth)).resolves.toBeDefined()
    await expect(
      state.getAccount(createAddressFromString('0x9Cef824A8f4b3Dc6B7389933E52e47F010488Fc8')),
    ).rejects.toThrow("shouldn't call me")

    const deletedSlot = await state.getStorage(
      UniswapERC20ContractAddress,
      setLengthLeft(bigIntToBytes(2n), 32),
    )

    assert.strictEqual(deletedSlot.length, 0, 'deleted slot from storage cache')

    await state.deleteAccount(vitalikDotEth)
    assert.isUndefined(
      await state.getAccount(vitalikDotEth),
      'account should not exist after being deleted',
    )

    await state.revert()
    assert.isDefined(
      await state.getAccount(vitalikDotEth),
      'account deleted since last checkpoint should exist after revert called',
    )

    const deletedSlotAfterRevert = await state.getStorage(
      UniswapERC20ContractAddress,
      setLengthLeft(bigIntToBytes(2n), 32),
    )

    assert.strictEqual(
      deletedSlotAfterRevert.length,
      4,
      'slot deleted since last checkpoint should exist in storage cache after revert',
    )

    const cacheStorage = await state.dumpStorage(UniswapERC20ContractAddress)
    assert.strictEqual(
      2,
      Object.keys(cacheStorage).length,
      'should have 2 storage slots in cache before clear',
    )
    await state.clearStorage(UniswapERC20ContractAddress)
    const clearedStorage = await state.dumpStorage(UniswapERC20ContractAddress)
    assert.deepEqual({}, clearedStorage, 'storage cache should be empty after clear')

    await expect(createBlockFromJSONRPCProvider(provider, 'fakeBlockTag', {})).rejects.toThrow(
      'expected blockTag to be block hash, bigint, hex prefixed string',
    )

    assert.strictEqual(
      state['_caches'].account?.get(UniswapERC20ContractAddress),
      undefined,
      'should not retain an account cache entry loaded after the checkpoint',
    )

    assert.strictEqual(state['_blockTag'], '0x1', 'blockTag defaults to 1')
    state.setBlockTag(5n)
    assert.strictEqual(state['_blockTag'], '0x5', 'blockTag set to 0x5')
    state.setBlockTag('earliest')
    assert.strictEqual(state['_blockTag'], 'earliest', 'blockTag set to earliest')
  })
})

describe('blockchain', () =>
  it('uses blockhash', async () => {
    const blockchain = new RPCBlockChain(provider)
    const blockTag = 1n
    const state = new RPCStateManager({ provider, blockTag })
    const tvm = await createTVM({ blockchain, stateManager: state })
    // Bytecode for returning the blockhash of the block previous to `blockTag`
    const code = '0x600143034060005260206000F3'
    const contractAddress = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))

    const caller = createAddressFromString('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
    await tvm.stateManager.setStateRoot(
      hexToBytes('0xf8506f559699a58a4724df4fcf2ad4fd242d20324db541823f128f5974feb6c7'),
    )
    const block = await createBlockFromJSONRPCProvider(provider, 500000n, { setHardfork: true })
    await tvm.stateManager.putCode(contractAddress, hexToBytes(code))
    const runCallArgs: Partial<TVMRunCallOpts> = {
      caller,
      gasLimit: BigInt(0xffffffffff),
      to: contractAddress,
      block,
    }
    const res = await tvm.runCall(runCallArgs)
    assert.strictEqual(
      bytesToHex(res.execResult.returnValue),
      '0x794a1bef434928ce3aadd2f5eced2bf72ac714a30e9e4ab5965d7d9760300d84',
    )
  }))

describe('RPC blockchain writes', () => {
  it('rejects block writes without sending a provider request', async () => {
    const blockchain = new RPCBlockChain(provider)
    await expect(blockchain.putBlock({})).rejects.toThrow('RPCBlockChain is read-only')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Should return same value as MerkleStateManager when account does not exist', () => {
  it('should work', async () => {
    const rpcState = new RPCStateManager({ provider, blockTag: 1n })
    const defaultState = new MerkleStateManager()

    const account0 = await rpcState.getAccount(new Address(hexToBytes(`0x${'01'.repeat(20)}`)))
    const account1 = await defaultState.getAccount(new Address(hexToBytes(`0x${'01'.repeat(20)}`)))
    assert.strictEqual(
      account0,
      account1,
      'Should return same value as MerkleStateManager when account does not exist',
    )
  })
})
