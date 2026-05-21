import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { Address, createZeroAddress, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createTVM, getActivePrecompiles } from '../../src/index.ts'

describe('Precompiles: hardfork availability', () => {
  it('Test BN254PAIRING availability', async () => {
    const ECPAIR_AddressStr = '0000000000000000000000000000000000000008'
    const ECPAIR_Address = new Address(hexToBytes(`0x${ECPAIR_AddressStr}`))

    // ECPAIR was introduced in Byzantium; check if available from Byzantium.
    const commonByzantium = new Common({ chain: Mainnet, hardfork: Hardfork.Byzantium })

    let BN254PAIRING = getActivePrecompiles(commonByzantium).get(ECPAIR_AddressStr)

    if (!BN254PAIRING) {
      assert.fail('BN254PAIRING is not available in petersburg while it should be available')
    } else {
      assert.isTrue(true, 'BN254PAIRING available in petersburg')
    }

    let tvm = await createTVM({
      common: commonByzantium,
    })
    let result = await tvm.runCall({
      caller: createZeroAddress(),
      gasLimit: BigInt(0xffffffffff),
      to: ECPAIR_Address,
      value: BigInt(0),
    })

    assert.strictEqual(result.execResult.executionGasUsed, BigInt(100000)) // check that we are using gas (if address would contain no code we use 0 gas)

    // Check if ECPAIR is available in future hard forks.
    const commonPetersburg = new Common({ chain: Mainnet, hardfork: Hardfork.Petersburg })
    BN254PAIRING = getActivePrecompiles(commonPetersburg).get(ECPAIR_AddressStr)!
    if (BN254PAIRING === undefined) {
      assert.fail('BN254PAIRING is not available in petersburg while it should be available')
    } else {
      assert.isTrue(true, 'BN254PAIRING available in petersburg')
    }

    tvm = await createTVM({
      common: commonPetersburg,
    })
    result = await tvm.runCall({
      caller: createZeroAddress(),
      gasLimit: BigInt(0xffffffffff),
      to: ECPAIR_Address,
      value: BigInt(0),
    })

    assert.strictEqual(result.execResult.executionGasUsed, BigInt(100000))

    // Check if ECPAIR is not available in Homestead.
    const commonHomestead = new Common({ chain: Mainnet, hardfork: Hardfork.Homestead })
    BN254PAIRING = getActivePrecompiles(commonHomestead).get(ECPAIR_AddressStr)!

    if (BN254PAIRING !== undefined) {
      assert.fail('BN254PAIRING is available in homestead while it should not be available')
    } else {
      assert.isTrue(true, 'BN254PAIRING not available in homestead')
    }

    tvm = await createTVM({
      common: commonHomestead,
    })

    result = await tvm.runCall({
      caller: createZeroAddress(),
      gasLimit: BigInt(0xffffffffff),
      to: ECPAIR_Address,
      value: BigInt(0),
    })

    assert.strictEqual(result.execResult.executionGasUsed, BigInt(0)) // check that we use no gas, because we are calling into an address without code.
  })
})
