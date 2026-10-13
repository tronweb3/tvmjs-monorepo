import { keccak_256 } from '@noble/hashes/sha3.js'
import { Common, Hardfork, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import { preLondonTestDataBlocks1RLP, preLondonTestDataBlocks2RLP } from '@tvmjs/testdata'
import { createLegacyTx } from '@tvmjs/tx'
import { MAX_RLP_BLOCK_SIZE, bytesToHex, hexToBytes } from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import {
  createBlock,
  createBlockFromBytesArray,
  createBlockFromRLP,
  createBlockHeader,
  createEmptyBlock,
  genTransactionsTrieRoot,
  paramsBlock,
} from '../src/index.ts'

import { cliqueCommon, powCommon, signedBlock, signingKey } from './helpers.ts'
import { genesisHashesTestData } from './testdata/genesisHashesTest.ts'

import type { BlockBytes } from '../src/index.ts'

describe('[Block]: block functions', () => {
  it('should test block initialization', () => {
    const common = new Common({ chain: TronMainnet })
    expect(createBlock({}, { common }).hash()).toHaveLength(32)
    expect(createEmptyBlock({}, { common }).hash()).toHaveLength(32)
    const params = structuredClone(paramsBlock)
    params[1].minGasLimit = 3000
    expect(createBlock({}, { params }).common.param('minGasLimit')).toBe(3000n)
    expect(paramsBlock[1].minGasLimit).toBe(5000)
    const block = createBlock({})
    assert.isFrozen(block)
    assert.isNotFrozen(createBlock({}, { freeze: false }))
    assert.isFrozen(createBlockFromRLP(block.serialize()))
    assert.isNotFrozen(createBlockFromRLP(block.serialize(), { freeze: false }))
    assert.isFrozen(createBlockFromBytesArray(block.raw()))
    assert.isNotFrozen(createBlockFromBytesArray(block.raw(), { freeze: false }))
  })

  it('initialization -> setHardfork preserves the TRON profile', () => {
    const common = new Common({ chain: TronMainnet, eips: [7939] })
    for (const number of [0n, 12n, 20n, 1920000n, 9007199254740993n]) {
      const block = createBlock(
        { header: { number, timestamp: 1800000000n } },
        { common, setHardfork: true },
      )
      expect(block.common.hardfork()).toBe(Hardfork.Tron)
      expect(block.common.isActivatedEIP(7939)).toBe(true)
      expect(block.header.baseFeePerGas).toBe(7n)
    }
    expect(() => common.setHardfork(Hardfork.London)).toThrow()
    expect(common.hardfork()).toBe(Hardfork.Tron)
  })

  it('should initialize with undefined parameters without throwing', () => {
    expect(() => createBlock()).not.toThrow()
  })

  it('should initialize with empty parameters without throwing', () => {
    expect(() => createBlock({}, { common: new Common({ chain: TronMainnet }) })).not.toThrow()
  })

  it('should throw when trying to initialize with uncle headers on a PoA network', () => {
    const common = cliqueCommon()
    const uncle = createBlockHeader({ extraData: new Uint8Array(97) }, { common })
    expect(() =>
      createBlock({ header: { extraData: new Uint8Array(97) }, uncleHeaders: [uncle] }, { common }),
    ).toThrow('uncleHeaders on a PoA network is not allowed')
  })

  it('should test block validation with explicit pow metadata', async () => {
    const block = await signedBlock(powCommon())
    const restored = createBlockFromRLP(block.serialize(), { common: block.common })
    await expect(restored.validateData()).resolves.toBeUndefined()
    expect(restored.hash()).toEqual(block.hash())
    expect(restored.transactions[0].getSenderAddress()).toEqual(
      block.transactions[0].getSenderAddress(),
    )
  })

  it('should reject historical block RLP without an explicit base fee', () => {
    for (const data of [
      preLondonTestDataBlocks1RLP.blockRLP,
      preLondonTestDataBlocks2RLP.block2RLP,
    ]) {
      expect(() => createBlockFromRLP(hexToBytes(data))).toThrow('baseFeePerGas should be provided')
    }
  })

  it('should test transaction validation - invalid tx trie', async () => {
    const valid = await signedBlock()
    expect(valid.transactionsAreValid()).toBe(true)
    expect(valid.getTransactionsValidationErrors()).toEqual([])
    const block = createBlock({
      header: { transactionsTrie: new Uint8Array(32) },
      transactions: valid.transactions,
    })
    await expect(block.validateData()).rejects.toThrow('invalid transaction trie')
  })

  it('should test transaction validation - transaction not signed', async () => {
    const tx = createLegacyTx({ gasLimit: 53000, gasPrice: 7 })
    const block = createBlock({
      header: { transactionsTrie: await genTransactionsTrieRoot([tx]) },
      transactions: [tx],
    })
    await expect(block.validateData()).rejects.toThrow('unsigned')
  })

  it('should test transaction validation with empty transaction list', async () => {
    const block = createBlock({})
    expect(block.transactionsAreValid()).toBe(true)
    expect(block.getTransactionsValidationErrors()).toEqual([])
    await expect(block.validateData()).resolves.toBeUndefined()
  })

  it('should validate legacy transactions against the retained base fee', async () => {
    const block = await signedBlock()
    expect(block.transactionsAreValid()).toBe(true)
    const underpriced = createLegacyTx({
      to: `0x${'11'.repeat(20)}`,
      gasLimit: 21000n,
      gasPrice: 6n,
    }).sign(signingKey)
    const invalid = createBlock({ transactions: [underpriced] })
    expect(invalid.getTransactionsValidationErrors()[0]).toContain(
      'tx unable to pay base fee (non EIP-1559 tx)',
    )
  })

  it('should test uncles hash validation', async () => {
    const common = powCommon()
    const uncle = createBlockHeader({ number: 1 }, { common })
    const uncleHash = keccak_256(RLP.encode([uncle.raw()]))
    const block = createBlock({ header: { uncleHash }, uncleHeaders: [uncle] }, { common })
    expect(block.uncleHashIsValid()).toBe(true)
    await expect(block.validateData()).resolves.toBeUndefined()
    const invalid = createBlock(
      { header: { uncleHash: new Uint8Array(32) }, uncleHeaders: [uncle] },
      { common },
    )
    await expect(invalid.validateData()).rejects.toThrow('invalid uncle hash')
    expect(() => createBlock({ uncleHeaders: [uncle] })).toThrow(
      'Uncle headers are not supported by TRON execution presets',
    )
    expect(() =>
      createBlock({ header: { number: 2n }, uncleHeaders: [uncle, uncle] }, { common }),
    ).toThrow('duplicate uncles')
  })

  it('should test data integrity', async () => {
    const unsigned = createLegacyTx({})
    const txRoot = await genTransactionsTrieRoot([unsigned])
    const block = createBlock({ header: { transactionsTrie: txRoot }, transactions: [unsigned] })
    await expect(block.validateData(false, false)).resolves.toBeUndefined()
    const badTrie = createBlock({
      header: { transactionsTrie: new Uint8Array(32) },
      transactions: [unsigned],
    })
    await expect(badTrie.validateData(false, false)).rejects.toThrow('invalid transaction trie')
    const badUncles = createBlock({ header: { uncleHash: new Uint8Array(32) } })
    await expect(badUncles.validateData(false, false)).rejects.toThrow('invalid uncle hash')
    expect(() => createBlock({ header: { withdrawalsRoot: new Uint8Array(32) } })).toThrow(
      'EIP4895',
    )
  })

  it('should test isGenesis (TRON mainnet default)', () => {
    expect(createBlock({ header: { number: 1 } }).isGenesis()).toBe(false)
    expect(createBlock({ header: { number: 0 } }).isGenesis()).toBe(true)
  })

  it('should preserve a fixed genesis vector with an explicit TRON fee extension', () => {
    const raw = RLP.decode(
      hexToBytes(`0x${genesisHashesTestData.test.genesis_rlp_hex}`),
    ) as BlockBytes
    expect(bytesToHex(keccak_256(RLP.encode(raw[0])))).toBe(
      `0x${genesisHashesTestData.test.genesis_hash}`,
    )
    raw[0].push(Uint8Array.of(7))
    const block = createBlockFromBytesArray(raw)
    expect(block.hash()).toEqual(keccak_256(RLP.encode(raw[0])))
    expect(bytesToHex(block.hash())).not.toBe(`0x${genesisHashesTestData.test.genesis_hash}`)
    expect(block.serialize()).toEqual(RLP.encode(raw))
    expect(block.isGenesis()).toBe(true)
  })

  it('should apply custom crypto to block hashes', () => {
    const common = new Common({
      chain: TronMainnet,
      customCrypto: { keccak256: () => Uint8Array.of(1) },
    })
    expect(createBlock({}, { common }).hash()).toEqual(Uint8Array.of(1))
  })

  it('should error on invalid params', () => {
    expect(() => createBlockFromRLP(RLP.encode('a'))).toThrow('Must be array')
    expect(() => createBlockFromBytesArray([[], [], []])).toThrow('Less values than expected')
    expect(() =>
      createBlockFromBytesArray([
        createBlockHeader().raw(),
        [],
        [],
        [],
        [],
        [],
      ] as unknown as BlockBytes),
    ).toThrow('More values')
  })

  it('should return the same block data from raw()', async () => {
    const block = await signedBlock()
    const restored = createBlockFromBytesArray(block.raw())
    expect(restored.hash()).toEqual(block.hash())
    expect(restored.raw()).toEqual(block.raw())
    expect(restored.transactions[0].getSenderAddress()).toEqual(
      block.transactions[0].getSenderAddress(),
    )
  })

  it('should test toJSON', async () => {
    const block = await signedBlock()
    const json = block.toJSON()
    expect(json.transactions![0]).toMatchObject({ tokenId: '0x20000000000001', tokenValue: '0x7' })
    const restored = createBlock(json)
    expect(restored.serialize()).toEqual(block.serialize())
    expect(restored.transactions[0].getSenderAddress()).toEqual(
      block.transactions[0].getSenderAddress(),
    )
    await expect(restored.validateData()).resolves.toBeUndefined()
  })

  it('does not impose DAO extra data on the TRON profile', () => {
    for (const extraData of ['0x', '0x64616f2d686172642d666f726b'] as const) {
      const block = createBlock({ header: { number: 1920000n, extraData } }, { setHardfork: true })
      expect(block.common.hardfork()).toBe(Hardfork.Tron)
      expect(bytesToHex(block.header.extraData)).toBe(extraData)
    }
  })

  it('should set canonical difficulty with explicit pow metadata', () => {
    const common = powCommon()
    const parent = createBlock({ header: { difficulty: 131072n, timestamp: 0n } }, { common })
    expect(
      createBlock({ header: { number: 1n, timestamp: 10n } }, { common }).header.difficulty,
    ).toBe(0n)
    const calculated = createBlock(
      { header: { number: 1n, timestamp: 10n } },
      { common, calcDifficultyFromHeader: parent.header },
    )
    expect(calculated.header.difficulty).toBe(131136n)
    expect(calculated.header.ethashCanonicalDifficulty(parent.header)).toBe(131136n)
    const farAhead = createBlock(
      { header: { number: 1337n, timestamp: 10n } },
      { common, calcDifficultyFromHeader: parent.header },
    )
    expect(farAhead.header.difficulty).toBe(131136n)
  })
})

describe.each([TronMainnet, TronNile, TronShasta])('TRON block capabilities on $name', (chain) => {
  it('keeps unsupported capabilities unavailable', () => {
    const common = new Common({ chain })
    for (const eip of [3675, 4399, 4895, 7685, 7825, 7843, 7928, 7934]) {
      expect(common.isActivatedEIP(eip)).toBe(false)
      expect(() => common.setEIPs([eip])).toThrow()
    }
    const block = createBlock({}, { common, setHardfork: true })
    expect(block.common.hardfork()).toBe(Hardfork.Tron)
    expect(block.withdrawals).toBeUndefined()
    expect(block.header.withdrawalsRoot).toBeUndefined()
  })

  it('does not impose the EIP-7825 transaction gas cap', () => {
    const common = new Common({ chain })
    const tx = createLegacyTx({ gasLimit: 2n ** 24n + 1n, gasPrice: 7n }, { common }).sign(
      signingKey,
    )
    const block = createBlock({ transactions: [tx] }, { common })
    expect(block.transactionsAreValid()).toBe(true)
    expect(block.transactions[0].gasLimit).toBe(16777217n)
  })
})

describe('[Block]: unavailable EIP-7934 size limit', () => {
  it('round trips a block above the Ethereum limit without enabling that capability', async () => {
    const block = createBlock({ header: { extraData: new Uint8Array(MAX_RLP_BLOCK_SIZE + 1) } })
    for (const validateSize of [undefined, true]) {
      await expect(block.validateData(false, false, validateSize)).resolves.toBeUndefined()
    }
    const rlp = block.serialize()
    expect(rlp.length).toBeGreaterThan(MAX_RLP_BLOCK_SIZE)
    const restored = createBlockFromRLP(rlp)
    expect(restored.hash()).toEqual(block.hash())
    expect(restored.header.extraData.length).toBe(block.header.extraData.length)
    expect(
      () =>
        new Common({ chain: TronMainnet, eips: [7934], params: { 7934: { maxRlpBlockSize: 1 } } }),
    ).toThrow()
  })
})
