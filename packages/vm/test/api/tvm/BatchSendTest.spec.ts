import type { Address } from '@tvmjs/util'
import { createAddressFromPrivateKey, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { utils } from 'tronweb'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import { PK, deployContract, trigger } from './utils.ts'

const OWNER_ADDRESS = createAddressFromPrivateKey(hexToBytes(PK))

describe('BatchSendTest', async () => {
  /**
   * pragma solidity ^0.5.4;
   * contract TestBatchSendTo { constructor() public payable{}
   * function depositIn() public payable{}
   * function batchSendTo (address  payable to1 ,address  payable to2 ,address  payable to3, uint256
   * m1,uint256 m2,uint256 m3) public { to1.send(m1 ); to2.send(m2 ); to3.send(m3 ); }
   * }
   */
  it('TransferTokenTest', async () => {
    const address = OWNER_ADDRESS
    const bytecode =
      '608060405261019c806100136000396000f3fe608060405260043610610045577c0100000000000' +
      '00000000000000000000000000000000000000000000060003504632a205edf811461004a5780634cd2270c' +
      '146100c8575b600080fd5b34801561005657600080fd5b50d3801561006357600080fd5b50d2801561007057' +
      '600080fd5b506100c6600480360360c081101561008757600080fd5b5073ffffffffffffffffffffffffffff' +
      'ffffffffffff813581169160208101358216916040820135169060608101359060808101359060a001356100' +
      'd0565b005b6100c661016e565b60405173ffffffffffffffffffffffffffffffffffffffff87169084156108' +
      'fc029085906000818181858888f1505060405173ffffffffffffffffffffffffffffffffffffffff89169350' +
      '85156108fc0292508591506000818181858888f1505060405173ffffffffffffffffffffffffffffffffffff' +
      'ffff8816935084156108fc0292508491506000818181858888f15050505050505050505050565b56fea16562' +
      '7a7a72305820cc2d598d1b3f968bbdc7825ce83d22dad48192f4bf95bda7f9e4ddf61669ba830029'

    const vm = await createVM({})
    const value = 1000n

    const contractAddress = (await deployContract(vm, {
      caller: address,
      bytecode: hexToBytes(`0x${bytecode}`),
      value,
    })) as Address

    const abi = JSON.parse(
      '[{"inputs":[],"stateMutability":"payable","type":"constructor"},' +
        '{"inputs":[],"name":"depositIn","outputs":[],"stateMutability":"payable","type":"function"},' +
        '{"inputs":[{"internalType":"address payable","name":"to1","type":"address"},' +
        '{"internalType":"address payable","name":"to2","type":"address"},' +
        '{"internalType":"address payable","name":"to3","type":"address"},' +
        '{"internalType":"uint256","name":"m1","type":"uint256"},' +
        '{"internalType":"uint256","name":"m2","type":"uint256"},' +
        '{"internalType":"uint256","name":"m3","type":"uint256"}],' +
        '"name":"batchSendTo","outputs":[],"stateMutability":"nonpayable","type":"function"}]',
    )

    const address1 = utils.accounts
      .generateAccount()
      .address.hex.replace(utils.constants.ADDRESS_PREFIX_REGEX, '0x')
    const address2 = utils.accounts
      .generateAccount()
      .address.hex.replace(utils.constants.ADDRESS_PREFIX_REGEX, '0x')
    const address3 = utils.accounts
      .generateAccount()
      .address.hex.replace(utils.constants.ADDRESS_PREFIX_REGEX, '0x')
    await trigger(vm, {
      caller: address,
      contractAddress,
      abi: abi[2],
      params: [address1, address2, address3, 100n, 1100n, 200n],
    })
    const account1 = await vm.stateManager.getAccount(createAddressFromString(address1))
    const account2 = await vm.stateManager.getAccount(createAddressFromString(address2))
    const account3 = await vm.stateManager.getAccount(createAddressFromString(address3))

    assert.equal(account1!.balance, 100n)
    assert.equal(account2, undefined)
    assert.equal(account3!.balance, 200n)
  })
})
