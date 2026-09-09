import { Account, Address, hexToBytes, utf8ToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { MerkleStateManager } from '../src/index.ts'

function createAccount(nonce = BigInt(0), balance = BigInt(0xfff384)) {
  return new Account(nonce, balance)
}

describe('Original storage cache', () => {
  it('should initially have empty storage value', async () => {
    const stateManager = new MerkleStateManager()
    const address = new Address(hexToBytes('0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b'))
    const account = createAccount()
    await stateManager.putAccount(address, account)

    const key = hexToBytes('0x1234567890123456789012345678901234567890123456789012345678901234')

    await stateManager.checkpoint()
    const res = await stateManager.getStorage(address, key)
    assert.deepEqual(res, new Uint8Array(0))

    const origRes = await stateManager.originalStorageCache.get(address, key)
    assert.deepEqual(origRes, new Uint8Array(0))

    await stateManager.commit()
  })

  it('should set and get original storage value', async () => {
    const stateManager = new MerkleStateManager()
    const address = new Address(hexToBytes('0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b'))
    const account = createAccount()
    await stateManager.putAccount(address, account)

    const key = hexToBytes('0x1234567890123456789012345678901234567890123456789012345678901234')
    const value = hexToBytes('0x1234')

    await stateManager.putStorage(address, key, value)
    const res = await stateManager.getStorage(address, key)
    assert.deepEqual(res, value)

    const origRes = await stateManager.originalStorageCache.get(address, key)
    assert.deepEqual(origRes, value)
  })

  it('should return correct original value after modification', async () => {
    const stateManager = new MerkleStateManager()
    const address = new Address(hexToBytes('0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b'))
    const account = createAccount()
    await stateManager.putAccount(address, account)

    const key = hexToBytes('0x1234567890123456789012345678901234567890123456789012345678901234')
    const value = hexToBytes('0x1234')
    const newValue = hexToBytes('0x1235')

    // Set initial value
    await stateManager.putStorage(address, key, value)

    // First call to originalStorageCache.get() caches current value
    const origRes1 = await stateManager.originalStorageCache.get(address, key)
    assert.deepEqual(origRes1, value, 'original value should be cached on first get')

    // Modify storage
    await stateManager.putStorage(address, key, newValue)

    // Current value changed
    const res = await stateManager.getStorage(address, key)
    assert.deepEqual(res, newValue, 'current value should be newValue')

    // Original cache still returns the cached value (not updated by putStorage)
    const origRes2 = await stateManager.originalStorageCache.get(address, key)
    assert.deepEqual(origRes2, value, 'original value should remain cached')
  })

  it('should cache keys separately', async () => {
    const stateManager = new MerkleStateManager()
    const address = new Address(hexToBytes('0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b'))
    const account = createAccount()
    await stateManager.putAccount(address, account)

    const key = hexToBytes('0x1234567890123456789012345678901234567890123456789012345678901234')
    const value = hexToBytes('0x1234')
    const key2 = hexToBytes('0x0000000000000000000000000000000000000000000000000000000000000012')
    const value2 = utf8ToBytes('12')
    const value3 = utf8ToBytes('123')

    await stateManager.putStorage(address, key, value)
    await stateManager.putStorage(address, key2, value2)

    let res = await stateManager.getStorage(address, key2)
    assert.deepEqual(res, value2)
    let origRes = await stateManager.originalStorageCache.get(address, key2)
    assert.deepEqual(origRes, value2)

    await stateManager.putStorage(address, key2, value3)

    res = await stateManager.getStorage(address, key2)
    assert.deepEqual(res, value3)
    origRes = await stateManager.originalStorageCache.get(address, key2)
    assert.deepEqual(origRes, value2)

    // Check previous key is unaffected
    res = await stateManager.getStorage(address, key)
    assert.deepEqual(res, value)
    origRes = await stateManager.originalStorageCache.get(address, key)
    assert.deepEqual(origRes, value)
  })

  it("should validate the key's length", async () => {
    const stateManager = new MerkleStateManager()
    const address = new Address(hexToBytes('0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b'))
    const account = createAccount()
    await stateManager.putAccount(address, account)

    try {
      await stateManager.originalStorageCache.get(address, new Uint8Array(12))
      assert.fail('Should have thrown')
    } catch (e: any) {
      assert.strictEqual(e.message, 'Storage key must be 32 bytes long')
    }
  })
})
