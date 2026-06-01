import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { KECCAK256_RLP } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import type { MerkleStateManager } from '@tvmjs/statemanager'
import { createVM } from '../../../src/index.ts'

describe('General MuirGlacier VM tests', () => {
  it('should accept muirGlacier hardfork option for supported chains', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.MuirGlacier })
    const vm = await createVM({ common })
    assert.isDefined(vm.stateManager)
    assert.deepEqual(
      (vm.stateManager as MerkleStateManager)['_trie'].root(),
      KECCAK256_RLP,
      'it has default trie',
    )
  })
})
