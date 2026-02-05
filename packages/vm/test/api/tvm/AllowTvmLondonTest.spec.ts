import type { Address } from '@tvmjs/util'
import { createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import { PK, deployContract, triggerConstant } from './utils.ts'

const OWNER_ADDRESS = createAddressFromPrivateKey(hexToBytes(PK))

describe('AllowTvmLondonTest', () => {
  /*contract c {

    function getbasefee() public returns(uint) {
      return block.basefee;
    }

  }*/
  it('testBaseFee', async () => {
    const address = OWNER_ADDRESS
    const abi = JSON.parse(
      '[{"inputs":[],"name":"getbasefee",' +
        '"outputs":[{"internalType":"uint256","name":"","type":"uint256"}],' +
        '"stateMutability":"view","type":"function"}]',
    )
    const bytecode =
      '6080604052348015600f57600080fd5b50607680' +
      '601d6000396000f3fe6080604052348015600f57600080fd5b5060043' +
      '61060285760003560e01c80632266bff614602d575b600080fd5b4860' +
      '405190815260200160405180910390f3fea2646970667358221220091' +
      'a527d7e484183e543b1ba4520176c089c72f6f3451d8419a19b363314' +
      '674a64736f6c63430008070033'

    const vm = await createVM({})

    const contractAddress = (await deployContract(vm, {
      caller: address,
      bytecode: hexToBytes(`0x${bytecode}`),
    })) as Address

    const result = await triggerConstant(vm, {
      caller: address,
      contractAddress,
      abi: abi[0],
    })

    // @TODO TRON block.basefee
    assert.equal(
      JSON.stringify(result, (_, obj: any) => (typeof obj === 'bigint' ? obj.toString() : obj)),
      JSON.stringify(['7']),
    )
  })
})
