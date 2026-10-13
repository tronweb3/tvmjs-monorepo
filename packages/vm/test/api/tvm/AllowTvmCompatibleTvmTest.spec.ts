import type { Address } from '@tvmjs/util'
import { createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createVM } from '../../../src/constructors.ts'
import { PK, deployContract, triggerConstant } from './utils.ts'

const OWNER_ADDRESS = createAddressFromPrivateKey(hexToBytes(PK))

describe('AllowTvmCompatibleTvmTest', () => {
  it('testTxGasPrice', async () => {
    // const contractName = 'testTxGasPrice'
    const address = OWNER_ADDRESS
    const abi = JSON.parse(
      '[{"inputs":[],"name":"getprice",' +
        '"outputs":[{"internalType":"uint256","name":"","type":"uint256"}],' +
        '"stateMutability":"view","type":"function"}]',
    )
    const bytecode =
      '6080604052348015600f57600080fd5b50607680601d' +
      '6000396000f3fe6080604052348015600f57600080fd5b506004361060285' +
      '760003560e01c80630fcb598414602d575b600080fd5b3a60405190815260' +
      '200160405180910390f3fea2646970667358221220ee994af43fb1d2a4594' +
      'ae1355099296fc098d01a7dbe9056530031db6fb9b9c464736f6c63430008070033'
    const value = 0n
    const feeLimit = 100000000n

    const vm = await createVM({})

    const contractAddress = (await deployContract(vm, {
      caller: address,
      bytecode: hexToBytes(`0x${bytecode}`),
      gasLimit: feeLimit,
      value,
    })) as Address

    const result = await triggerConstant(vm, {
      contractAddress,
      caller: address,
      abi: abi[0],
    })

    // @TODO TRON tx.gasprice is always 0
    assert.equal(
      JSON.stringify(result, (_, obj: any) => (typeof obj === 'bigint' ? obj.toString() : obj)),
      JSON.stringify(['100']),
    )
  })

  it('testChainId', async () => {
    const address = OWNER_ADDRESS
    const abi = [
      {
        type: 'function',
        name: 'getChainId',
        inputs: [],
        outputs: [
          {
            type: 'uint256',
            name: '',
          },
        ],
        stateMutability: 'view',
      },
    ]
    const bytecode =
      '608060405234801561001057600080fd5b5060b58061001f6000' +
      '396000f3fe6080604052348015600f57600080fd5b506004361060285760003560e01c' +
      '80633408e47014602d575b600080fd5b60336047565b604051603e9190605c565b6040' +
      '5180910390f35b600046905090565b6056816075565b82525050565b60006020820190' +
      '50606f6000830184604f565b92915050565b600081905091905056fea2646970667358' +
      '2212203ccbe28f012f703b4369308e34d6dfc1a89a5f51e3ea42d531fcf3a2dba31150' +
      '64736f6c63430008070033'
    const feeLimit = 100_000_000n

    const vm = await createVM({})

    const contractAddress = (await deployContract(vm, {
      caller: address,
      bytecode: hexToBytes(`0x${bytecode}`),
      gasLimit: feeLimit,
    })) as Address

    const result = await triggerConstant(vm, {
      contractAddress,
      caller: address,
      abi: abi[0],
    })

    assert.equal(
      JSON.stringify(result, (_, obj: any) => (typeof obj === 'bigint' ? obj.toString() : obj)),
      JSON.stringify(['728126428']),
    )
  })
})
