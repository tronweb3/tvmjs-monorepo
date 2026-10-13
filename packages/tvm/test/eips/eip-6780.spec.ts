import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { Account, Address, generateTronCreateAddress, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { Message, createTVM } from '../../src/index.ts'

describe.each([TronMainnet, TronNile, TronShasta])(
  'TRON created-address tracking on $name',
  (chain) => {
    it('initializes createdAddresses through runCode with the active restriction', async () => {
      const common = new Common({ chain })
      const tvm = await createTVM({ common })

      const result = await tvm.runCode({ code: hexToBytes('0x00') })

      assert.isTrue(common.isActivatedEIP(6780))
      assert.isUndefined(result.exceptionError)
      assert.deepEqual(result.createdAddresses, new Set())
    })

    it('tracks an internal CREATE so same-execution SELFDESTRUCT clears its balance', async () => {
      const common = new Common({ chain })
      const tvm = await createTVM({ common })
      const factory = new Address(hexToBytes('0x0000000000000000000000000000000000000100'))
      const rootTransactionId = new Uint8Array(32)
      const createdAddress = new Address(generateTronCreateAddress(rootTransactionId, 0n))
      await tvm.stateManager.putAccount(factory, new Account(0n, 1n))

      const result = await tvm.runCode({
        // Store ADDRESS; SELFDESTRUCT as initcode, CREATE with value 1, then return its address.
        code: hexToBytes('0x6130ff6000526002601e6001f060005260206000f3'),
        to: factory,
        gasLimit: 200000n,
        rootTransactionId,
      })

      assert.isTrue(common.isActivatedEIP(6780))
      assert.isUndefined(result.exceptionError)
      assert.isTrue(result.createdAddresses?.has(createdAddress.toString()))
      assert.strictEqual(result.returnValue[11], 0x41)
      assert.deepEqual(result.returnValue.subarray(12), createdAddress.bytes)
      assert.strictEqual(
        result.selfdestruct?.get(createdAddress.toString()),
        createdAddress.toString(),
      )
      assert.strictEqual((await tvm.stateManager.getAccount(createdAddress))?.balance, 0n)
    })

    it('initializes createdAddresses for a standalone nested CREATE Message', async () => {
      const common = new Common({ chain })
      const tvm = await createTVM({ common })
      const caller = new Address(hexToBytes('0x0000000000000000000000000000000000000200'))
      await tvm.stateManager.putAccount(caller, new Account(1n))
      const message = new Message({
        caller,
        data: hexToBytes('0x00'),
        depth: 1,
        gasLimit: 100000n,
      })

      const result = await tvm.runCall({ message, rootTransactionId: new Uint8Array(32) })

      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(message.createdAddresses?.size, 1)
      assert.isTrue(message.createdAddresses?.has(result.createdAddress!.toString()))
    })
  },
)
