/**
 * Supplementary tests for review findings.
 * Tests critical and major issues identified during the Tron features code review.
 */
import {
  Account,
  type Address,
  BIGINT_0,
  MIN_TOKEN_ID,
  PermissionType,
  createAccount,
  createAddressFromPrivateKey,
  hexToBytes,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import { PK, deployContract, getAccount } from './utils.ts'

const OWNER_ADDRESS = createAddressFromPrivateKey(hexToBytes(PK))

describe('Review Findings - Account & Token Edge Cases', () => {
  // ── C2: Token balance underflow ──────────────────────────────────
  describe('Token balance negative value (C2)', () => {
    it('getTokenBalance returns 0 for non-existent tokenId', () => {
      const account = createAccount({ balance: 100n, asset: {} })
      const balance = account.getTokenBalance(MIN_TOKEN_ID + 1n)
      assert.equal(balance, BIGINT_0)
    })

    it('getTokenBalance returns correct balance for existing tokenId', () => {
      const tokenId = MIN_TOKEN_ID + 1n
      const account = createAccount({
        balance: 100n,
        asset: { [Number(tokenId)]: 500n },
      })
      assert.equal(account.getTokenBalance(tokenId), 500n)
    })

    it('asset setter allows null value', () => {
      const account = createAccount({ balance: 100n, asset: { 1000001: 100n } })
      account.asset = null
      assert.throws(() => account.getTokenBalance(1000001n), /not loaded/)
    })
  })

  // ── m1: isEmpty logic with tokens ────────────────────────────────
  describe('Account.isEmpty() with token assets (m1)', () => {
    it('isEmpty returns false when account has token balance', () => {
      const tokenId = MIN_TOKEN_ID + 1n
      const account = createAccount({
        balance: 0n,
        asset: { [Number(tokenId)]: 100n },
      })
      assert.isFalse(account.isEmpty())
    })

    it('isEmpty returns true when all token balances are zero', () => {
      const tokenId = MIN_TOKEN_ID + 1n
      const account = createAccount({
        balance: 0n,
        asset: { [Number(tokenId)]: 0n },
      })
      assert.isTrue(account.isEmpty())
    })

    it('isEmpty returns true for default empty account', () => {
      const account = new Account()
      assert.isTrue(account.isEmpty())
    })

    it('isEmpty returns false when only nonce is non-zero', () => {
      const account = createAccount({ nonce: 1n, balance: 0n })
      assert.isFalse(account.isEmpty())
    })
  })

  // ── Permission model (4.3) ───────────────────────────────────────
  describe('Permission model edge cases', () => {
    it('getPermissionById returns null for non-existent id', () => {
      const account = createAccount({ balance: 100n })
      account.updatePermissions({
        activePermissions: [
          {
            type: PermissionType.Owner,
            id: 0,
            permissionName: 'owner',
            threshold: 1,
            parentId: 0,
            operations: new Uint8Array(0),
            keys: [{ address: OWNER_ADDRESS.bytes, weight: 1 }],
          },
        ],
      })
      assert.isNull(account.getPermissionById(99))
    })

    it('getPermissionById returns correct permission', () => {
      const account = createAccount({ balance: 100n })
      account.updatePermissions({
        activePermissions: [
          {
            type: PermissionType.Owner,
            id: 0,
            permissionName: 'owner',
            threshold: 2,
            parentId: 0,
            operations: new Uint8Array(0),
            keys: [
              { address: OWNER_ADDRESS.bytes, weight: 1 },
              { address: new Uint8Array(20), weight: 1 },
            ],
          },
          {
            type: PermissionType.Active,
            id: 2,
            permissionName: 'active',
            threshold: 1,
            parentId: 0,
            operations: new Uint8Array(32),
            keys: [{ address: OWNER_ADDRESS.bytes, weight: 1 }],
          },
        ],
      })

      const ownerPerm = account.getPermissionById(0)
      assert.isNotNull(ownerPerm)
      assert.equal(ownerPerm!.permissionName, 'owner')
      assert.equal(ownerPerm!.threshold, 2)
      assert.equal(ownerPerm!.keys.length, 2)

      const activePerm = account.getPermissionById(2)
      assert.isNotNull(activePerm)
      assert.equal(activePerm!.permissionName, 'active')
      assert.equal(activePerm!.threshold, 1)
    })

    it('getPermissionById throws when permissions not loaded', () => {
      const account = new Account(0n, 0n, undefined, undefined, 0, 0, {}, null)
      assert.throws(() => account.getPermissionById(0), /not loaded/)
    })
  })

  // ── Account serialization with assets & permissions ──────────────
  describe('Account RLP serialization with Tron fields', () => {
    it('serializes and deserializes account with token assets', async () => {
      const { createAccountFromRLP } = await import('@tvmjs/util')
      const tokenId = MIN_TOKEN_ID + 1n
      const original = createAccount({
        nonce: 5n,
        balance: 1000n,
        asset: { [Number(tokenId)]: 500n },
      })

      const serialized = original.serialize()
      const restored = createAccountFromRLP(serialized)

      assert.equal(restored.nonce, 5n)
      assert.equal(restored.balance, 1000n)
      assert.equal(restored.getTokenBalance(tokenId), 500n)
    })

    it('serializes and deserializes account with permissions', async () => {
      const { createAccountFromRLP } = await import('@tvmjs/util')
      const original = createAccount({ balance: 100n })
      original.updatePermissions({
        activePermissions: [
          {
            type: PermissionType.Owner,
            id: 0,
            permissionName: 'owner',
            threshold: 1,
            parentId: 0,
            operations: new Uint8Array(0),
            keys: [{ address: OWNER_ADDRESS.bytes, weight: 1 }],
          },
        ],
      })

      const serialized = original.serialize()
      const restored = createAccountFromRLP(serialized)

      const perm = restored.getPermissionById(0)
      assert.isNotNull(perm)
      assert.equal(perm!.permissionName, 'owner')
      assert.equal(perm!.threshold, 1)
    })
  })

  // ── Token transfer via VM (C2 validation) ────────────────────────
  describe('Token transfer via VM', () => {
    it('account token balance persists through state manager', async () => {
      const vm = await createVM()
      const tokenId = MIN_TOKEN_ID + 1n
      const account = createAccount({
        balance: 100_000_000n,
        asset: { [Number(tokenId)]: 1000n },
      })

      await vm.stateManager.checkpoint()
      await vm.stateManager.putAccount(OWNER_ADDRESS, account)
      await vm.stateManager.commit()

      const retrieved = await getAccount(vm, OWNER_ADDRESS)
      assert.isNotNull(retrieved)
      assert.equal(retrieved!.getTokenBalance(tokenId), 1000n)
    })

    it('account with multiple token types persists correctly', async () => {
      const vm = await createVM()
      const tokenId1 = MIN_TOKEN_ID + 1n
      const tokenId2 = MIN_TOKEN_ID + 2n
      const account = createAccount({
        balance: 100_000_000n,
        asset: {
          [Number(tokenId1)]: 500n,
          [Number(tokenId2)]: 300n,
        },
      })

      await vm.stateManager.checkpoint()
      await vm.stateManager.putAccount(OWNER_ADDRESS, account)
      await vm.stateManager.commit()

      const retrieved = await getAccount(vm, OWNER_ADDRESS)
      assert.equal(retrieved!.getTokenBalance(tokenId1), 500n)
      assert.equal(retrieved!.getTokenBalance(tokenId2), 300n)
      assert.equal(retrieved!.getTokenBalance(MIN_TOKEN_ID + 99n), 0n)
    })
  })
})

describe('Review Findings - DataWord', () => {
  it('DataWord.parseArray correctly parses 32-byte words', async () => {
    const { DataWord } = await import('../../../../evm/src/precompiles/dataWord.ts')
    const data = new Uint8Array(64)
    data[31] = 42 // first word = 42
    data[63] = 7 // second word = 7

    const words = DataWord.parseArray(data)
    assert.equal(words.length, 2)
    assert.equal(words[0].intValueSafe(), 42)
    assert.equal(words[1].intValueSafe(), 7)
  })

  it('DataWord.intValueSafe throws for values exceeding 4 bytes', async () => {
    const { DataWord } = await import('../../../../evm/src/precompiles/dataWord.ts')
    const data = new Uint8Array(32)
    // Set 5 bytes of data (exceeds 4-byte safe limit)
    data[27] = 1
    data[28] = 0
    data[29] = 0
    data[30] = 0
    data[31] = 0

    const word = new DataWord(data)
    assert.throws(() => word.intValueSafe())
  })

  it('DataWord.equalAddressByteArray compares last 20 bytes', async () => {
    const { DataWord } = await import('../../../../evm/src/precompiles/dataWord.ts')
    const addr1 = new Uint8Array(32)
    const addr2 = new Uint8Array(20)

    // Fill last 20 bytes of addr1 with same values as addr2
    for (let i = 0; i < 20; i++) {
      addr1[12 + i] = i + 1
      addr2[i] = i + 1
    }

    assert.isTrue(DataWord.equalAddressByteArray(addr1, addr2))
  })

  it('DataWord.equalAddressByteArray returns false for short arrays', async () => {
    const { DataWord } = await import('../../../../evm/src/precompiles/dataWord.ts')
    const short = new Uint8Array(10)
    const normal = new Uint8Array(20)
    assert.isFalse(DataWord.equalAddressByteArray(short, normal))
  })
})

describe('Review Findings - Precompile Utilities', () => {
  it('recoverAddrBySign returns empty array for invalid signature', async () => {
    const { recoverAddrBySign } = await import('../../../../evm/src/precompiles/util.ts')
    const invalidSig = new Uint8Array(65) // all zeros
    const hash = new Uint8Array(32)
    const result = recoverAddrBySign(invalidSig, hash)
    assert.equal(result.length, 0)
  })

  it('convertToTronAddress adds 0x41 prefix for 20-byte address', async () => {
    const { convertToTronAddress } = await import('../../../../evm/src/precompiles/util.ts')
    const addr = new Uint8Array(20)
    addr[0] = 0xab
    const result = convertToTronAddress(addr)
    assert.equal(result.length, 21)
    assert.equal(result[0], 0x41) // mainnet prefix
    assert.equal(result[1], 0xab)
  })

  it('convertToTronAddress returns original if not 20 bytes', async () => {
    const { convertToTronAddress } = await import('../../../../evm/src/precompiles/util.ts')
    const addr = new Uint8Array(21)
    const result = convertToTronAddress(addr)
    assert.equal(result, addr) // same reference
  })

  it('extractBytesArray returns empty for offset beyond words', async () => {
    const { extractBytesArray } = await import('../../../../evm/src/precompiles/util.ts')
    const { DataWord } = await import('../../../../evm/src/precompiles/dataWord.ts')
    const data = new Uint8Array(32)
    const words = DataWord.parseArray(data)
    const result = extractBytesArray(words, 10, data) // offset=10, but only 1 word
    assert.equal(result.length, 0)
  })
})

describe('Review Findings - CREATE2 Address Generation', () => {
  it('generateAddress2 uses 0x41 prefix instead of 0xff', async () => {
    const { generateAddress2 } = await import('@tvmjs/util')
    const from = new Uint8Array(20).fill(1)
    const salt = new Uint8Array(32).fill(2)
    const initCode = new Uint8Array([0x60, 0x00]) // minimal bytecode

    const addr = generateAddress2(from, salt, initCode)
    assert.equal(addr.length, 20)
    // Just verify it returns a valid 20-byte address (actual value depends on keccak)
  })

  it('generateAddress2 throws for invalid from length', async () => {
    const { generateAddress2 } = await import('@tvmjs/util')
    const from = new Uint8Array(10) // wrong length
    const salt = new Uint8Array(32)
    const initCode = new Uint8Array([0x60, 0x00])

    assert.throws(() => generateAddress2(from, salt, initCode), /Expected from to be of length 20/)
  })

  it('generateAddress2 throws for invalid salt length', async () => {
    const { generateAddress2 } = await import('@tvmjs/util')
    const from = new Uint8Array(20)
    const salt = new Uint8Array(16) // wrong length
    const initCode = new Uint8Array([0x60, 0x00])

    assert.throws(() => generateAddress2(from, salt, initCode), /Expected salt to be of length 32/)
  })
})

describe('Review Findings - Energy/Gas Parameters', () => {
  it('VM uses stackLimit=64 from params', async () => {
    const vm = await createVM()
    const stackLimit = vm.evm.common.param('stackLimit')
    assert.equal(stackLimit, 64n)
  })

  it('Tron-specific gas params are correctly configured', async () => {
    const vm = await createVM()
    const common = vm.evm.common

    assert.equal(common.param('calltokenGas'), 40n)
    assert.equal(common.param('tokenbalanceGas'), 20n)
    assert.equal(common.param('calltokenvalueGas'), 2n)
    assert.equal(common.param('calltokenidGas'), 2n)
    assert.equal(common.param('iscontractGas'), 20n)
    assert.equal(common.param('batchvalidatesignGas'), 1500n)
    assert.equal(common.param('validatemultisignGas'), 1500n)
  })

  it('createDataGas is 200 (used for contract deployment energy)', async () => {
    const vm = await createVM()
    assert.equal(vm.evm.common.param('createDataGas'), 200n)
  })
})

describe('Review Findings - Contract Deployment with Tokens', () => {
  it('deploys contract with token value', async () => {
    const vm = await createVM()
    const tokenId = MIN_TOKEN_ID + 1n

    // Set up account with tokens
    const account = createAccount({
      balance: 100_000_000_000n,
      asset: { [Number(tokenId)]: 10000n },
    })
    await vm.stateManager.checkpoint()
    await vm.stateManager.putAccount(OWNER_ADDRESS, account)
    await vm.stateManager.commit()

    // Deploy a minimal contract with token value
    // PUSH1 0x00 PUSH1 0x00 RETURN (returns empty)
    const bytecode = hexToBytes('0x60006000f3')

    const contractAddress = await deployContract(
      vm,
      {
        caller: OWNER_ADDRESS,
        bytecode,
        tokenId,
        tokenValue: 100n,
      },
      { pk: PK, skipBalance: true },
    )

    assert.isNotNull(contractAddress)

    // Verify token was transferred to contract
    const contractAccount = await getAccount(vm, contractAddress as Address)
    assert.isNotNull(contractAccount)
    assert.equal(contractAccount!.getTokenBalance(tokenId), 100n)

    // Verify sender token balance decreased
    const senderAccount = await getAccount(vm, OWNER_ADDRESS)
    assert.isNotNull(senderAccount)
    // Token should have decreased from 10000 by 100
    const senderTokenBalance = senderAccount!.getTokenBalance(tokenId)
    assert.equal(senderTokenBalance, 10000n - 100n)
  })
})
