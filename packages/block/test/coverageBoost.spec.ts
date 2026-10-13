import { Common, TronMainnet, createCustomCommon } from '@tvmjs/common'
import { Address, type WithdrawalBytes } from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import { cliqueSigHash, requireClique } from '../src/consensus/clique.ts'
import { executionPayloadFromBeaconPayload } from '../src/from-beacon-payload.ts'
import { getDifficulty, numberToHex } from '../src/helpers.ts'
import {
  Block,
  type BlockBytes,
  BlockHeader,
  createBlock,
  createBlockFromBytesArray,
  createBlockFromJSONRPCProvider,
  createBlockFromRLP,
  createBlockHeader,
  createBlockHeaderFromBytesArray,
  createSealedCliqueBlock,
  createSealedCliqueBlockHeader,
} from '../src/index.ts'
import { powCommon } from './helpers.ts'
import { testdataFromRPCData } from './testdata/testdata-from-rpc.ts'

describe('Block Package Coverage Boost', () => {
  const common = new Common({ chain: TronMainnet })
  const customCommon = createCustomCommon({ chainId: 1 }, TronMainnet)

  it('covers numberToHex and getDifficulty edge cases in helpers.ts', () => {
    expect(numberToHex(undefined)).toBeUndefined()
    expect(numberToHex('0x123')).toBe('0x123')
    expect(numberToHex('123')).toBe('0x7b')
    expect(() => numberToHex('invalid!')).toThrow(
      'Cannot convert string to hex string. numberToHex only supports 0x-prefixed hex or integer strings',
    )

    expect(getDifficulty({} as any)).toBeNull()
    expect(getDifficulty({ difficulty: 100n } as any)).toBe(100n)
    expect(getDifficulty({ difficulty: '0x64' } as any)).toBe(100n)
  })

  it('covers from-beacon-payload with withdrawals and requests_hash', () => {
    const payload: any = {
      parent_hash: '0x' + '11'.repeat(32),
      fee_recipient: '0x' + '22'.repeat(20),
      state_root: '0x' + '33'.repeat(32),
      receipts_root: '0x' + '44'.repeat(32),
      logs_bloom: '0x' + '00'.repeat(256),
      prev_randao: '0x' + '55'.repeat(32),
      block_number: '10',
      gas_limit: '1000000',
      gas_used: '21000',
      timestamp: '1600000000',
      extra_data: '0x',
      base_fee_per_gas: '7',
      block_hash: '0x' + '66'.repeat(32),
      transactions: [],
      withdrawals: [
        {
          index: '1',
          validator_index: '2',
          address: '0x' + '77'.repeat(20),
          amount: '100',
        },
      ],
      requests_hash: '0x' + '88'.repeat(32),
    }

    const execPayload = executionPayloadFromBeaconPayload(payload)
    expect(execPayload.withdrawals).toBeDefined()
    expect(execPayload.withdrawals).toHaveLength(1)
    expect(execPayload.requestsHash).toBe(payload.requests_hash)
  })

  it('covers createBlockHeaderFromBytesArray validation branches for EIPs', () => {
    // 15 canonical fields
    const baseFields: Uint8Array[] = [
      new Uint8Array(32), // parentHash
      new Uint8Array(32), // uncleHash
      new Uint8Array(20), // coinbase
      new Uint8Array(32), // stateRoot
      new Uint8Array(32), // txRoot
      new Uint8Array(32), // receiptRoot
      new Uint8Array(256), // logsBloom
      new Uint8Array(0), // difficulty
      new Uint8Array(0), // number
      new Uint8Array(4), // gasLimit
      new Uint8Array(0), // gasUsed
      new Uint8Array(4), // timestamp
      new Uint8Array(0), // extraData
      new Uint8Array(32), // mixHash
      new Uint8Array(8), // nonce
    ]

    expect(() => createBlockHeaderFromBytesArray(baseFields, { common: customCommon })).toThrow(
      'invalid header. baseFeePerGas should be provided',
    )
  })

  it('covers createBlockFromJSONRPCProvider tag variations and uncle fetching', async () => {
    const mockRPCData = {
      ...testdataFromRPCData,
      uncles: ['0x' + 'aa'.repeat(32)],
    }
    const mockUncleHeader = {
      ...testdataFromRPCData,
      number: '0x1',
    }

    const mockFetch = vi.fn(async (_url: unknown, req: RequestInit) => {
      const { method } = JSON.parse(req.body as string)
      if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: mockRPCData }),
        }
      }
      if (method === 'eth_getUncleByBlockHashAndIndex') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: mockUncleHeader }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ result: null }) }
    })
    vi.stubGlobal('fetch', mockFetch)

    const providerUrl = 'https://rpc.dummy'

    const customCommonWithConsensus = powCommon(1)

    // Test with bigint blockTag and uncles
    const blockByNum = await createBlockFromJSONRPCProvider(providerUrl, 100n, {
      common: customCommonWithConsensus,
    })
    expect(blockByNum).toBeDefined()
    expect(blockByNum.uncleHeaders).toHaveLength(1)

    // Test with string tag 'latest'
    const blockByLatest = await createBlockFromJSONRPCProvider(providerUrl, 'latest', {
      common: customCommonWithConsensus,
    })
    expect(blockByLatest).toBeDefined()

    // Test uncle headers without consensus throws
    expect(() =>
      createBlock({ uncleHeaders: [blockByNum.header] }, { common: customCommon }),
    ).toThrow('Uncle headers are not supported by TRON execution presets')

    // Test with invalid blockTag
    await expect(
      createBlockFromJSONRPCProvider(providerUrl, {} as any, { common: customCommon }),
    ).rejects.toThrow('expected blockTag to be block hash, bigint, hex prefixed string')

    vi.restoreAllMocks()
  })

  it('covers createSealedCliqueBlock and createSealedCliqueBlockHeader', () => {
    const cliqueCommon = new Common({
      chain: {
        ...TronMainnet,
        consensus: {
          type: 'poa',
          algorithm: 'clique',
          clique: { period: 15, epoch: 30000 },
        },
      },
    })
    const dummyKey = new Uint8Array(32).fill(1)

    const sealedHeader = createSealedCliqueBlockHeader(
      { extraData: new Uint8Array(97) },
      dummyKey,
      { common: cliqueCommon, freeze: false, skipConsensusFormatValidation: true },
    )
    expect(sealedHeader).toBeDefined()

    const sealedBlock = createSealedCliqueBlock(
      { header: { extraData: new Uint8Array(97) } },
      dummyKey,
      { common: cliqueCommon, freeze: true, skipConsensusFormatValidation: true },
    )
    expect(sealedBlock).toBeDefined()
    expect(Object.isFrozen(sealedBlock)).toBe(true)
  })

  it('covers clique requireClique and cliqueSigHash non-clique error', () => {
    const powCommon = new Common({
      chain: {
        ...TronMainnet,
        consensus: {
          type: 'pow',
          algorithm: 'ethash',
        },
      },
    })
    const nonCliqueHeader = createBlockHeader({}, { common: powCommon })
    expect(() => requireClique(nonCliqueHeader, 'testMethod')).toThrow(
      'BlockHeader.testMethod() call only supported for clique PoA networks',
    )
    expect(() => cliqueSigHash(nonCliqueHeader)).toThrow(
      'BlockHeader.cliqueSigHash() call only supported for clique PoA networks',
    )
  })

  it('covers header and block errorStr and toJSON methods', () => {
    const header = createBlockHeader({}, { common })
    const errStr = header.errorStr()
    expect(errStr).toContain('block header')

    // Cause hash to throw to hit catch block in errorStr
    const mockHeader = {
      number: 1n,
      baseFeePerGas: 7n,
      hash: () => {
        throw new Error('hash error')
      },
      common: {
        hardfork: () => {
          throw new Error('hf error')
        },
      },
      errorStr: BlockHeader.prototype.errorStr,
    } as any
    expect(mockHeader.errorStr()).toContain('hash=error')

    // Test block errorStr
    const block = createBlock({ header }, { common })
    expect(block.errorStr()).toContain('block number=')

    const mockBlock = {
      header,
      transactions: [],
      uncleHeaders: [],
      hash: () => {
        throw new Error('block hash error')
      },
      common: {
        hardfork: () => {
          throw new Error('hf error')
        },
      },
      errorStr: Block.prototype.errorStr,
    } as any
    expect(mockBlock.errorStr()).toContain('hash=error')

    // Test block toJSON and toExecutionPayload
    const jsonBlock = block.toJSON()
    expect(jsonBlock.header).toBeDefined()
    const execPayload = block.toExecutionPayload()
    expect(execPayload.blockHash).toBeDefined()
  })

  it('covers ethashCanonicalDifficulty edge cases in header', () => {
    const posCommon = new Common({
      chain: {
        ...TronMainnet,
        consensus: {
          type: 'pos',
          algorithm: 'casper',
        },
      },
    })
    const nonPowHeader = createBlockHeader({}, { common: posCommon })
    expect(() => nonPowHeader.ethashCanonicalDifficulty(nonPowHeader)).toThrow(
      'difficulty calculation is only supported on PoW chains',
    )

    const nonEthashCommon = new Common({
      chain: {
        ...TronMainnet,
        consensus: {
          type: 'pow',
          algorithm: 'progpow',
        },
      },
    })
    const nonEthashHeader = createBlockHeader({}, { common: nonEthashCommon })
    expect(() => nonEthashHeader.ethashCanonicalDifficulty(nonEthashHeader)).toThrow(
      'difficulty calculation currently only supports the ethash algorithm',
    )
  })

  it('covers clique extraData padding and consensus validation', () => {
    const cliqueCommon = new Common({
      chain: {
        ...TronMainnet,
        consensus: {
          type: 'poa',
          algorithm: 'clique',
          clique: { period: 15, epoch: 30000 },
        },
      },
    })
    const dummyKey = new Uint8Array(32).fill(1)

    // extraData length < 97 to test padding (lines 147-148 in clique.ts)
    const shortHeader = createSealedCliqueBlockHeader({ extraData: new Uint8Array(10) }, dummyKey, {
      common: cliqueCommon,
      freeze: false,
      skipConsensusFormatValidation: true,
    })
    expect(shortHeader.extraData.length).toBeGreaterThanOrEqual(97)

    // Sealed block with short extraData and skipConsensusFormatValidation = false
    const sealedBlock = createSealedCliqueBlock(
      { header: { extraData: new Uint8Array(10) } },
      dummyKey,
      { common: cliqueCommon, freeze: false, skipConsensusFormatValidation: false },
    )
    expect(sealedBlock).toBeDefined()

    // Sealed header with skipConsensusFormatValidation = false
    const sealedHeaderVal = createSealedCliqueBlockHeader(
      { extraData: new Uint8Array(97) },
      dummyKey,
      { common: cliqueCommon, freeze: false, skipConsensusFormatValidation: false },
    )
    expect(sealedHeaderVal).toBeDefined()
  })

  it('covers createBlockFromBytesArray branches for EIP-4895, extension, and uncles', () => {
    function createEipCommon(eips: number[]) {
      const c = new Common({ chain: TronMainnet })
      const eipSet = new Set(eips)
      c.isActivatedEIP = (eip: number) => eipSet.has(eip)
      c.copy = () => createEipCommon(eips)
      return c
    }
    const shanghaiCommon = createEipCommon([1559, 4895])
    const header = createBlockHeader({}, { common })

    // EIP-4895 active but withdrawals missing
    expect(() =>
      createBlockFromBytesArray([header.raw(), [], []], { common: shanghaiCommon }),
    ).toThrow(
      'Invalid serialized block input: EIP-4895 is active, and no withdrawals were provided as array',
    )

    // Extra extension fields
    expect(() =>
      createBlockFromBytesArray(
        [header.raw(), [], [], [], new Uint8Array([1])] as unknown as BlockBytes,
        { common },
      ),
    ).toThrow(
      'Unsupported block body extension: additional fields are not active in this execution profile',
    )

    // Valid withdrawals array from bytes
    const withdrawalByteEntry: WithdrawalBytes = [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array(20),
      new Uint8Array([100]),
    ]
    const blockWithWdBytes = createBlockFromBytesArray(
      [header.raw(), [], [], [withdrawalByteEntry]],
      { common: shanghaiCommon },
    )
    expect(blockWithWdBytes.withdrawals).toHaveLength(1)

    // With uncles and setHardfork
    const powComm = powCommon(1)
    const powHeader = createBlockHeader({ number: 1n }, { common: powComm })
    const blockWithUnclesFromBytes = createBlockFromBytesArray(
      [powHeader.raw(), [], [powHeader.raw()]],
      { common: powComm, setHardfork: true },
    )
    expect(blockWithUnclesFromBytes.uncleHeaders).toHaveLength(1)
  })

  it('covers createBlockFromRLP with EIP-7934 limit', () => {
    const eip7934Common = {
      isActivatedEIP: (eip: number) => eip === 7934,
      param: () => 5,
    } as any
    expect(() => createBlockFromRLP(new Uint8Array(20), { common: eip7934Common })).toThrow(
      'Block size exceeds limit',
    )
  })

  it('covers createBlockHeaderFromBytesArray EIP branches and raw/toJSON with EIPs', () => {
    const baseFields: Uint8Array[] = [
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(20),
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(256),
      new Uint8Array(0),
      new Uint8Array(0),
      new Uint8Array(4),
      new Uint8Array(0),
      new Uint8Array(4),
      new Uint8Array(0),
      new Uint8Array(32),
      new Uint8Array(8),
    ]

    const baseFieldsWith1559 = [...baseFields, new Uint8Array([7])]

    function createEipCommon(eips: number[]) {
      const c = new Common({ chain: TronMainnet })
      const eipSet = new Set(eips)
      c.isActivatedEIP = (eip: number) => eipSet.has(eip)
      c.copy = () => createEipCommon(eips)
      return c
    }

    expect(() =>
      createBlockHeaderFromBytesArray(baseFieldsWith1559, {
        common: createEipCommon([1559, 7685]),
      }),
    ).toThrow('requestsHash should be provided')

    expect(() =>
      createBlockHeader({ blockAccessListHash: new Uint8Array(32) }, { common }),
    ).toThrow('blockAccessListHash can only be provided with EIP 7928 activated')

    expect(() => createBlockHeader({ slotNumber: 10n }, { common })).toThrow(
      'slotNumber can only be provided with EIP 7843 activated',
    )

    // Header with all EIPs active for raw() and toJSON()
    const allEipsCommon = createEipCommon([1559, 4895, 7685, 7928, 7843])
    const headerWithEips = createBlockHeader(
      {
        baseFeePerGas: 7n,
        withdrawalsRoot: new Uint8Array(32),
        requestsHash: new Uint8Array(32),
        blockAccessListHash: new Uint8Array(32),
        slotNumber: 42n,
      },
      { common: allEipsCommon, freeze: false },
    )
    const raw = headerWithEips.raw()
    expect(raw.length).toBeGreaterThan(15)
    const json = headerWithEips.toJSON()
    expect(json.requestsHash).toBeDefined()
    expect(json.blockAccessListHash).toBeDefined()
    expect(json.slotNumber).toBeDefined()
  })

  it('covers block validateUncles, validateGasLimit, and withdrawals toJSON', () => {
    const parentBlock = createBlock(
      { header: createBlockHeader({ gasLimit: 1000000n }, { common }) },
      { common },
    )
    const childBlock = createBlock(
      { header: createBlockHeader({ number: 1n, gasLimit: 1000000n }, { common }) },
      { common },
    )
    expect(() => childBlock.validateGasLimit(parentBlock)).not.toThrow()

    // Uncles validation
    const uncle1 = createBlockHeader({ number: 1n, extraData: new Uint8Array([1]) }, { common })
    const uncle2 = createBlockHeader({ number: 2n, extraData: new Uint8Array([2]) }, { common })
    const uncle3 = createBlockHeader({ number: 3n, extraData: new Uint8Array([3]) }, { common })
    const powComm = powCommon(1)

    expect(() =>
      createBlock(
        {
          header: createBlockHeader({ number: 4n }, { common: powComm }),
          uncleHeaders: [uncle1, uncle2, uncle3],
        },
        { common: powComm },
      ),
    ).toThrow('too many uncle headers')

    expect(() =>
      createBlock(
        {
          header: createBlockHeader({ number: 4n }, { common: powComm }),
          uncleHeaders: [uncle1, uncle1],
        },
        { common: powComm },
      ),
    ).toThrow('duplicate uncles')

    // Withdrawals without EIP 4895 throws
    expect(() =>
      createBlock(
        {
          header: createBlockHeader({}, { common }),
          withdrawals: [
            {
              index: 0n,
              validatorIndex: 1n,
              address: new Address(new Uint8Array(20)),
              amount: 100n,
            },
          ],
        },
        { common },
      ),
    ).toThrow('Cannot have a withdrawals field if EIP 4895 is not active')

    // Withdrawals with EIP 4895 active in toJSON
    function createEipCommon(eips: number[]) {
      const c = new Common({ chain: TronMainnet })
      const eipSet = new Set(eips)
      c.isActivatedEIP = (eip: number) => eipSet.has(eip)
      c.copy = () => createEipCommon(eips)
      return c
    }
    const shanghaiCommon = createEipCommon([4895])
    const blockWithWithdrawals = createBlock(
      {
        header: createBlockHeader(
          { withdrawalsRoot: new Uint8Array(32) },
          { common: shanghaiCommon },
        ),
        withdrawals: [
          {
            index: 0n,
            validatorIndex: 1n,
            address: new Address(new Uint8Array(20)),
            amount: 100n,
          },
        ],
      },
      { common: shanghaiCommon },
    )
    const jsonWithWd = blockWithWithdrawals.toJSON()
    expect(jsonWithWd.withdrawals).toHaveLength(1)
  })
})
