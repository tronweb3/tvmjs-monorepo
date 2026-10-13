import { keccak_256 } from '@noble/hashes/sha3.js'
import { describe, expect, it, vi } from 'vitest'

import {
  Address,
  BinaryTreeLeafType,
  type PrefixedHexString,
  bigInt64ToBytes,
  bytesToBigInt64,
  bytesToInt32,
  bytesToUtf8,
  chunkifyBinaryTreeCode,
  createAccount,
  createBlockLevelAccessList,
  createPartialAccount,
  createPartialAccountFromRLP,
  decodeBinaryTreeLeafBasicData,
  encodeBinaryTreeLeafBasicData,
  equalsBytes,
  fetchFromProvider,
  generateAddress2,
  generateBinaryTreeChunkSuffixes,
  generateBinaryTreeCodeStems,
  getBinaryTreeIndicesForCodeChunk,
  getBinaryTreeIndicesForStorageSlot,
  getBinaryTreeKey,
  getBinaryTreeKeyForCodeChunk,
  getBinaryTreeKeyForStorageSlot,
  int32ToBytes,
  isNestedUint8Array,
  isValidAddress,
  isZeroAddress,
  toType,
  utf8ToBytes,
} from '../src/index.ts'

describe('Util Coverage Boost Tests', () => {
  it('covers binaryTree.ts methods and helpers', () => {
    const dummyStem = new Uint8Array(31).fill(1)
    const dummyHash = (input: Uint8Array) => keccak_256(input)
    const dummyAddr = new Address(new Uint8Array(20).fill(2))

    // getBinaryTreeKey
    const keyBasic = getBinaryTreeKey(dummyStem, BinaryTreeLeafType.BasicData)
    expect(keyBasic.length).toBe(32)
    const keyCode = getBinaryTreeKey(dummyStem, BinaryTreeLeafType.CodeHash)
    expect(keyCode.length).toBe(32)
    const keyCustom = getBinaryTreeKey(dummyStem, new Uint8Array([99]))
    expect(keyCustom.length).toBe(32)

    // getBinaryTreeIndicesForStorageSlot
    const indicesLow = getBinaryTreeIndicesForStorageSlot(10n)
    expect(indicesLow.treeIndex).toBeDefined()
    expect(indicesLow.subIndex).toBeDefined()

    const indicesHigh = getBinaryTreeIndicesForStorageSlot(1000n)
    expect(indicesHigh.treeIndex).toBeDefined()

    // getBinaryTreeKeyForStorageSlot
    const storageKey = getBinaryTreeKeyForStorageSlot(dummyAddr, 5n, dummyHash)
    expect(storageKey.length).toBe(32)

    // getBinaryTreeIndicesForCodeChunk & getBinaryTreeKeyForCodeChunk
    const chunkIndices = getBinaryTreeIndicesForCodeChunk(0)
    expect(chunkIndices.treeIndex).toBeDefined()
    const chunkKey = getBinaryTreeKeyForCodeChunk(dummyAddr, 0, dummyHash)
    expect(chunkKey.length).toBe(32)

    // chunkifyBinaryTreeCode
    const code = new Uint8Array([0x60, 0x01, 0x60, 0x02, 0x01, 0x7f, ...new Array(32).fill(0xaa)])
    const chunks = chunkifyBinaryTreeCode(code)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].length).toBe(32)

    // encode/decode BinaryTreeLeafBasicData
    const account = createAccount({
      nonce: 5n,
      balance: 1000n,
    })
    const encoded = encodeBinaryTreeLeafBasicData(account)
    expect(encoded.length).toBe(32)
    const decoded = decodeBinaryTreeLeafBasicData(encoded)
    expect(decoded.version).toBe(0)
    expect(decoded.nonce).toBe(5n)
    expect(decoded.codeSize).toBe(0)
    expect(decoded.balance).toBe(1000n)

    // generateBinaryTreeChunkSuffixes
    expect(generateBinaryTreeChunkSuffixes(0)).toEqual([])
    const suffixesSmall = generateBinaryTreeChunkSuffixes(10)
    expect(suffixesSmall).toHaveLength(10)
    const suffixesWrap = generateBinaryTreeChunkSuffixes(300)
    expect(suffixesWrap).toHaveLength(300)
    expect(suffixesWrap.includes(0)).toBe(true)

    // generateBinaryTreeCodeStems
    const stemsSingle = generateBinaryTreeCodeStems(50, dummyAddr, dummyHash)
    expect(stemsSingle).toHaveLength(1)

    const stemsMulti = generateBinaryTreeCodeStems(600, dummyAddr, dummyHash)
    expect(stemsMulti.length).toBeGreaterThan(1)
  })

  it('covers bal.ts cleanupSelfdestructed and compareLexicographicHexOrBytes', () => {
    const bal = createBlockLevelAccessList()
    const addr1 = ('0x' + '11'.repeat(20)) as PrefixedHexString
    const addr2 = ('0x' + '22'.repeat(20)) as PrefixedHexString

    bal.addAddress(addr1)
    bal.addStorageWrite(addr1, new Uint8Array([1]), new Uint8Array([10]), 0)
    bal.addNonceChange(addr1, 1n, 0)
    bal.addCodeChange(addr1, new Uint8Array([0x60, 0x00]), 0)

    // original balance > 0
    bal.addBalanceChange(addr1, 0n, 0, 100n)

    // cleanupSelfdestructed on addr1 (originalBalance > 0 keeps balance change)
    bal.cleanupSelfdestructed([addr1, addr2])
    expect(bal.accesses[addr1].storageChanges).toEqual({})

    // address with original balance = 0
    bal.addAddress(addr2)
    bal.addBalanceChange(addr2, 0n, 0, 0n)
    bal.cleanupSelfdestructed([addr2])
    expect(bal.accesses[addr2].balanceChanges.size).toBe(0)

    // isNoOp storage write (writing same value as original)
    const addr3 = ('0x' + '33'.repeat(20)) as PrefixedHexString
    const slot1 = new Uint8Array([5])
    bal.addAddress(addr3)
    bal.addStorageWrite(addr3, slot1, new Uint8Array([99]), 0)
    // Now write original value back: net-zero change
    bal.addStorageWrite(addr3, slot1, new Uint8Array([99]), 1, new Uint8Array([99]))
    expect(bal.accesses[addr3].storageChanges['0x05']).toBeUndefined()
  })

  it('covers bytes.ts conversions and equalsBytes', () => {
    // bytesToInt32
    expect(bytesToInt32(new Uint8Array([1]))).toBe(1)
    expect(bytesToInt32(new Uint8Array([0, 0, 1, 0]), false)).toBe(256)
    expect(bytesToInt32(new Uint8Array([0, 1, 0, 0]), true)).toBe(256)

    // bytesToBigInt64
    expect(bytesToBigInt64(new Uint8Array([1]))).toBe(1n)
    expect(bytesToBigInt64(new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0]), false)).toBe(256n)

    // int32ToBytes & bigInt64ToBytes
    const b32 = int32ToBytes(256, false)
    expect(bytesToInt32(b32, false)).toBe(256)
    const b64 = bigInt64ToBytes(256n, true)
    expect(bytesToBigInt64(b64, true)).toBe(256n)

    // bytesToUtf8
    expect(bytesToUtf8(utf8ToBytes('hello world'))).toBe('hello world')
    expect(() => bytesToUtf8('not-bytes' as any)).toThrow(TypeError)

    // equalsBytes
    expect(equalsBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
    expect(equalsBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(equalsBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
  })

  it('covers account.ts partial serialization, validation, and address generation', () => {
    // serializeWithPartialInfo with non-null values
    const partialAccount = createPartialAccount({
      nonce: 10n,
      balance: 1000n,
      storageRoot: new Uint8Array(32).fill(1),
      codeHash: new Uint8Array(32).fill(2),
      codeSize: 50,
      version: 1,
    })
    const serializedPartial = partialAccount.serializeWithPartialInfo()
    expect(serializedPartial.length).toBeGreaterThan(0)

    const deserializedPartial = createPartialAccountFromRLP(serializedPartial)
    expect(deserializedPartial.nonce).toBe(10n)
    expect(deserializedPartial.balance).toBe(1000n)
    expect(deserializedPartial.codeSize).toBe(50)
    expect(deserializedPartial.version).toBe(1)

    // serializeWithPartialInfo with mostly null values
    const mostlyNullAccount = createPartialAccount({
      nonce: 0n,
      balance: null,
      storageRoot: null,
      codeHash: null,
      codeSize: null,
      version: null,
    })
    const serializedNull = mostlyNullAccount.serializeWithPartialInfo()
    const deserializedNull = createPartialAccountFromRLP(serializedNull)
    expect(deserializedNull.nonce).toBe(0n)
    expect(() => deserializedNull.balance).toThrow('not loaded')

    // createPartialAccount throws if all fields null
    expect(() =>
      createPartialAccount({
        nonce: null,
        balance: null,
        storageRoot: null,
        codeHash: null,
        codeSize: null,
        version: null,
      }),
    ).toThrow('All partial fields null')

    // createPartialAccountFromRLP error branches
    expect(() => createPartialAccountFromRLP(new Uint8Array([0x00]))).toThrow(
      'Invalid serialized account input. Must be array',
    )

    // generateAddress2 errors
    expect(() =>
      generateAddress2(new Uint8Array(19), new Uint8Array(32), new Uint8Array([1])),
    ).toThrow('Expected from to be of length 20')
    expect(() =>
      generateAddress2(new Uint8Array(20), new Uint8Array(31), new Uint8Array([1])),
    ).toThrow('Expected salt to be of length 32')

    // isZeroAddress & isValidAddress non-string
    expect(isZeroAddress(123 as any)).toBe(false)
    expect(isValidAddress(123 as any)).toBe(false)
  })

  it('covers types.ts isNestedUint8Array and toType error branch', () => {
    expect(isNestedUint8Array(123)).toBe(false)
    expect(isNestedUint8Array([new Uint8Array([1]), [new Uint8Array([2])]])).toBe(true)
    expect(isNestedUint8Array([new Uint8Array([1]), 'not-bytes'])).toBe(false)
    expect(isNestedUint8Array([new Uint8Array([1]), [123]])).toBe(false)

    expect(() => toType('0x123', 999 as any)).toThrow('unknown outputType')
  })

  it('covers provider.ts fallback when AbortSignal.timeout is not available', async () => {
    const origTimeout = AbortSignal.timeout
    try {
      ;(AbortSignal as any).timeout = undefined

      const mock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: '0x123' }),
      }))
      vi.stubGlobal('fetch', mock)

      const res = await fetchFromProvider('https://rpc.mock', {
        method: 'eth_blockNumber',
        params: [],
      })
      expect(res).toBe('0x123')
      vi.restoreAllMocks()
    } finally {
      AbortSignal.timeout = origTimeout
    }
  })
})
