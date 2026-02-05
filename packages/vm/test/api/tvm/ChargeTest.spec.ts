import { createAddressFromString, hexToBytes } from '@tvmjs/util'
import { utils } from 'tronweb'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import type { RunTxResult } from '../../../src/types.ts'
import { setBalance } from '../utils.ts'
import { deployContract } from './utils.ts'

describe('ChargeTest', async () => {
  it('testOverflow', async () => {
    const account = utils.accounts.generateAccount()
    const vm = await createVM({})
    const totalBalance = 100_000_000_000_000n
    const address = createAddressFromString(
      account.address.hex.replace(utils.constants.ADDRESS_PREFIX_REGEX, '0x'),
    )

    await setBalance(vm, address, totalBalance)

    // const abi = JSON.parse("[{\"constant\":false,\"inputs\":[],\"name\":\"testOverflow\",\"outputs\":[],\""
    // + "payable\":true,\"stateMutability\":\"payable\",\"type\":\"function\"}]")
    const bytecode =
      '608060405234801561001057600080fd5b50610100806100206000396000f300608060405260043' +
      '610603f576000357c0100000000000000000000000000000000000000000000000000000000900463ffffff' +
      'ff1680638040cac4146044575b600080fd5b604a604c565b005b6000678ac7230489e80000605d607f565b6' +
      '040518091039082f0801580156077573d6000803e3d6000fd5b509050905050565b60405160468061008f83' +
      '3901905600608060405260358060116000396000f3006080604052600080fd00a165627a7a723058201738d' +
      '6aa899dc00d4e99de944eb74d30a9ba1fcae37b99dc6299d95e992ca8b40029a165627a7a72305820683901' +
      '37ba70dfc460810603eba8500b050ed3cd01e66f55ec07d387ec1cd2750029'
    const caller = address

    const deploymentResult = (await deployContract(
      vm,
      {
        caller,
        bytecode: hexToBytes(`0x${bytecode}`),
        gasLimit: 1_000_000_000n,
      },
      {
        detail: true,
        pk: `0x${account.privateKey}`,
      },
    )) as RunTxResult

    // JAVA-TRON expected 51293 energy usage
    const expectEnergyUsageTotal = 51299n // 200 * code.length() + 93
    const resultBalance = await vm.stateManager
      .getAccount(address)
      .then((account) => account?.balance)

    assert.equal(expectEnergyUsageTotal, deploymentResult.execResult.executionGasUsed)
    assert.equal(resultBalance, totalBalance - deploymentResult.totalGasSpent * 100n)
  })
})
