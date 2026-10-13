import { keccak_256 } from '@noble/hashes/sha3.js'
import { Common, Hardfork, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import { goerliBlocks, mainnetBlocks } from '@tvmjs/testdata'
import {
  KECCAK256_RLP,
  KECCAK256_RLP_ARRAY,
  bytesToHex,
  createZeroAddress,
  hexToBytes,
} from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import {
  Block,
  createBlockHeader,
  createBlockHeaderFromBytesArray,
  createBlockHeaderFromRLP,
} from '../src/index.ts'

import { cliqueCommon, powCommon } from './helpers.ts'
import { bcBlockGasLimitTestData } from './testdata/bcBlockGasLimitTest.ts'
import { genesisHashesTestData } from './testdata/genesisHashesTest.ts'

import type { PrefixedHexString } from '@tvmjs/util'
import type { BlockBytes } from '../src/index.ts'

describe('[Block]: Header functions', () => {
  it('should create with default constructor', () => {
    for (const header of [createBlockHeader(), new Block().header]) {
      expect(header.parentHash).toEqual(new Uint8Array(32))
      expect(header.uncleHash).toEqual(KECCAK256_RLP_ARRAY)
      expect(header.coinbase.equals(createZeroAddress())).toBe(true)
      expect(header.stateRoot).toEqual(new Uint8Array(32))
      expect(header.transactionsTrie).toEqual(KECCAK256_RLP)
      expect(header.receiptTrie).toEqual(KECCAK256_RLP)
      expect(header.logsBloom).toEqual(new Uint8Array(256))
      expect(header.difficulty).toBe(0n)
      expect(header.number).toBe(0n)
      expect(header.gasLimit).toBe(0xffffffffffffffn)
      expect(header.gasUsed).toBe(0n)
      expect(header.timestamp).toBe(0n)
      expect(header.extraData).toEqual(new Uint8Array(0))
      expect(header.mixHash).toEqual(new Uint8Array(32))
      expect(header.nonce).toEqual(new Uint8Array(8))
      expect(header.baseFeePerGas).toBe(7n)
      expect(header.common.chainId()).toBe(BigInt(TronMainnet.chainId))
      expect(header.common.hasConsensus()).toBe(false)
    }
  })

  it('Initialization -> fromHeaderData()', () => {
    const common = new Common({ chain: TronMainnet })
    const header = createBlockHeader(undefined, { common })
    expect(header.hash()).toHaveLength(32)
    expect(header.common.hardfork()).toBe(Hardfork.Tron)
    common.setEIPs([7939])
    expect(header.common.isActivatedEIP(7939)).toBe(false)
    expect(createBlockHeader({}, { common }).common.isActivatedEIP(7939)).toBe(true)
    assert.isFrozen(createBlockHeader({}))
    assert.isNotFrozen(createBlockHeader({}, { freeze: false }))
  })

  it('Initialization -> fromRLPSerializedHeader()', () => {
    const common = new Common({ chain: TronMainnet })
    const header = createBlockHeader({ baseFeePerGas: 8n }, { common })
    const encoded = header.serialize()
    const restored = createBlockHeaderFromRLP(encoded, { common })
    assert.isFrozen(restored)
    expect(restored.hash()).toEqual(header.hash())
    expect(restored.baseFeePerGas).toBe(8n)
    assert.isNotFrozen(createBlockHeaderFromRLP(encoded, { common, freeze: false }))

    // Preserve the historical vector as input, but do not invent a missing wire fee.
    const [legacyHeader] = RLP.decode(
      hexToBytes(`0x${genesisHashesTestData.test.genesis_rlp_hex}`),
    ) as BlockBytes
    expect(() => createBlockHeaderFromRLP(RLP.encode(legacyHeader), { common })).toThrow(
      'baseFeePerGas should be provided',
    )
  })

  it('Initialization -> fromRLPSerializedHeader() -> error cases', () => {
    expect(() => createBlockHeaderFromRLP(RLP.encode('a'))).toThrow(
      'Invalid serialized header input. Must be array',
    )
  })

  it('Initialization -> createBlockHeaderFromBytesArray()', () => {
    const values = createBlockHeader({ baseFeePerGas: 0n }).raw()
    expect(values).toHaveLength(16)
    assert.isFrozen(createBlockHeaderFromBytesArray(values))
    assert.isNotFrozen(createBlockHeaderFromBytesArray(values, { freeze: false }))
    expect(createBlockHeaderFromBytesArray(values).baseFeePerGas).toBe(0n)
    expect(() => createBlockHeaderFromBytesArray(values.slice(0, 15))).toThrow(
      'baseFeePerGas should be provided',
    )
  })

  it('Initialization -> createBlockHeaderFromBytesArray() -> error cases', () => {
    const values = createBlockHeader().raw()
    expect(() =>
      createBlockHeaderFromBytesArray([...values, ...Array(3).fill(new Uint8Array())]),
    ).toThrow('Unsupported header extension')
    expect(() => createBlockHeaderFromBytesArray(values.slice(0, 5))).toThrow(
      'Less values than expected',
    )
  })

  it('Initialization -> Clique Blocks', () => {
    const header = createBlockHeader({ extraData: new Uint8Array(97) }, { common: cliqueCommon() })
    expect(header.hash()).toHaveLength(32)
    expect(header.common.hardfork()).toBe(Hardfork.Tron)
  })

  it('should validate extraData', () => {
    const common = powCommon()
    for (const length of [12, 32]) {
      expect(() =>
        createBlockHeader({ number: 1, extraData: new Uint8Array(length) }, { common }),
      ).not.toThrow()
    }
    expect(() =>
      createBlockHeader({ number: 1, extraData: new Uint8Array(42) }, { common }),
    ).toThrow('invalid amount of extra data')
    const clique = cliqueCommon()
    expect(() =>
      createBlockHeader({ number: 1, extraData: new Uint8Array(97) }, { common: clique }),
    ).not.toThrow()
    expect(() =>
      createBlockHeader({ number: 1, extraData: new Uint8Array(32) }, { common: clique }),
    ).toThrow('extraData must be 97 bytes')
    expect(() =>
      createBlockHeader({ number: 30000, extraData: new Uint8Array(138) }, { common: clique }),
    ).toThrow('signer length of 41 (not divisible by 20)')
    expect(() => createBlockHeader({ number: 1, extraData: new Uint8Array(42) })).not.toThrow()
  })

  it('should skip consensusFormatValidation when explicitly requested', () => {
    expect(() =>
      createBlockHeader(
        { extraData: new Uint8Array(1) },
        { common: cliqueCommon(), skipConsensusFormatValidation: true },
      ),
    ).not.toThrow()
  })

  it('_genericFormatValidation checks', () => {
    for (const field of ['parentHash', 'stateRoot', 'transactionsTrie', 'receiptTrie', 'mixHash']) {
      expect(() => createBlockHeader({ [field]: new Uint8Array(31) })).toThrow(
        `${field} must be 32 bytes`,
      )
    }
    expect(() => createBlockHeader({ nonce: new Uint8Array(5) })).toThrow('nonce must be 8 bytes')
    expect(() => createBlockHeader({ gasLimit: 1n, gasUsed: 2n })).toThrow('too much gas used')
  })

  it('should test validateGasLimit()', () => {
    // Retain the fixed gas-limit vectors, independent of their retired wire format.
    const vectors = bcBlockGasLimitTestData.tests.BlockGasLimit2p63m1
    for (const vector of Object.values(vectors)) {
      const [parent] = RLP.decode(hexToBytes(vector.genesisRLP as PrefixedHexString)) as BlockBytes
      const [child] = RLP.decode(
        hexToBytes(vector.blocks[0].rlp as PrefixedHexString),
      ) as BlockBytes
      const parentHeader = createBlockHeader({ gasLimit: parent[9] })
      const header = createBlockHeader({ gasLimit: child[9] })
      expect(header.gasLimit).toBe(0x7fffffffffffffffn)
      expect(() => header.validateGasLimit(parentHeader)).not.toThrow()
    }
  })

  it('should test isGenesis()', () => {
    expect(createBlockHeader({ number: 1 }).isGenesis()).toBe(false)
    expect(createBlockHeader().isGenesis()).toBe(true)
  })

  it('should preserve historical header fields when adding the TRON base fee', () => {
    const cases = [
      [
        mainnetBlocks[0].header,
        powCommon(),
        '0x88e96d4537bea4d9c05d12549907b32561d3bf31f45aae734cdc119f13406cb6',
      ],
      [
        goerliBlocks[0].header,
        cliqueCommon(),
        '0x8f5bab218b6bb34476f51ca588e9f4553a3a7ce5e13a66c660a5283e97e9a85a',
      ],
    ] as const
    for (const [data, common, historicalHash] of cases) {
      const header = createBlockHeader(data, { common })
      const originalFields = header.raw().slice(0, 15)
      expect(bytesToHex(keccak_256(RLP.encode(originalFields)))).toBe(historicalHash)
      expect(header.raw()[15]).toEqual(Uint8Array.of(7))
      expect(header.hash()).toEqual(keccak_256(RLP.encode([...originalFields, Uint8Array.of(7)])))
      expect(bytesToHex(header.hash())).not.toBe(historicalHash)
      expect(createBlockHeaderFromRLP(header.serialize(), { common }).hash()).toEqual(header.hash())
    }
  })

  it.each([TronMainnet, TronNile, TronShasta])(
    'initializes $name with only TRON header defaults',
    (chain) => {
      const header = createBlockHeader({}, { common: new Common({ chain }), setHardfork: true })
      expect(header.common.hardfork()).toBe(Hardfork.Tron)
      expect(header.baseFeePerGas).toBe(7n)
      expect(header.withdrawalsRoot).toBeUndefined()
      expect(header.requestsHash).toBeUndefined()
      expect(header.blockAccessListHash).toBeUndefined()
      expect(header.slotNumber).toBeUndefined()
      expect(header.raw()).toHaveLength(16)
    },
  )
})
