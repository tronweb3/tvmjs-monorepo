import { bytesToHex, createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'
import { utils } from 'tronweb'
import { assert, describe, it } from 'vitest'
import { createVM } from '../../../src/constructors.ts'
import { PK, compileSol, deployContract, triggerConstant } from './utils.ts'

import type { Address } from '@tvmjs/util'

const OWNER_ADDRESS = createAddressFromPrivateKey(hexToBytes(PK))

const batchValidateSign = async (hash: string, signatures: string[], addresses: string[]) => {
  const vm = await createVM({})
  const { bytecode, abi } = await compileSol('batchvalidatesign001.sol', 'Demo')
  const contractAddress = (await deployContract(vm, {
    caller: OWNER_ADDRESS,
    bytecode: hexToBytes(`0x${bytecode}`),
    gasLimit: 5_000_000_000n,
  })) as Address

  const result = await triggerConstant(vm, {
    caller: OWNER_ADDRESS,
    contractAddress,
    abi: abi.find((item: any) => item.name === 'testPure'),
    params: [hash, signatures, addresses],
  })

  return result
}

describe('BatchValidateSignContractTest', async () => {
  it('staticCallTest', async () => {
    const longData = new Uint8Array(new Array(1000).fill(2))
    const hash = utils.ethersUtils.keccak256(longData)

    const signatures = []
    const addresses = []
    for (let i = 0; i < 16; i++) {
      const account = utils.accounts.generateAccount()
      const key = new utils.ethersUtils.SigningKey(`0x${account.privateKey}`)
      const signature = utils.ethersUtils.joinSignature(key.sign(hash))
      if (i % 5 === 0) {
        const sig = new Uint8Array(new Array(32).fill(0))
        sig[31] = 1
        signatures.push(bytesToHex(sig))
      } else {
        signatures.push(signature)
      }
      if (i === 13) {
        addresses.push(`0x${'0'.repeat(40)}`)
      } else {
        addresses.push(account.address.hex.replace(utils.constants.ADDRESS_PREFIX_REGEX, '0x'))
      }
    }

    const result = await batchValidateSign(hash, signatures, addresses)
    const resultBytes = hexToBytes(result[0])

    for (let i = 0; i < 16; i++) {
      if (i % 5 === 0) {
        assert.equal(resultBytes[i], 0)
      } else if (i === 13) {
        assert.equal(resultBytes[i], 0)
      } else {
        assert.equal(resultBytes[i], 1)
      }
    }

    assert.equal(result[0], '0x0001010101000101010100010100010000000000000000000000000000000000')
  }, 60000)
})
