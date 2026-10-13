import { keccak_256 } from '@noble/hashes/sha3.js'
import { Common, TronMainnet, TronNile, TronShasta, createCustomCommon } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import { bytesToHex, createAddressFromPrivateKey } from '@tvmjs/util'
import { assert, afterEach, describe, expect, it, vi } from 'vitest'

import {
  createBlockFromJSONRPCProvider,
  createBlockFromRPC,
  createBlockHeaderFromRPC,
} from '../src/index.ts'

import { cliqueCommon, powCommon, signedBlock, signingKey } from './helpers.ts'
import { alchemy14151203Data } from './testdata/alchemy14151203.ts'
import { infura2000004withTransactionsData } from './testdata/infura2000004withTransactions.ts'
import { infura2000004withoutTransactionsData } from './testdata/infura2000004withoutTransactions.ts'
import { infura15571241Data } from './testdata/infura15571241.ts'
import { infura15571241withTransactionsData } from './testdata/infura15571241withTransactions.ts'
import { testdataFromRPCDifficultyAsIntegerData } from './testdata/testdata-from-rpc-difficulty-as-integer.ts'
import { testdataFromRPCGoerliLondonData } from './testdata/testdata-from-rpc-goerli-london.ts'
import { testdataFromRPCWithUnclesData } from './testdata/testdata-from-rpc-with-uncles.ts'
import { testdataFromRPCWithUnclesUncleBlockData } from './testdata/testdata-from-rpc-with-uncles_uncle-block-data.ts'
import { testdataFromRPCWithWithdrawalsData } from './testdata/testdata-from-rpc-with-withdrawals.ts'
import { testdataFromRPCData } from './testdata/testdata-from-rpc.ts'

import type { JSONRPCTx, LegacyTx } from '@tvmjs/tx'
import type { JSONRPCBlock } from '../src/index.ts'

describe('[fromRPC]: block #2924874', () => {
  const common = createCustomCommon({ chainId: 1 }, TronMainnet)

  it('should decode the retained historical transaction data', () => {
    const block = createBlockFromRPC(testdataFromRPCData, [], { common })
    expect(block.transactions).toHaveLength(testdataFromRPCData.transactions.length)
    expect(block.transactions.length).toBeGreaterThan(0)
    expect(block.transactions.every((tx) => tx.isSigned())).toBe(true)
  })

  it('preserves historical header fields and adds the TRON fee', () => {
    const block = createBlockHeaderFromRPC(testdataFromRPCData, { common })
    expect(bytesToHex(keccak_256(RLP.encode(block.raw().slice(0, 15))))).toBe(
      testdataFromRPCData.hash,
    )
    expect(block.baseFeePerGas).toBe(7n)
    expect(bytesToHex(block.hash())).not.toBe(testdataFromRPCData.hash)
  })
})

