import { BinaryTreeAccessedStateType, Common, TronMainnet } from '@tvmjs/common'
import { Account, Address, setLengthLeft } from '@tvmjs/util'
import { describe, expect, it } from 'vitest'

import { Caches, MerkleStateManager, StatefulBinaryTreeStateManager } from '../src/index.ts'

describe('StateManager Coverage Boost', () => {
  const common = new Common({ chain: TronMainnet })
  const address1 = new Address(new Uint8Array(20).fill(1))
  const address2 = new Address(new Uint8Array(20).fill(2))

  it('covers StatefulBinaryTreeStateManager constructor options and errors', () => {
    const disabledCommon = {
      isActivatedEIP: (_eip: number) => false,
    } as any
    expect(() => new StatefulBinaryTreeStateManager({ common: disabledCommon })).toThrow(
      'EIP-7864 required for binary tree state management',
    )

    const enabledCommon = {
      isActivatedEIP: (eip: number) => eip === 7864,
    } as any
    const sm = new StatefulBinaryTreeStateManager({ common: enabledCommon })
    expect(sm).toBeDefined()
  })

  it('covers StatefulBinaryTreeStateManager account, code, storage and caches', async () => {
    const caches = new Caches()
    const sm = new StatefulBinaryTreeStateManager({ caches })

    // Account lifecycle
    expect(await sm.getAccount(address1)).toBeUndefined()

    const acc = new Account(0n, 1000n)
    await sm.putAccount(address1, acc)
    const fetched = await sm.getAccount(address1)
    expect(fetched?.balance).toBe(1000n)

    await sm.modifyAccountFields(address1, { balance: 2000n })
    expect((await sm.getAccount(address1))?.balance).toBe(2000n)

    // Code operations
    const code = new Uint8Array([0x60, 0x01, 0x60, 0x02, 0x01])
    await sm.putCode(address1, code)
    expect(await sm.getCode(address1)).toEqual(code)

    // Storage operations
    const slot = setLengthLeft(new Uint8Array([1]), 32)
    const val = setLengthLeft(new Uint8Array([42]), 32)
    await sm.putStorage(address1, slot, val)
    const retrieved = await sm.getStorage(address1, slot)
    expect(retrieved).toEqual(val)

    // Storage key length validation
    await expect(sm.getStorage(address1, new Uint8Array(10))).rejects.toThrow(
      'Storage key must be 32 bytes long',
    )

    // Checkpointing, commit, revert
    await sm.checkpoint()
    await sm.putStorage(address1, slot, setLengthLeft(new Uint8Array([99]), 32))
    await sm.revert()

    await sm.checkpoint()
    await sm.putStorage(address1, slot, setLengthLeft(new Uint8Array([100]), 32))
    await sm.commit()

    // State root operations
    const root = await sm.getStateRoot()
    expect(root).toBeDefined()
    expect(root.length).toBe(32)
    expect(await sm.hasStateRoot(root)).toBe(true)
    await sm.setStateRoot(root, true)

    // Clear storage and delete account
    await sm.clearStorage(address1)
    await sm.deleteAccount(address1)
  })

  it('covers StatefulBinaryTreeStateManager without caches', async () => {
    const sm = new StatefulBinaryTreeStateManager({})

    const acc = new Account(1n, 500n)
    await sm.putAccount(address2, acc)
    const fetched = await sm.getAccount(address2)
    expect(fetched?.balance).toBe(500n)

    const code = new Uint8Array([0x60, 0x0a])
    await sm.putCode(address2, code)
    expect(await sm.getCode(address2)).toEqual(code)
    expect(await sm.getCodeSize(address2)).toBe(code.length)

    const slot = setLengthLeft(new Uint8Array([2]), 32)
    const val = setLengthLeft(new Uint8Array([88]), 32)
    await sm.putStorage(address2, slot, val)
    expect(await sm.getStorage(address2, slot)).toEqual(val)

    await sm.deleteAccount(address2)
    expect(await sm.getAccount(address2)).toBeUndefined()
  })

  it('covers StatefulBinaryTreeStateManager generateCanonicalGenesis', async () => {
    const sm = new StatefulBinaryTreeStateManager({})
    const genesisState: any = {
      '0x1111111111111111111111111111111111111111': '0x100',
      '0x2222222222222222222222222222222222222222': [
        '0x200', // balance
        '0x6001', // code
        [['0x01', '0x02']], // storage
        '0x5', // nonce
      ],
    }

    await sm.generateCanonicalGenesis(genesisState)
    const root = await sm.getStateRoot()
    expect(root).toBeDefined()
  })

  it('covers StatefulBinaryTreeStateManager witness and postState verification', async () => {
    const sm = new StatefulBinaryTreeStateManager({})

    expect(() => sm.initBinaryTreeExecutionWitness(1n, null)).toThrow(
      'Invalid executionWitness=null',
    )

    const witness = {
      parentStateRoot: '0x' + '00'.repeat(32),
      stateDiff: [
        {
          stem: '0x' + '11'.repeat(31),
          suffixDiffs: [
            {
              suffix: 0,
              currentValue: null,
              newValue: '0x' + '22'.repeat(32),
            },
          ],
        },
      ],
      proof: null,
    }
    sm.initBinaryTreeExecutionWitness(1n, witness as any)
    expect(sm.preStateRoot).toBeDefined()

    // getComputedValue
    const basicVal = await sm.getComputedValue({
      address: address1,
      type: BinaryTreeAccessedStateType.BasicData,
      chunkKey: '0x123',
    })
    expect(basicVal).toBeNull()

    const codeHashVal = await sm.getComputedValue({
      address: address1,
      type: BinaryTreeAccessedStateType.CodeHash,
      chunkKey: '0x124',
    })
    expect(codeHashVal).toBeNull()

    const codeVal = await sm.getComputedValue({
      address: address1,
      type: BinaryTreeAccessedStateType.Code,
      codeOffset: 0,
      chunkKey: '0x125',
    })
    expect(codeVal).toBeDefined()

    const storageVal = await sm.getComputedValue({
      address: address1,
      type: BinaryTreeAccessedStateType.Storage,
      slot: 0n,
      chunkKey: '0x126',
    })
    expect(storageVal).toBe('0x' + '00'.repeat(32))

    // verifyBinaryTreePostState with code, storage, basicData
    const chunkKey1 = '0x11'.repeat(16)
    const chunkKey2 = '0x22'.repeat(16)
    const chunkKey3 = '0x33'.repeat(16)
    const dummyAccessWitness = {
      accesses: () => [
        {
          address: address1,
          type: BinaryTreeAccessedStateType.Code,
          codeOffset: 0,
          chunkKey: chunkKey1,
        },
        {
          address: address1,
          type: BinaryTreeAccessedStateType.Storage,
          slot: 0n,
          chunkKey: chunkKey2,
        },
        {
          address: address1,
          type: BinaryTreeAccessedStateType.BasicData,
          chunkKey: chunkKey3,
        },
      ],
    } as any
    const verifyResult = await sm.verifyBinaryTreePostState(dummyAccessWitness)
    expect(typeof verifyResult).toBe('boolean')
  })

  it('covers StatefulBinaryTreeStateManager unimplemented methods', async () => {
    const sm = new StatefulBinaryTreeStateManager({})
    expect(() => sm.dumpStorage!(address1)).toThrow('Method not implemented')
    expect(() => sm.dumpStorageRange!(address1, 0n, 10)).toThrow('Method not implemented')
    expect(() => sm.shallowCopy()).toThrow('Method not implemented')
    await expect(sm.checkChunkWitnessPresent(address1, 0)).rejects.toThrow('Method not implemented')
    await expect(sm.tokenIdExists(1n)).rejects.toThrow('Method not implemented')
  })

  it('covers MerkleStateManager dumpStorageRange and generateCanonicalGenesis branches', async () => {
    const sm = new MerkleStateManager({ common })

    // dumpStorageRange error branches
    await expect(sm.dumpStorageRange(address1, 0n, -1)).rejects.toThrow(
      'Limit is not a proper uint',
    )
    await expect(sm.dumpStorageRange(address1, 0n, 10)).rejects.toThrow('Account does not exist')

    // generateCanonicalGenesis with checkpoints error
    await sm.checkpoint()
    await expect(sm.generateCanonicalGenesis({})).rejects.toThrow(
      'Cannot create genesis state with uncommitted checkpoints',
    )
    await sm.revert()

    // generateCanonicalGenesis with string and array states
    const genesisState: any = {
      '0x1111111111111111111111111111111111111111': 1000n,
      '0x2222222222222222222222222222222222222222': [
        2000n,
        new Uint8Array([0x60, 0x00]),
        [[setLengthLeft(new Uint8Array([1]), 32), new Uint8Array([2])]],
        5n,
      ],
    }
    await sm.generateCanonicalGenesis(genesisState)

    const root = await sm.getStateRoot()
    expect(await sm.hasStateRoot(root)).toBe(true)
  })
})
