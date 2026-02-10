import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import {
  type Address,
  PermissionType,
  bigIntToBytes,
  concatBytes,
  createAccount,
  createAddressFromPrivateKey,
  hexToBytes,
  utf8ToBytes,
} from '@tvmjs/util'
import { utils } from 'tronweb'
import { assert, beforeAll, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import type { VM } from '../../../src/vm.ts'
import { PK, compileSol, deployContract, trigger } from './utils.ts'

const OWNER_ADDRESS = createAddressFromPrivateKey(hexToBytes(PK))

async function validateMultiSign(
  vm: VM,
  address: string,
  permissionId: bigint,
  hash: Uint8Array,
  signatures: Uint8Array[],
) {
  const { bytecode, abi } = await compileSol('validatemultisign001.sol', 'validatemultisignTest')
  const contractAddress = (await deployContract(vm, {
    caller: OWNER_ADDRESS,
    bytecode: hexToBytes(`0x${bytecode}`),
    gasLimit: 5_000_000n,
  })) as Address

  const abiItem = abi.find((item: any) => item.name === 'testmulti')

  const result = await trigger(vm, {
    caller: OWNER_ADDRESS,
    contractAddress,
    abi: abiItem,
    params: [address, permissionId, hash, signatures],
  })

  return utils.abi.decodeParamsV2ByABI(abiItem, result.results[0].execResult.returnValue)
}

describe('ValidateMultiSignContractTest', async () => {
  const account0 = utils.accounts.generateAccount()
  const address0 = createAddressFromPrivateKey(hexToBytes(`0x${account0.privateKey}`))
  const account1 = utils.accounts.generateAccount()
  const address1 = createAddressFromPrivateKey(hexToBytes(`0x${account1.privateKey}`))
  const account2 = utils.accounts.generateAccount()
  const address2 = createAddressFromPrivateKey(hexToBytes(`0x${account2.privateKey}`))
  const vm = await createVM()

  beforeAll(async () => {
    const tvmAccount0 = createAccount({
      balance: 100_000_000_000n,
    })
    tvmAccount0?.updatePermissions({
      activePermissions: [
        {
          type: PermissionType.Owner,
          id: 0,
          permissionName: 'owner',
          threshold: 2,
          operations: new Uint8Array(0),
          keys: [
            {
              address: hexToBytes(address1.toString()),
              weight: 1,
            },
            {
              address: hexToBytes(address0.toString()),
              weight: 1,
            },
          ],
          parentId: 0,
        },

        {
          type: PermissionType.Active,
          id: 2,
          permissionName: 'active',
          threshold: 2,
          operations: hexToBytes(
            '0x7fff1fc0033e0000000000000000000000000000000000000000000000000000',
          ),
          keys: [
            {
              address: hexToBytes(address1.toString()),
              weight: 1,
            },
            {
              address: hexToBytes(address2.toString()),
              weight: 1,
            },
          ],
          parentId: 0,
        },
      ],
    })
    await vm.stateManager.checkpoint()
    await vm.stateManager.putAccount(address0, tvmAccount0)
    await vm.stateManager.commit()

    const updatedAccount0 = await vm.stateManager.getAccount(address0)
    assert.isNotNull(updatedAccount0?.activePermissions)
    assert.deepEqual(updatedAccount0?.activePermissions, tvmAccount0?.activePermissions)
  })

  it('Trigger validatemultisign contract with Permission(address) case', async () => {
    const hash = keccak_256(utf8ToBytes('hello world'))
    const merged = concatBytes(hexToBytes('0x41'), address0.bytes, bigIntToBytes(0n), hash)
    const toSign = sha256(merged)

    const signatures = []

    {
      const signKey = new utils.ethersUtils.SigningKey(`0x${account1.privateKey}`)
      signatures.push(
        hexToBytes(utils.ethersUtils.joinSignature(signKey.sign(toSign)) as `0x${string}`),
      )
    }
    {
      const signKey = new utils.ethersUtils.SigningKey(`0x${account0.privateKey}`)
      signatures.push(
        hexToBytes(utils.ethersUtils.joinSignature(signKey.sign(toSign)) as `0x${string}`),
      )
    }

    const result = await validateMultiSign(vm, address0.toString(), 0n, hash, signatures)
    assert.equal(result[0], true)
  })
})