describe('[fromRPC]:', () => {
  it('Should create a block with JSON data that includes a transaction with value parameter as integer string', () => {
    const common = createCustomCommon({ chainId: 1 }, TronMainnet)
    const valueAsIntegerString = '1'
    const blockDataTransactionValueAsInteger = structuredClone(testdataFromRPCData)
    ;(blockDataTransactionValueAsInteger.transactions[0] as JSONRPCTx).value = valueAsIntegerString
    const createBlockFromTransactionValueAsInteger = createBlockFromRPC(
      blockDataTransactionValueAsInteger as JSONRPCBlock,
      undefined,
      { common },
    )
    assert.strictEqual(
      createBlockFromTransactionValueAsInteger.transactions[0].value.toString(),
      valueAsIntegerString,
    )
  })

  it('Should create a block with JSON data that includes a transaction with defaults with gasPrice parameter as integer string', () => {
    const common = createCustomCommon({ chainId: 1 }, TronMainnet)
    const gasPriceAsIntegerString = '1'
    const blockDataTransactionGasPriceAsInteger = structuredClone(testdataFromRPCData)
    ;(blockDataTransactionGasPriceAsInteger.transactions[0] as JSONRPCTx).gasPrice =
      gasPriceAsIntegerString
    const createBlockFromTransactionGasPriceAsInteger = createBlockFromRPC(
      blockDataTransactionGasPriceAsInteger as JSONRPCBlock,
      undefined,
      { common },
    )
    assert.strictEqual(
      (createBlockFromTransactionGasPriceAsInteger.transactions[0] as LegacyTx).gasPrice.toString(),
      gasPriceAsIntegerString,
    )
  })

  it('should create a block given JSON data that includes a difficulty parameter of type integer string', () => {
    const common = createCustomCommon({ chainId: 1 }, TronMainnet)
    const blockDifficultyAsInteger = createBlockFromRPC(
      testdataFromRPCDifficultyAsIntegerData as JSONRPCBlock,
      undefined,
      {
        common,
      },
    )
    assert.strictEqual(
      blockDifficultyAsInteger.header.difficulty.toString(),
      testdataFromRPCDifficultyAsIntegerData.difficulty,
    )
  })

  it('should preserve a recorded base-fee header', () => {
    const common = cliqueCommon(5)
    const block = createBlockFromRPC(testdataFromRPCGoerliLondonData, [], { common })
    assert.strictEqual(
      `0x${block.header.baseFeePerGas?.toString(16)}`,
      testdataFromRPCGoerliLondonData.baseFeePerGas,
    )
    assert.strictEqual(bytesToHex(block.hash()), testdataFromRPCGoerliLondonData.hash)
  })

  it('rejects uncles without explicit consensus metadata', () => {
    const common = new Common({ chain: TronMainnet })
    expect(() =>
      createBlockFromRPC(
        { ...testdataFromRPCWithUnclesData, transactions: [] },
        [testdataFromRPCWithUnclesUncleBlockData],
        { common },
      ),
    ).toThrow('Uncle headers are not supported')
    const pow = powCommon(1)
    const uncle = createBlockHeaderFromRPC(
      { ...testdataFromRPCWithUnclesUncleBlockData, transactions: [] } as JSONRPCBlock,
      { common: pow },
    )
    // The added base fee changes the uncle hash; keep the old fixture untouched.
    const data = {
      ...testdataFromRPCWithUnclesData,
      transactions: [],
      sha3Uncles: bytesToHex(keccak_256(RLP.encode([uncle.raw()]))),
    }
    const block = createBlockFromRPC(data, [testdataFromRPCWithUnclesUncleBlockData], {
      common: pow,
    })
    expect(block.uncleHashIsValid()).toBe(true)
  })

  it('rejects recorded EIP-4895 withdrawals in block RPC input', () => {
    expect(() => createBlockFromRPC(testdataFromRPCWithWithdrawalsData)).toThrow('EIP4895')
  })

  it('rejects recorded EIP-4895 withdrawals in header RPC input', () => {
    expect(() => createBlockHeaderFromRPC(testdataFromRPCWithWithdrawalsData)).toThrow('EIP4895')
  })
})

