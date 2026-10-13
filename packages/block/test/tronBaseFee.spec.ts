import {
  Common,
  ConsensusAlgorithm,
  ConsensusType,
  TronMainnet,
  TronNile,
  TronShasta,
} from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import { createFeeMarket1559Tx } from '@tvmjs/tx'
import { bytesToHex, createZeroAddress, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import {
  createBlock,
  createBlockFromRLP,
  createBlockHeader,
  createBlockHeaderFromBytesArray,
  createBlockHeaderFromRLP,
} from '../src/index.ts'
import { eip1559baseFeeData } from './testdata/eip1559baseFee.ts'

describe.each([TronMainnet, TronNile, TronShasta])('TRON base fee container on $name', (chain) => {
  it('keeps the default fee and ordinary extra data at former Ethereum fork heights', () => {
    const common = new Common({ chain })
    for (const number of [0n, 1n, 1920000n, 1920009n, 12965000n]) {
      const header = createBlockHeader(
        { number, gasLimit: 1000000n, extraData: '0x1234' },
        { common },
      )
      assert.strictEqual(header.baseFeePerGas, 7n)
      assert.strictEqual(bytesToHex(header.extraData), '0x1234')
      assert.strictEqual(header.raw().length, 16)
      assert.deepEqual(
        createBlockHeaderFromRLP(header.serialize(), { common }).hash(),
        header.hash(),
      )
    }
    const header = createBlockHeader(
      { number: 12965000n, gasLimit: 1000000n, extraData: '0x1234' },
      { common },
    )
    // Recorded from the committed pre-cleanup implementation.
    assert.strictEqual(
      bytesToHex(header.hash()),
      '0x51aaedf37601e6942a9d46a2717a2db12a741b0254b36bf3c54a819737c87a0e',
    )
  })

  it('preserves explicitly supplied fees including zero', () => {
    const common = new Common({ chain })
    for (const fee of [0n, 5n, 100n, 1000000000n]) {
      const header = createBlockHeader({ number: 12965000n, baseFeePerGas: fee }, { common })
      assert.strictEqual(header.baseFeePerGas, fee)
      assert.strictEqual(header.toJSON().baseFeePerGas, `0x${fee.toString(16)}`)
      assert.strictEqual(
        createBlockHeaderFromRLP(header.serialize(), { common }).baseFeePerGas,
        fee,
      )
    }
  })

  it('requires a base fee field in serialized headers at every height', () => {
    const common = new Common({ chain })
    for (const number of [0n, 1n, 1920000n, 12965000n]) {
      const header = createBlockHeader({ number }, { common })
      const raw = header.raw().slice(0, 15)
      const error = /baseFeePerGas should be provided/
      assert.throws(() => createBlockHeaderFromBytesArray(raw, { common }), error)
      assert.throws(() => createBlockHeaderFromRLP(RLP.encode(raw), { common }), error)
      assert.throws(() => createBlockFromRLP(RLP.encode([raw, [], []]), { common }), error)
    }
  })

  it('enforces gas usage and ordinary parent gas-limit bounds without doubling', () => {
    const common = new Common({ chain })
    const parent = createBlockHeader({ number: 12964999n, gasLimit: 1000000n }, { common })
    for (const gasLimit of [999025n, 1000000n, 1000975n]) {
      const header = createBlockHeader(
        { number: 12965000n, gasLimit, gasUsed: gasLimit },
        { common },
      )
      assert.doesNotThrow(() => header.validateGasLimit(parent))
    }
    for (const gasLimit of [1000976n, 2000000n]) {
      const header = createBlockHeader({ number: 12965000n, gasLimit }, { common })
      assert.throws(() => header.validateGasLimit(parent), /gas limit increased too much/)
    }
    const lower = createBlockHeader({ number: 12965000n, gasLimit: 999024n }, { common })
    assert.throws(() => lower.validateGasLimit(parent), /gas limit decreased too much/)
    assert.throws(
      () => createBlockHeader({ gasLimit: 1000000n, gasUsed: 1000001n }, { common }),
      /too much gas used/,
    )
  })

  it('retains all base-fee arithmetic vectors from the former EIP-1559 suite', () => {
    const common = new Common({ chain })
    for (const vector of eip1559baseFeeData) {
      const header = createBlockHeader(
        {
          baseFeePerGas: BigInt(vector.parentBaseFee),
          gasUsed: BigInt(vector.parentGasUsed),
          gasLimit: BigInt(vector.parentTargetGasUsed) * 2n,
        },
        { common },
      )
      assert.strictEqual(header.calcNextBaseFee(), BigInt(vector.expectedBaseFee))
    }
  })

  it('retains the public Ethash difficulty helper for explicitly supplied consensus metadata', () => {
    const common = new Common({
      chain: {
        ...chain,
        consensus: {
          type: ConsensusType.ProofOfWork,
          algorithm: ConsensusAlgorithm.Ethash,
          ethash: {},
        },
      },
    })
    const parent = createBlockHeader({ difficulty: 131072n, timestamp: 1n }, { common })
    const child = createBlockHeader({ number: 1n, timestamp: 2n }, { common })
    assert.strictEqual(child.ethashCanonicalDifficulty(parent), 131136n)
    assert.throws(
      () =>
        createBlockHeader({}, { common: new Common({ chain }) }).ethashCanonicalDifficulty(parent),
      /Consensus metadata is not available/,
    )
  })

  it('rejects a signed transaction whose fee cannot cover the block base fee', () => {
    const common = new Common({ chain })
    const tx = createFeeMarket1559Tx(
      { to: createZeroAddress(), gasLimit: 21000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
      { common },
    ).sign(hexToBytes(`0x${'46'.repeat(32)}`))
    const block = createBlock(
      { header: { number: 1n, baseFeePerGas: 7n }, transactions: [tx] },
      { common },
    )
    assert.include(block.getTransactionsValidationErrors()[0], 'unable to pay base fee')
  })
})
