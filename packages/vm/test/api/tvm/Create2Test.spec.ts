import type { Address } from '@tvmjs/util'
import {
  bytesToBigInt,
  bytesToHex,
  createAddressFromPrivateKey,
  createAddressFromString,
  hexToBytes,
  unpadBytes,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import { PK, deployContract, trigger } from './utils.ts'

describe('Create2Test', async () => {
  it('testCreate2', async () => {
    const abi = JSON.parse(
      '[{"constant":false,"inputs":[{"name":"code","type":"bytes"},' +
        '{"name":"salt","type":"uint256"}],"name":"deploy","outputs":[{"name"' +
        ':"","type":"address"}],"payable":false,"stateMutability":"nonpayable",' +
        '"type":"function"},{"anonymous":false,"inputs":[{"indexed":false,"name":' +
        '"addr","type":"address"},{"indexed":false,"name":"salt","type":"uint256"' +
        '}],"name":"Deployed","type":"event"}]',
    )
    const bytecode =
      '608060405234801561001057600080fd5b50d3801561001d57600080fd5b50d2801561002' +
      'a57600080fd5b506101c18061003a6000396000f3fe6080604052600436106100245760003560e01c63fffff' +
      'fff1680639c4ae2d014610029575b600080fd5b34801561003557600080fd5b50d3801561004257600080fd5' +
      'b50d2801561004f57600080fd5b506100f86004803603604081101561006657600080fd5b810190602081018' +
      '13564010000000081111561008157600080fd5b82018360208201111561009357600080fd5b8035906020019' +
      '18460018302840111640100000000831117156100b557600080fd5b91908080601f016020809104026020016' +
      '0405190810160405280939291908181526020018383808284376000920191909152509295505091359250610' +
      '121915050565b6040805173ffffffffffffffffffffffffffffffffffffffff9092168252519081900360200' +
      '190f35b600080828451602086016000f59050803b151561013d57600080fd5b6040805173fffffffffffffff' +
      'fffffffffffffffffffffffff831681526020810185905281517fb03c53b28e78a88e31607a27e1fa48234dc' +
      'e28d5d9d9ec7b295aeb02e674a1e1929181900390910190a1939250505056fea165627a7a7230582079653f6' +
      '506bd7d3bdf4954ec98c452c5455d2b11444642db00b38fa422b25a650029'
    const testcode =
      '608060405234801561001057600080fd5b50d3801561001d57600080fd5b50d2801561002a57' +
      '600080fd5b5060d7806100396000396000f3fe608060405260043610602c5760003560e01c63ffffffff1680' +
      '6368e5c066146031578063e5aa3d5814606d575b600080fd5b348015603c57600080fd5b50d3801560485760' +
      '0080fd5b50d28015605457600080fd5b50605b6097565b60408051918252519081900360200190f35b348015' +
      '607857600080fd5b50d38015608457600080fd5b50d28015609057600080fd5b50605b60a5565b6000805460' +
      '01019081905590565b6000548156fea165627a7a72305820c637cddbfa24b6530000f2e54d90e0f6c1590783' +
      '5674109287f64303446f9afb0029'

    const vm = await createVM({})
    const caller = createAddressFromPrivateKey(hexToBytes(PK))
    const contractAddress = (await deployContract(vm, {
      caller,
      bytecode: hexToBytes(`0x${bytecode}`),
    })) as Address

    const salt = 100n
    const abiItem = abi.find((item: any) => item.name === 'deploy')

    const output = await trigger(vm, {
      caller,
      contractAddress,
      abi: abiItem,
      params: [hexToBytes(`0x${testcode}`), salt],
    })

    const actualAddress = bytesToHex(unpadBytes(output.results[0].execResult.returnValue))

    const abiItem2 = {
      name: 'plusOne',
      inputs: [],
      outputs: [
        {
          type: 'uint256',
          name: 'output',
        },
      ],
      stateMutability: 'nonpayable',
      type: 'function',
    }

    const result = await trigger(vm, {
      contractAddress: createAddressFromString(actualAddress),
      caller,
      abi: abiItem2,
    })
    const addResult1 = bytesToBigInt(result.results[0].execResult.returnValue)
    assert.equal(addResult1, 1n)

    const result2 = await trigger(vm, {
      contractAddress: createAddressFromString(actualAddress),
      caller,
      abi: abiItem2,
    })
    const addResult2 = bytesToBigInt(result2.results[0].execResult.returnValue)
    assert.equal(addResult2, 2n)
  })
})
