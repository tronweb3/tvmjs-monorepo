import { Common, TronMainnet, TronNile, TronShasta, parseGethGenesisState } from '@tvmjs/common'
import { genesisMPTStateRoot } from '@tvmjs/mpt'
import { postMergeGethGenesis } from '@tvmjs/testdata'
import { bytesToHex } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createBlockchain } from '../src/index.ts'

describe('[Utils/Parse]', () => {
  it('should properly parse genesis state from gethGenesis', async () => {
    const genesisState = parseGethGenesisState(postMergeGethGenesis)
    const stateRoot = await genesisMPTStateRoot(genesisState)
    assert.strictEqual(
      bytesToHex(stateRoot),
      '0x1e39548b7c454d2077df14e898d4b0cda4359367afec3043b1ec46ea8c236912',
      'stateRoot matches',
    )
  })

  for (const chain of [TronMainnet, TronNile, TronShasta]) {
    it(`${chain.name}: imports allocations with explicit local genesis metadata`, async () => {
      // Local execution metadata, not the network's canonical genesis block.
      const common = new Common({
        chain: {
          ...chain,
          genesis: {
            gasLimit: 1000000,
            difficulty: 0,
            nonce: '0x0000000000000000',
            extraData: '0x',
          },
        },
      })
      const genesisState = parseGethGenesisState(postMergeGethGenesis)
      const blockchain = await createBlockchain({ common, genesisState })
      assert.strictEqual(
        bytesToHex(blockchain.genesisBlock.header.stateRoot),
        '0x1e39548b7c454d2077df14e898d4b0cda4359367afec3043b1ec46ea8c236912',
      )
      assert.strictEqual(blockchain.genesisBlock.header.gasLimit, 1000000n)
      assert.deepEqual((await blockchain.getBlock(0n)).hash(), blockchain.genesisBlock.hash())
      assert.isFalse(common.hasConsensus())
      assert.isUndefined(blockchain.consensus)
    })
  }
})
