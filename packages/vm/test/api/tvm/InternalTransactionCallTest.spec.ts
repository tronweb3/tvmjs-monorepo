import type { Address } from '@tvmjs/util'
import { createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import type { VM } from '../../../src/vm.ts'
import { PK, deployContract, trigger, triggerConstant } from './utils.ts'

const OWNER_ADDRESS = createAddressFromPrivateKey(hexToBytes(PK))

const contractAABI = JSON.parse(
  '[{"constant":false,"inputs":[{"name":"bAddress","type":"address"},{"name"' +
    ':"_number","type":"uint256"}],' +
    '"name":"delegatecallTest","outputs":[],"payable":false,"stateMutability"' +
    ':"nonpayable","type":"function"},{"constant' +
    '":false,"inputs":[{"name":"bAddress","type":"address"},{"name":"' +
    '_number","type":"uint256"}],"name":"callTest",' +
    '"outputs":[],"payable":false,"stateMutability":"nonpayable","type":"' +
    'function"},{"constant":true,"inputs":[],"name":' +
    '"senderForB","outputs":[{"name":"","type":"address"}],"payable":' +
    'false,"stateMutability":"view","type":' +
    '"function"},{"constant":false,"inputs":[{"name":"bAddress","type":"' +
    'address"},{"name":"_number","type":"uint256"}],' +
    '"name":"callcodeTest","outputs":[],"payable":false,"stateMutability"' +
    ':"nonpayable","type":"function"},{"constant":true,' +
    '"inputs":[],"name":"numberForB","outputs":[{"name":"","type":"' +
    'uint256"}],"payable":false,"stateMutability":"view",' +
    '"type":"function"}]',
)

const contractBABI = JSON.parse(
  '[{"constant":false,"inputs":[{"name":"_number","type":"uint256"}],' +
    '"name":"setValue",' +
    '"outputs":[],"payable":false,"stateMutability":"nonpayable","type"' +
    ':"function"},{"constant":true,' +
    '"inputs":[],"name":"senderForB","outputs":[{"name":"","type"' +
    ':"address"}],"payable":false,' +
    '"stateMutability":"view","type":"function"},{"constant":true,"inputs"' +
    ':[],"name":"numberForB",' +
    '"outputs":[{"name":"","type":"uint256"}],"payable":false,"' +
    'stateMutability":"view","type":' +
    '"function"}]',
)

async function deployB(vm: VM) {
  const bytecode =
    '608060405234801561001057600080fd5b5061014c806100206000396000f3006080604052600436106100565' +
    '763ffffffff7c0100000000000000000000000000000000000000000000000000000000600035041663' +
    '55241077811461005b578063b053ebd414610075578063dd92afef146100b3575b600080fd5b3480156' +
    '1006757600080fd5b506100736004356100da565b005b34801561008157600080fd5b5061008a6100fe' +
    '565b6040805173ffffffffffffffffffffffffffffffffffffffff9092168252519081900360200190f' +
    '35b3480156100bf57600080fd5b506100c861011a565b60408051918252519081900360200190f35b60' +
    '00556001805473ffffffffffffffffffffffffffffffffffffffff191633179055565b60015473fffff' +
    'fffffffffffffffffffffffffffffffffff1681565b600054815600a165627a7a72305820e2c513cf46' +
    'bb32018879ec48f8fe264c985b6d2c7a853a578f4f56583fe1ffb80029'
  const caller = OWNER_ADDRESS

  const address = (await deployContract(vm, {
    caller,
    bytecode: hexToBytes(`0x${bytecode}`),
  })) as Address
  return address
}

async function deployA(vm: VM) {
  const bytecode =
    '608060405234801561001057600080fd5b506102d4806100206000396000f3006080604052600436106100535' +
    '763ffffffff60e060020a6000350416633da5d187811461005857806343c3a43a1461007e578063b053' +
    'ebd4146100a2578063d7d21f5b146100d3578063dd92afef146100f7575b600080fd5b3480156100645' +
    '7600080fd5b5061007c600160a060020a036004351660243561011e565b005b34801561008a57600080' +
    'fd5b5061007c600160a060020a0360043516602435610199565b3480156100ae57600080fd5b506100b' +
    '7610216565b60408051600160a060020a039092168252519081900360200190f35b3480156100df5760' +
    '0080fd5b5061007c600160a060020a0360043516602435610225565b34801561010357600080fd5b506' +
    '1010c6102a2565b60408051918252519081900360200190f35b81600160a060020a031660405180807f' +
    '73657456616c75652875696e74323536290000000000000000000000000000008152506011019050604' +
    '051809103902060e060020a9004826040518263ffffffff1660e060020a028152600401808281526020' +
    '01915050600060405180830381865af4505050505050565b81600160a060020a031660405180807f736' +
    '57456616c75652875696e74323536290000000000000000000000000000008152506011019050604051' +
    '809103902060e060020a9004826040518263ffffffff1660e060020a028152600401808281526020019' +
    '150506000604051808303816000875af1505050505050565b600154600160a060020a031681565b8160' +
    '0160a060020a031660405180807f73657456616c75652875696e7432353629000000000000000000000' +
    '0000000008152506011019050604051809103902060e060020a9004826040518263ffffffff1660e060' +
    '020a028152600401808281526020019150506000604051808303816000875af2505050505050565b600' +
    '054815600a165627a7a723058206d36ef7c6f6d387ad915f299e715c9b360f3719843a1113badb28b65' +
    '95e66c1e0029'
  const caller = OWNER_ADDRESS

  const address = (await deployContract(
    vm,
    {
      caller,
      bytecode: hexToBytes(`0x${bytecode}`),
    },
    {
      skipBalance: true,
    },
  )) as Address
  return address
}

describe('InternalTransactionCallTest', async () => {
  it('callTest', async () => {
    const vm = await createVM()
    const contractB = await deployB(vm)
    const contractA = await deployA(vm)

    await trigger(vm, {
      caller: OWNER_ADDRESS,
      contractAddress: contractA,
      abi: contractAABI.find((item: any) => item.name === 'callTest'),
      params: [contractB.toString(), 3n],
    })

    const result1 = await triggerConstant(vm, {
      caller: OWNER_ADDRESS,
      contractAddress: contractA,
      abi: contractAABI.find((item: any) => item.name === 'numberForB'),
    })
    assert.equal(result1[0], 0n)

    const result2 = await triggerConstant(vm, {
      caller: OWNER_ADDRESS,
      contractAddress: contractA,
      abi: contractAABI.find((item: any) => item.name === 'senderForB'),
    })
    assert.equal(result2[0], '410000000000000000000000000000000000000000')

    const result3 = await triggerConstant(vm, {
      caller: OWNER_ADDRESS,
      contractAddress: contractB,
      abi: contractBABI.find((item: any) => item.name === 'numberForB'),
    })
    assert.equal(result3[0], 3n)

    const result4 = await triggerConstant(vm, {
      caller: OWNER_ADDRESS,
      contractAddress: contractB,
      abi: contractBABI.find((item: any) => item.name === 'senderForB'),
    })
    assert.equal(result4[0], contractA.toString().replace(/^0x/, '41'))
  })
})
