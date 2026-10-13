import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { createAddressFromString, equalsBytes, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { MerkleStateManager, StatefulBinaryTreeStateManager } from '../src/index.ts'

import { biggestContractEverData } from './testdata/biggestContractEver.ts'

import type { PrefixedHexString } from '@tvmjs/util'

describe.each([TronMainnet, TronNile, TronShasta])('StateManager profile on $name', (chain) => {
  it.each([6800, 7864])('rejects activation of EIP-%s', (eip) => {
    const common = new Common({ chain })
    assert.isFalse(common.isActivatedEIP(eip))
    assert.throws(() => common.setEIPs([eip]), /not supported/)
    assert.isFalse(common.isActivatedEIP(eip))
    assert.throws(() => new Common({ chain, eips: [eip] }), /not supported/)
  })

  it('rejects Binary Tree execution with a TRON Common', () => {
    const common = new Common({ chain })
    assert.throws(
      () => new StatefulBinaryTreeStateManager({ common }),
      'EIP-7864 required for binary tree state management',
    )
  })

  it('preserves the large bytecode fixture as Merkle state data', async () => {
    const common = new Common({ chain })
    const state = new MerkleStateManager({ common })
    const address = createAddressFromString('0x9e5ef720fa2cdfa5291eb7e711cfd2e62196f4b3')
    const code = hexToBytes(biggestContractEverData.bytecode as PrefixedHexString)
    await state.putCode(address, code)
    await state.flush()
    state.clearCaches()
    assert.isTrue(equalsBytes(await state.getCode(address), code))
    assert.strictEqual(await state.getCodeSize(address), code.length)
    assert.isFalse(common.isActivatedEIP(7864))
  })
})
