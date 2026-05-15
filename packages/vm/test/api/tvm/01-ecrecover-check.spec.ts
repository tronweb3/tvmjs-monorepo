import {
  type Address,
  type PrefixedHexString,
  createAddressFromString,
  hexToBytes,
} from '@tvmjs/util'
import { utils } from 'tronweb'
import { assert, beforeAll, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import type { VM } from '../../../src/vm.ts'
import { compileSol, deployContract, triggerConstant } from './utils.ts'

describe('EcrecoverCheck contract: check() returns recovered address when CALLER matches', () => {
  let contractAddress
  let owner: ReturnType<typeof utils.accounts.generateAccount>
  let abi: any[]
  let vm: VM
  beforeAll(async () => {
    const { bytecode, abi: abiInner } = await compileSol('ecrecover001.sol', 'EcrecoverCheck')
    abi = abiInner
    owner = utils.accounts.generateAccount()
    vm = await createVM()
    contractAddress = (await deployContract(vm, {
      bytecode: hexToBytes(`0x${bytecode}`),
      caller: createAddressFromString(owner.address.hex.replace(/^41/, '0x') as PrefixedHexString),
      gasLimit: 5_000_000n,
    })) as Address
  })

  it('returns the recovered address and does not revert', async () => {
    const msg = 'hello'
    const signature = utils.message.signMessage(msg, owner.privateKey)
    const result = await triggerConstant(vm, {
      caller: createAddressFromString(owner.address.hex.replace(/^41/, '0x') as PrefixedHexString),
      contractAddress: contractAddress!,
      abi: abi.find((item: any) => item.name === 'check'),
      params: [
        utils.message.hashMessage(msg),
        `0x${signature.slice(130, 132)}`,
        `0x${signature.slice(2, 66)}`,
        `0x${signature.slice(66, 130)}`,
      ],
    })
    assert.equal(result[0], owner.address.hex.toLowerCase(), 'should return the recovered address')
  })

  it('reverts when CALLER is not the recovered signer', async () => {
    const msg = 'hello'
    const signature = utils.message.signMessage(msg, owner.privateKey)
    try {
      await triggerConstant(vm, {
        caller: createAddressFromString(
          '0x00000000000000000000000000000000000000ee' as PrefixedHexString,
        ),
        contractAddress: contractAddress!,
        abi: abi.find((item: any) => item.name === 'check'),
        params: [
          utils.message.hashMessage(msg),
          `0x${signature.slice(130, 132)}`,
          `0x${signature.slice(2, 66)}`,
          `0x${signature.slice(66, 130)}`,
        ],
      })
      assert.fail('should revert on signer mismatch')
    } catch (err: any) {
      assert.isTrue(err.error.includes('revert'), 'should revert on signer mismatch')
    }
  })
})
