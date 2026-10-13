import { cliqueSigner, createBlock, createSealedCliqueBlock } from '@tvmjs/block'
import { SIGNER_A, SIGNER_B } from '@tvmjs/testdata'
import { Address, concatBytes } from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import { CLIQUE_NONCE_AUTH, CLIQUE_NONCE_DROP, CliqueConsensus } from '../src/consensus/clique.ts'
import { createBlockchain } from '../src/index.ts'
import { cliqueCommon, powCommon } from './util.ts'

import type { Block } from '@tvmjs/block'
import type { Signer } from '@tvmjs/testdata'

describe('reorg tests', () => {
  it('reorgs to a shorter chain with higher total difficulty when consensus metadata is explicit', async () => {
    const common = powCommon()
    const genesisBlock = createBlock({ header: { gasLimit: 8000000n } }, { common })
    // This tests stored fork choice, not Ethash proof verification.
    const blockchain = await createBlockchain({
      common,
      genesisBlock,
      validateBlocks: true,
      validateConsensus: false,
    })
    const child = (parent: Block, difficulty: bigint, timestampOffset = 1n) =>
      createBlock(
        {
          header: {
            number: parent.header.number + 1n,
            parentHash: parent.hash(),
            timestamp: parent.header.timestamp + timestampOffset,
            gasLimit: parent.header.gasLimit,
            baseFeePerGas: parent.header.calcNextBaseFee(),
            difficulty,
          },
        },
        { common },
      )
    const low = [child(genesisBlock, 1n)]
    low.push(child(low[0], 1n), child(genesisBlock, 10n, 2n))
    await blockchain.putBlocks(low.slice(0, 2))
    expect((await blockchain.getCanonicalHeadBlock()).hash()).toEqual(low[1].hash())
    await blockchain.putBlock(low[2])
    expect((await blockchain.getCanonicalHeadBlock()).hash()).toEqual(low[2].hash())
    expect((await blockchain.getCanonicalHeadHeader()).number).toBe(1n)
    expect(await blockchain.getTotalDifficulty(low[2].hash())).toBe(10n)
    await expect(blockchain.getBlock(2n)).rejects.toThrow('not found in DB')
    expect((await blockchain.getBlock(low[1].hash())).hash()).toEqual(low[1].hash())
  })

  it('should correctly reorg a poa chain and remove blocks from clique snapshots', async () => {
    const common = cliqueCommon()
    const extraData = concatBytes(
      new Uint8Array(32),
      SIGNER_A.address.toBytes(),
      SIGNER_B.address.toBytes(),
      new Uint8Array(65),
    )
    const genesisBlock = createBlock({ header: { extraData, gasLimit: 8000000n } }, { common })
    const consensus = new CliqueConsensus()
    // Snapshot rollback is isolated here; the voting suite checks consensus validation.
    const blockchain = await createBlockchain({
      common,
      genesisBlock,
      consensusDict: { clique: consensus },
      validateBlocks: false,
      validateConsensus: false,
    })
    const beneficiary1 = new Address(new Uint8Array(20).fill(1))
    const beneficiary2 = new Address(new Uint8Array(20).fill(2))
    const child = (parent: Block, signer: Signer, timestampOffset: bigint, beneficiary?: Address) =>
      createSealedCliqueBlock(
        {
          header: {
            number: parent.header.number + 1n,
            parentHash: parent.hash(),
            timestamp: parent.header.timestamp + timestampOffset,
            gasLimit: parent.header.gasLimit,
            baseFeePerGas: parent.header.calcNextBaseFee(),
            extraData: new Uint8Array(97),
            difficulty: 1n,
            nonce: beneficiary ? CLIQUE_NONCE_AUTH : CLIQUE_NONCE_DROP,
            coinbase: beneficiary,
          },
        },
        signer.privateKey,
        { common },
      )

    const firstLow = child(genesisBlock, SIGNER_A, 30n, beneficiary1)
    const secondLow = child(firstLow, SIGNER_B, 30n, beneficiary1)
    await blockchain.putBlocks([firstLow, secondLow])
    assert.isTrue(consensus.cliqueActiveSigners(3n).some((address) => address.equals(beneficiary1)))
    assert.deepEqual((await blockchain.getCanonicalHeadBlock()).hash(), secondLow.hash())

    const firstHigh = child(genesisBlock, SIGNER_B, 15n, beneficiary2)
    const secondHigh = child(firstHigh, SIGNER_A, 15n, beneficiary2)
    const thirdHigh = child(secondHigh, SIGNER_B, 15n)
    await blockchain.putBlocks([firstHigh, secondHigh, thirdHigh])
    assert.deepEqual((await blockchain.getCanonicalHeadBlock()).hash(), thirdHigh.hash())
    assert.isFalse(
      consensus.cliqueActiveSigners(4n).some((address) => address.equals(beneficiary1)),
    )
    assert.isTrue(consensus.cliqueActiveSigners(4n).some((address) => address.equals(beneficiary2)))
    assert.isUndefined(
      consensus._cliqueLatestSignerStates.find(
        ([height, signers]) =>
          height === 2n && signers.some((address) => address.equals(beneficiary1)),
      ),
    )
    assert.isUndefined(consensus._cliqueLatestVotes.find((vote) => vote[1][1].equals(beneficiary1)))
    assert.isUndefined(
      consensus._cliqueLatestBlockSigners.find(
        ([height, signer]) => height === 1n && signer.equals(cliqueSigner(firstLow.header)),
      ),
    )
    assert.isDefined(
      consensus._cliqueLatestBlockSigners.find(
        ([height, signer]) => height === 3n && signer.equals(cliqueSigner(thirdHigh.header)),
      ),
    )
  })
})
