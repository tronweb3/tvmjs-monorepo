import { sha256 } from '@noble/hashes/sha2.js'
import { Common, Mainnet, TronNile } from '@tvmjs/common'
import { type TVMInterface, createTVM, getActivePrecompiles } from '@tvmjs/tvm'
import {
  PermissionType,
  type PrefixedHexString,
  bigIntToBytes,
  concatBytes,
  createAccount,
  createAddressFromString,
  hexToBytes,
  setLengthLeft,
  utf8ToBytes,
} from '@tvmjs/util'
import { utils } from 'tronweb'
import { assert, describe, it } from 'vitest'

const precompileContractAddr = '000000000000000000000000000000000000000a'

describe('Precompiles: VALIDATE-MULTI_SIGN', () => {
  it('address do not exist', async () => {
    const common = new Common({ chain: Mainnet })
    const FUNC = getActivePrecompiles(common).get(precompileContractAddr)!
    const input =
      '0x0000000000000000000000a04223d4536f8b3888cffb8643338e7c0ee223a30c00000000000000000000000000000000000000000000000000000000000000023500d93214caf7f502af5adcd28f8f4fb3620eae3bedbeb327cc5c68a57b312900000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000041b8a22587f28dd76c28440cfbe57ed3f3be87cd1d3327813950469eb4839d9ed26c61cd5913086628ca80ff6006dd1e4bd145410936b6db08c503a596b98f805601000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041b8a22587f28dd76c28440cfbe57ed3f3be87cd1d3327813950469eb4839d9ed26c61cd5913086628ca80ff6006dd1e4bd145410936b6db08c503a596b98f805601000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041eb52ed2f5dcde641aaa9ddd8a35e1ba981a9409f3b6ca0512d9bfe6e0c9e8ba96da1da07198a3037b2515fb0103d8eb1e4b3b524a7e7155637ab33c3b104a7f90100000000000000000000000000000000000000000000000000000000000000'

    const data = hexToBytes(input)

    const result = await FUNC({
      data,
      gasLimit: 0xffffn,
      common,
      _TVM: await createTVM({ common }),
    })
    // console.log(result)
    assert.deepEqual(result.executionGasUsed, 4500n, 'should use petersburg gas costs')
    assert.deepEqual(result.returnValue, getError())
  })

  it('weight not enough', async () => {
    const common = new Common({ chain: Mainnet })
    const tvm = await createTVM({ common })

    const FUNC = getActivePrecompiles(common).get(precompileContractAddr)!

    const data = hexToBytes(await prepareAccount(tvm, 1))

    const result = await FUNC({
      data,
      gasLimit: 0xffffn,
      common,
      _TVM: tvm,
    })

    assert.deepEqual(result.executionGasUsed, 1500n, 'should use petersburg gas costs')
    assert.deepEqual(result.returnValue, getError())
  })

  it('wrong sign', async () => {
    const common = new Common({ chain: Mainnet })
    const tvm = await createTVM({ common })

    const FUNC = getActivePrecompiles(common).get(precompileContractAddr)!

    const data = hexToBytes(await prepareAccount(tvm, 2))

    const result = await FUNC({
      data,
      gasLimit: 0xffffn,
      common,
      _TVM: tvm,
    })
    // console.log(result)

    assert.deepEqual(result.executionGasUsed, 3000n, 'should use petersburg gas costs')
    assert.deepEqual(result.returnValue, getError())
  })

  it('valid success', async () => {
    const common = new Common({ chain: Mainnet })
    const tvm = await createTVM({ common })

    const input = await prepareAccount(tvm, 3)

    const FUNC = getActivePrecompiles(common).get(precompileContractAddr)!

    const data = hexToBytes(input)

    const result = await FUNC({
      data,
      gasLimit: 0xffffn,
      common,
      _TVM: tvm,
    })

    assert.deepEqual(result.executionGasUsed, 4500n, 'should use petersburg gas costs')
    assert.deepEqual(result.returnValue, getOk())
  })

  it('Osaka rejects invalid ABI shape and consumes the forwarded gas', async () => {
    const common = new Common({ chain: TronNile, activatedProposals: [96] })
    const FUNC = getActivePrecompiles(common).get(precompileContractAddr)!
    const gasLimit = 12345n

    // H=5 and I=5 for validateMultiSign. Six words leave one incomplete item.
    const result = await FUNC({
      data: new Uint8Array(6 * 32),
      gasLimit,
      common,
      _TVM: await createTVM({ common }),
    })

    assert.strictEqual(result.executionGasUsed, gasLimit)
    assert.deepEqual(result.returnValue, new Uint8Array())
    assert.isDefined(result.exceptionError)
  })
})

function getOk() {
  const ok = new Uint8Array(32)
  ok[ok.length - 1] = 1
  return ok
}

function getError() {
  return new Uint8Array(32)
}

function sign(hash: Uint8Array, privateKey: PrefixedHexString) {
  const signKey = new utils.ethersUtils.SigningKey(privateKey)
  return hexToBytes(utils.ethersUtils.joinSignature(signKey.sign(hash)) as `0x${string}`)
}

async function prepareAccount(tvm: TVMInterface, index: number): Promise<`0x${string}`> {
  const account0 = utils.accounts.generateAccount()
  const account1 = utils.accounts.generateAccount()
  const account2 = utils.accounts.generateAccount()
  const address = createAddressFromString(`0x${account0.address.hex.replace(/^41/, '')}`)
  const account = createAccount({ nonce: 0, balance: 10000 })
  account.updatePermissions({
    activePermissions: [
      {
        type: PermissionType.Active,
        id: 2,
        permissionName: 'active',
        threshold: 2,
        operations: hexToBytes(
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        ),
        keys: [
          {
            address: hexToBytes(`0x${account1.address.hex.replace(/^41/, '')}`),
            weight: 1,
          },
          {
            address: hexToBytes(`0x${account2.address.hex.replace(/^41/, '')}`),
            weight: 1,
          },
        ],
        parentId: 0,
      },
    ],
  })
  await tvm.stateManager.putAccount(address, account)

  const dataToSign = sha256(utf8ToBytes('test'))
  const merged = concatBytes(
    hexToBytes(`0x${account0.address.hex}`),
    setLengthLeft(bigIntToBytes(2n), 4),
    dataToSign,
  )
  const toSign = sha256(merged)
  const signatures = []
  switch (index) {
    case 1:
      signatures.push(sign(toSign, `0x${account1.privateKey}`))
      break
    case 2: {
      signatures.push(sign(toSign, `0x${account1.privateKey}`))
      const sig2 = sign(toSign, `0x${account2.privateKey}`)
      sig2[0] = sig2[0] > 0 ? sig2[0] - 1 : sig2[0] + 1
      signatures.push(sig2)
      break
    }
    default:
      signatures.push(sign(toSign, `0x${account1.privateKey}`))
      signatures.push(sign(toSign, `0x${account2.privateKey}`))
      signatures.push(sign(toSign, `0x${account2.privateKey}`))
      break
  }
  const abiItem = {
    type: 'function',
    name: 'testmulti',
    inputs: [
      { name: 'address', type: 'address' },
      { name: 'permissionId', type: 'uint256' },
      { name: 'hash', type: 'bytes32' },
      { name: 'signatures', type: 'bytes[]' },
    ],
  } as const
  return utils.abi.encodeParamsV2ByABI(abiItem, [
    account0.address.hex,
    2n,
    dataToSign,
    signatures,
  ]) as `0x${string}`
}
