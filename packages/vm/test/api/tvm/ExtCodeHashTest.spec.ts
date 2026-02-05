import type { Address } from '@tvmjs/util'
import { createAddressFromPrivateKey, hexToBigInt, hexToBytes } from '@tvmjs/util'
import { utils } from 'tronweb'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import { PK, deployContract, triggerConstant } from './utils.ts'

const OWNER_ADDRESS = createAddressFromPrivateKey(hexToBytes(PK))

describe('ExtCodeHashTest', async () => {
  it('testExtCodeHash', async () => {
    const address = OWNER_ADDRESS
    const abi = JSON.parse(
      '[{"constant":true,"inputs":[{"name":"_addr","type":"uint256"}],' +
        '"name":"getCodeHashByUint","outputs":[{"name":"_hash","type":"bytes32"}],' +
        '"payable":false,"stateMutability":"view","type":"function"},{"constant":true' +
        ',"inputs":[{"name":"_addr","type":"address"}],"name":"getCodeHashByAddr",' +
        '"outputs":[{"name":"_hash","type":"bytes32"}],"payable":false,' +
        '"stateMutability":"view","type":"function"}]',
    )
    const bytecode =
      '608060405234801561001057600080fd5b5061010d806100206000396000f3fe608060405' +
      '2348015600f57600080fd5b506004361060325760003560e01c80637b77fd191460375780637d5e422d14607' +
      '6575b600080fd5b606060048036036020811015604b57600080fd5b810190808035906020019092919050505' +
      '060cb565b6040518082815260200191505060405180910390f35b60b560048036036020811015608a5760008' +
      '0fd5b81019080803573ffffffffffffffffffffffffffffffffffffffff16906020019092919050505060d65' +
      '65b6040518082815260200191505060405180910390f35b6000813f9050919050565b6000813f90509190505' +
      '6fea165627a7a723058200f30933f006db4e1adeee12c030b87e720dad3cb169769159fc56ec25d9af66f00' +
      '29'

    const vm = await createVM()
    const contractAddress = (await deployContract(vm, {
      caller: address,
      bytecode: hexToBytes(`0x${bytecode}`),
    })) as Address

    const abiItem = abi.find((item: any) => item.name === 'getCodeHashByAddr')

    const nonexistentAddress = utils.address
      .toHex('27k66nycZATHzBasFT9782nTsYWqVtxdtAc')
      .replace(/^a0/, '0x')
    const result = await triggerConstant(vm, {
      caller: address,
      abi: abiItem,
      contractAddress,
      params: [nonexistentAddress],
    })
    assert.equal(result[0], '0x' + '0'.repeat(64))

    const existentAddress = address.toString()
    const result2 = await triggerConstant(vm, {
      caller: address,
      abi: abiItem,
      contractAddress,
      params: [existentAddress],
    })
    assert.equal(result2[0], '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')

    const abiItem2 = abi.find((item: any) => item.name === 'getCodeHashByUint')
    const result3 = await triggerConstant(vm, {
      caller: address,
      abi: abiItem2,
      contractAddress,
      params: [hexToBigInt(contractAddress.toString())],
    })
    assert(result3[0], '0x0837cd5e284138b633cd976ea6fcb719d61d7bc33d946ec5a2d0c7da419a0bd4')
  })
})
