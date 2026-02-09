import {
  MIN_TOKEN_ID,
  bytesToHex,
  createAccount,
  createAddressFromPrivateKey,
  createAddressFromString,
  hexToBytes,
  toBytes,
} from '@tvmjs/util'
import { utils } from 'tronweb'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import { PK, compileSol, deployContract, getAccount, trigger, triggerConstant } from './utils.ts'

import { keccak_256 } from '@noble/hashes/sha3.js'
import type { Address } from '@tvmjs/util'
import { encodeParamsV2ByABI, stringToBytes } from 'tronweb/utils'
import type { VM } from '../../../src/vm.ts'
import { setBalance } from '../utils.ts'

const OWNER_ADDRESS = createAddressFromPrivateKey(hexToBytes(PK))

async function createAsset(vm: VM, to: Address, tokenId: bigint, amount = 100_000_000n) {
  await vm.stateManager.checkpoint()
  const account = (await vm.stateManager.getAccount(to)) ?? createAccount({})
  account.asset = {
    [Number(tokenId)]: amount,
  }
  vm.stateManager.putAccount(to, account)
  await vm.stateManager.commit()
}

describe('TransferTokenTest', async () => {
  /**
   * pragma solidity ^0.4.24;
   * contract tokenTest{ constructor() public payable{} // positive case function
   * TransferTokenTo(address toAddress, trcToken id,uint256 amount) public payable{
   * toAddress.transferToken(amount,id); } function suicide(address toAddress) payable public{
   * selfdestruct(toAddress); } function get(trcToken trc) public payable returns(uint256){ return
   * address(this).tokenBalance(trc); } }
   * 1. deploy 2. trigger and internal transaction 3. suicide (all token)
   */
  it('TransferTokenTest', async () => {
    const vm = await createVM()
    const tokenId = MIN_TOKEN_ID + 1n
    await setBalance(vm, OWNER_ADDRESS, 100_000_000_000n)
    await createAsset(vm, OWNER_ADDRESS, tokenId)

    const bytecode =
      '608060405261015a806100136000396000f3006080604052600436106100565763ffffffff7c0100000000000' +
      '0000000000000000000000000000000000000000000006000350416633be9ece7811461005b578063a1' +
      '24249714610084578063dbc1f226146100a1575b600080fd5b61008273fffffffffffffffffffffffff' +
      'fffffffffffffff600435166024356044356100c2565b005b61008f60043561010f565b604080519182' +
      '52519081900360200190f35b61008273ffffffffffffffffffffffffffffffffffffffff60043516610' +
      '115565b60405173ffffffffffffffffffffffffffffffffffffffff84169082156108fc029083908590' +
      '600081818185878a8ad0945050505050158015610109573d6000803e3d6000fd5b50505050565b3090d' +
      '190565b8073ffffffffffffffffffffffffffffffffffffffff16ff00a165627a7a72305820c62df6f4' +
      '5add5e57b59db51d6f6ab609564554aed5e9c958621f9c5e085a510b0029'

    const contractAddress = (await deployContract(
      vm,
      {
        bytecode: hexToBytes(`0x${bytecode}`),
        caller: OWNER_ADDRESS,
        value: 1000n,
        tokenId,
        tokenValue: 100n,
      },
      {
        skipBalance: true,
      },
    )) as Address

    const contractAccount = await getAccount(vm, contractAddress)
    assert.equal(contractAccount?.balance, 1000n)
    assert.equal(contractAccount?.asset![Number(tokenId)], 100n)

    const abiItem = {
      type: 'function',
      name: 'TransferTokenTo',
      stateMutability: 'payable',
      inputs: [
        {
          type: 'address',
          name: 'toAddress',
        },
        {
          type: 'uint256',
          name: 'id',
        },
        {
          type: 'uint256',
          name: 'amount',
        },
      ],
      outputs: [],
    }

    const toAccount = utils.accounts.generateAccount()
    const toTvmAddress = createAddressFromString(
      toAccount.address.hex.replace(utils.constants.ADDRESS_PREFIX_REGEX, '0x'),
    )
    const sendValue = 100n
    const sendTokenValue = 8n
    const input = (() => {
      const selector = bytesToHex(
        keccak_256(new Uint8Array(stringToBytes('TransferTokenTo(address,trcToken,uint256)'))),
      ).substring(2, 10)
      const parameter = encodeParamsV2ByABI(abiItem, [toTvmAddress.toString(), tokenId, 9n])
      return `0x${selector}${parameter.replace(/^0x/, '')}`
    })()
    // setBalance(vm, toTvmAddress, 100n)
    await trigger(vm, {
      contractAddress,
      input,
      caller: OWNER_ADDRESS,
      tokenId,
      tokenValue: sendTokenValue,
      value: sendValue,
    })

    const contractAccount2 = await getAccount(vm, contractAddress)
    assert.equal(contractAccount2?.asset![Number(tokenId)], 100n + sendTokenValue - 9n)

    const toTvmAccount = await getAccount(vm, toTvmAddress)
    console.log(
      'actual account',
      toTvmAddress.toString(),
      bytesToHex(keccak_256(toTvmAddress.bytes)),
      tokenId,
      toTvmAccount?.asset,
    )
    assert.equal(toTvmAccount?.asset![Number(tokenId)], 9n)
  })
})
