import type { Chain } from '@tvmjs/common'
import { ChainGenesis } from '@tvmjs/common'
import { assert, describe, it } from 'vitest'

import { getGenesis } from '../src/index.ts'

describe('genesis test', () => {
  it('tests getGenesis', async () => {
    const chainIds = Object.keys(ChainGenesis)
    for (const chainId of chainIds) {
      const { name } = ChainGenesis[chainId as unknown as Chain]

      const genesisState = getGenesis(Number(chainId))
      assert.isDefined(genesisState, `network=${name} chainId=${chainId} genesis should be found`)
    }
  })
})
