import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { bytesToBigInt, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/index.ts'

describe.each([TronMainnet, TronNile, TronShasta])('CHAINID on $name', (chain) => {
  it('returns the complete chain ID in a 32-byte word', async () => {
    const vm = await createVM({ common: new Common({ chain, activatedProposals: [] }) })
    const result = await vm.tvm.runCode({
      code: hexToBytes('0x4660005260206000f3'),
      gasLimit: 100n,
    })
    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.returnValue.length, 32)
    assert.strictEqual(bytesToBigInt(result.returnValue), BigInt(chain.chainId))
    assert.strictEqual(result.executionGasUsed, 14n)
  })
})
