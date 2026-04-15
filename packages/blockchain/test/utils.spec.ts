import { type GethGenesis, createCommonFromGethGenesis, parseGethGenesisState } from '@tvmjs/common'
import { genesisMPTStateRoot } from '@tvmjs/mpt'
import { postMergeGethGenesis } from '@tvmjs/testdata'
import { bytesToHex } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createBlockchain } from '../src/index.ts'

import type { Blockchain } from '../src/blockchain.ts'

async function getBlockchain(gethGenesis: GethGenesis): Promise<Blockchain> {
  const common = createCommonFromGethGenesis(gethGenesis, { chain: 'kiln' })
  const genesisState = parseGethGenesisState(gethGenesis)
  const blockchain = await createBlockchain({
    genesisState,
    common,
  })
  return blockchain
}

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

  it('should initialize blockchain from gethGenesis', async () => {
    const blockchain = await getBlockchain(postMergeGethGenesis)
    const genesisHash = blockchain.genesisBlock.hash()

    assert.strictEqual(
      bytesToHex(genesisHash),
      '0x35c2c2f4056b3bae4069bd6d889f1600a415bbe5e350f62fa90923108571b7be',
      'genesis hash matches',
    )
  })
})