describe('[fromRPC] - Alchemy/Infura API block responses', () => {
  it('should create pre merge block from Alchemy API response to eth_getBlockByHash', () => {
    const common = createCustomCommon({ chainId: 1 }, TronMainnet)
    const block = createBlockFromRPC(alchemy14151203Data, [], { common })
    assert.strictEqual(bytesToHex(block.hash()), alchemy14151203Data.hash)
  })

  it('should create pre and post merge blocks from Infura API responses to eth_getBlockByHash and eth_getBlockByNumber', () => {
    const common = createCustomCommon({ chainId: 1 }, TronMainnet)
    const oldHeader = createBlockHeaderFromRPC(infura2000004withoutTransactionsData, {
      common,
      setHardfork: true,
    })
    assert.strictEqual(
      bytesToHex(keccak_256(RLP.encode(oldHeader.raw().slice(0, 15)))),
      infura2000004withoutTransactionsData.hash,
      'created premerge block w/o txns',
    )
    expect(() => createBlockFromRPC(infura2000004withoutTransactionsData, [], { common })).toThrow(
      'Full transaction objects are required',
    )
    let block = createBlockFromRPC(infura2000004withTransactionsData, [], {
      common,
      setHardfork: true,
    })
    assert.strictEqual(
      bytesToHex(keccak_256(RLP.encode(block.header.raw().slice(0, 15)))),
      infura2000004withTransactionsData.hash,
      'created premerge block with txns',
    )
    const newHeader = createBlockHeaderFromRPC(infura15571241Data, {
      common,
      setHardfork: true,
    })
    assert.strictEqual(
      bytesToHex(newHeader.hash()),
      infura15571241Data.hash,
      'created post merge block without txns',
    )

    block = createBlockFromRPC(infura15571241withTransactionsData, [], {
      common,
      setHardfork: true,
    })
    assert.strictEqual(
      bytesToHex(block.hash()),
      infura15571241withTransactionsData.hash,
      'created post merge block with txns',
    )
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('[fromJSONRPCProvider]', () => {
  it('should work', async () => {
    const common = createCustomCommon({ chainId: 1 }, TronMainnet)
    const provider = 'https://rpc.invalid'
    const blockHash = infura15571241withTransactionsData.hash
    const mock = vi.fn(async (_url: unknown, req: RequestInit) => {
      const { method, params } = JSON.parse(req.body as string)
      expect(method).toBe('eth_getBlockByHash')
      expect(params[1]).toBe(true)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: params[0] === blockHash ? infura15571241withTransactionsData : null,
        }),
      }
    })
    vi.stubGlobal('fetch', mock)
    const block = await createBlockFromJSONRPCProvider(provider, blockHash, { common })
    expect(bytesToHex(block.hash())).toBe(blockHash)
    await expect(
      createBlockFromJSONRPCProvider(provider, `0x${'ff'.repeat(32)}`, { common }),
    ).rejects.toThrow('No block data returned from provider')
    expect(mock).toHaveBeenCalledTimes(2)
  })
})

describe.each([TronMainnet, TronNile, TronShasta])('TRON RPC containers on $name', (chain) => {
  it('preserves the actual signer and large Token ID through RPC', async () => {
    const common = new Common({ chain })
    const original = await signedBlock(common)
    const h = original.header.toJSON()
    const rpc = {
      ...testdataFromRPCData,
      ...h,
      sha3Uncles: h.uncleHash,
      miner: h.coinbase,
      transactionsRoot: h.transactionsTrie,
      receiptsRoot: h.receiptTrie,
      hash: bytesToHex(original.hash()),
      uncles: [],
      transactions: original.transactions.map((tx, index) => ({
        ...tx.toJSON(),
        gas: tx.toJSON().gasLimit!,
        input: tx.toJSON().data!,
        blockHash: bytesToHex(original.hash()),
        blockNumber: h.number!,
        from: tx.getSenderAddress().toString(),
        hash: bytesToHex(tx.hash()),
        transactionIndex: `0x${index.toString(16)}`,
      })),
    } as JSONRPCBlock
    const restored = createBlockFromRPC(rpc, [], { common })
    expect(restored.serialize()).toEqual(original.serialize())
    expect(restored.transactions[0].getSenderAddress()).toEqual(
      createAddressFromPrivateKey(signingKey),
    )
    expect(restored.transactions[0].toJSON()).toMatchObject({
      tokenId: '0x20000000000001',
      tokenValue: '0x7',
    })
    await expect(restored.validateData()).resolves.toBeUndefined()
  })

  it('preserves decimal difficulty above the JavaScript safe integer range', () => {
    const common = new Common({ chain })
    for (const difficulty of [
      '9007199254740992',
      '9007199254740993',
      '9223372036854775807',
    ] as const) {
      const header = createBlockHeaderFromRPC({ ...testdataFromRPCData, difficulty }, { common })
      expect(header.difficulty).toBe(BigInt(difficulty))
    }
  })
})
