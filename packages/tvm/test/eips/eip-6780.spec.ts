import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { Account, Address, bigIntToBytes, generateAddress, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { Message, createTVM } from '../../src/index.ts'

describe('EIP-6780 created-address tracking', () => {
  it('does not initialize createdAddresses through runCode before EIP-6780', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Berlin })
    const tvm = await createTVM({ common })

    const result = await tvm.runCode({ code: hexToBytes('0x00') })

    assert.isFalse(common.isActivatedEIP(6780))
    assert.isUndefined(result.createdAddresses)
  })

  it('tracks an internal CREATE so same-execution SELFDESTRUCT clears its balance', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
    const tvm = await createTVM({ common })
    const factory = new Address(hexToBytes('0x0000000000000000000000000000000000000100'))
    const createdAddress = new Address(generateAddress(factory.bytes, bigIntToBytes(0n)))
    await tvm.stateManager.putAccount(factory, new Account(0n, 1n))

    const result = await tvm.runCode({
      // Store ADDRESS; SELFDESTRUCT as initcode, CREATE with value 1, then return its address.
      code: hexToBytes('0x6130ff6000526002601e6001f060005260206000f3'),
      to: factory,
      gasLimit: 200000n,
    })

    assert.isTrue(common.isActivatedEIP(6780))
    assert.isUndefined(result.exceptionError)
    assert.isTrue(result.createdAddresses?.has(createdAddress.toString()))
    assert.strictEqual(
      result.selfdestruct?.get(createdAddress.toString()),
      createdAddress.toString(),
    )
    assert.strictEqual((await tvm.stateManager.getAccount(createdAddress))?.balance, 0n)
  })

  it('initializes createdAddresses for a standalone nested CREATE Message', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
    const tvm = await createTVM({ common })
    const caller = new Address(hexToBytes('0x0000000000000000000000000000000000000200'))
    await tvm.stateManager.putAccount(caller, new Account(1n))
    const message = new Message({
      caller,
      data: hexToBytes('0x00'),
      depth: 1,
      gasLimit: 100000n,
    })

    const result = await tvm.runCall({ message })

    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(message.createdAddresses?.size, 1)
  })
})
