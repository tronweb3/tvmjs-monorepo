import { Account, Address, type PrefixedHexString, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { EOFContainer, createTVM } from '../../src/index.ts'

import { getCommon } from './eof-utils.ts'

async function getTVM() {
  const common = getCommon()
  const tvm = createTVM({
    common,
  })
  return tvm
}

// Note: currently 0xE3 (RETF) and 0xE4 (JUMPF) need to be added to the valid opcodes list, otherwise 1 test will fail

describe('EOF: should run a simple contract', async () => {
  it('should run without failing', async () => {
    const tvm = await getTVM()
    const code = hexToBytes('0xef000101000402000100030400010000800001305000ef')

    const caller = new Address(hexToBytes('0x00000000000000000000000000000000000000ee')) // caller address
    const contractAddress = new Address(hexToBytes('0x00000000000000000000000000000000000000ff')) // contract address

    await tvm.stateManager.putCode(contractAddress, code)
    await tvm.stateManager.putAccount(caller, new Account(BigInt(0), BigInt(0x11111111)))

    const runCallArgs = {
      caller,
      gasLimit: BigInt(0xffff),
      to: contractAddress,
    }

    const result = await tvm.runCall(runCallArgs)

    // The code which is being ran should run ADDRESS POP STOP
    // This costs 4 gas
    assert.strictEqual(result.execResult.executionGasUsed, BigInt(4))
  })
  it('should initialize code positions correctly', async () => {
    const code = hexToBytes(
      ('0xef0001' +
        '010008' +
        '02' +
        '000200080003' +
        '040000' +
        '00' +
        '0080000100000001' + // Section 1
        '3050e30001600100' + // Section 2
        '3050e4') as PrefixedHexString,
    )
    const eofContainer = new EOFContainer(code)
    assert.doesNotThrow(() => eofContainer.header.getSectionFromProgramCounter(33))
  })
})
