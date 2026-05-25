import { Common, Hardfork, Mainnet, Sepolia, createCustomCommon } from '@tvmjs/common'
import { RLP } from '@tvmjs/rlp'
import { goerliChainConfig } from '@tvmjs/testdata'
import {
  bytesToBigInt,
  bytesToHex,
  equalsBytes,
  hexToBytes,
  intToBytes,
  toBytes,
  unpadBytes,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import {
  createLegacyTx,
  createLegacyTxFromBytesArray,
  createLegacyTxFromRLP,
} from '../src/index.ts'

import { transactionTestEip155VitalikTestsData } from './testData/transactionTestEip155VitalikTests.ts'
import { txsData } from './testData/txs.ts'

import type { PrefixedHexString } from '@tvmjs/util'
import type { TransactionType, TxData, TypedTransaction } from '../src/index.ts'

describe('[Transaction]', () => {
  const transactions: TypedTransaction[] = []

  it(`cannot input decimal or negative values`, () => {
    const values = ['gasPrice', 'gasLimit', 'nonce', 'value', 'v', 'r', 's']
    const cases = [
      10.1,
      '10.1',
      '0xaa.1',
      -10.1,
      -1,
      BigInt(-10),
      '-100',
      '-10.1',
      '-0xaa',
      Infinity,
      -Infinity,
      NaN,
      {},
      true,
      false,
      () => {},
      Number.MAX_SAFE_INTEGER + 1,
    ]
    for (const value of values) {
      const txData: any = {}
      for (const testCase of cases) {
        txData[value] = testCase
        assert.throws(() => {
          createLegacyTx(txData)
        })
      }
    }
  })

  it('Initialization', () => {
    const nonEIP2930Common = new Common({ chain: Mainnet, hardfork: Hardfork.Istanbul })
    assert.isDefined(
      createLegacyTx({}, { common: nonEIP2930Common }),
      'should initialize on a pre-Berlin Hardfork (EIP-2930 not activated)',
    )
    let common = new Common({ chain: goerliChainConfig })
    const txData = txsData[3].raw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString))
    txData[6] = intToBytes(45) // v with 0-parity and chain ID 5
    let tx = createLegacyTxFromBytesArray(txData, { common })
    assert.strictEqual(
      tx.common.chainId(),
      BigInt(5),
      'should initialize Common with chain ID (supported) derived from v value (v with 0-parity)',
    )

    txData[6] = intToBytes(46) // v with 1-parity and chain ID 5
    tx = createLegacyTxFromBytesArray(txData, { common })
    assert.strictEqual(
      tx.common.chainId(),
      BigInt(5),
      'should initialize Common with chain ID (supported) derived from v value (v with 1-parity)',
    )

    common = createCustomCommon({ chainId: 999 }, Mainnet)

    txData[6] = intToBytes(2033) // v with 0-parity and chain ID 999
    tx = createLegacyTxFromBytesArray(txData, { common })
    assert.strictEqual(
      tx.common.chainId(),
      BigInt(999),
      'should initialize Common with chain ID (unsupported) derived from v value (v with 0-parity)',
    )

    txData[6] = intToBytes(2034) // v with 1-parity and chain ID 999
    tx = createLegacyTxFromBytesArray(txData, { common })
    assert.strictEqual(
      tx.common.chainId(),
      BigInt(999),
      'should initialize Common with chain ID (unsupported) derived from v value (v with 1-parity)',
    )
  })

  it('Initialization -> decode with createWithdrawalFromBytesArray()', () => {
    for (const tx of txsData.slice(0, 4)) {
      const txData = tx.raw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString))
      const pt = createLegacyTxFromBytesArray(txData)

      assert.strictEqual(bytesToHex(unpadBytes(toBytes(pt.nonce))), tx.raw[0])
      assert.strictEqual(bytesToHex(toBytes(pt.gasPrice)), tx.raw[1])
      assert.strictEqual(bytesToHex(toBytes(pt.gasLimit)), tx.raw[2])
      assert.strictEqual(pt.to?.toString(), tx.raw[3])
      assert.strictEqual(bytesToHex(unpadBytes(toBytes(pt.value))), tx.raw[4])
      assert.strictEqual(bytesToHex(pt.data), tx.raw[5])
      assert.strictEqual(bytesToHex(toBytes(pt.v)), tx.raw[6])
      assert.strictEqual(bytesToHex(toBytes(pt.r)), tx.raw[7])
      assert.strictEqual(bytesToHex(toBytes(pt.s)), tx.raw[8])

      transactions.push(pt)
    }
  })

  it('Initialization -> should accept lesser r values', () => {
    const tx = createLegacyTx({ r: bytesToBigInt(hexToBytes('0x0005')) })
    assert.strictEqual(tx.r!.toString(16), '5')
  })

  it('Initialization -> throws when creating a a transaction with incompatible chainid and v value', () => {
    let common = new Common({ chain: goerliChainConfig, hardfork: Hardfork.Petersburg })
    let tx = createLegacyTx({}, { common })
    assert.strictEqual(tx.common.chainId(), BigInt(5))
    const privKey = hexToBytes(`0x${txsData[0].privateKey}`)
    tx = tx.sign(privKey)
    const serialized = tx.serialize()
    common = new Common({ chain: Mainnet, hardfork: Hardfork.Petersburg })
    assert.throws(() => createLegacyTxFromRLP(serialized, { common }))
  })

  it('Initialization -> throws if v is set to an EIP155-encoded value incompatible with the chain id', () => {
    assert.throws(() => {
      const common = new Common({ chain: Sepolia, hardfork: Hardfork.Petersburg })
      createLegacyTx({ v: BigInt(1) }, { common })
    })
  })

  it('addSignature() -> correctly adds correct signature values', () => {
    const privKey = hexToBytes(`0x${txsData[0].privateKey}`)
    const tx = createLegacyTx({})
    const signedTx = tx.sign(privKey)
    const addSignatureTx = tx.addSignature(signedTx.v!, signedTx.r!, signedTx.s!)

    assert.deepEqual(signedTx.toJSON(), addSignatureTx.toJSON())
  })

  it('addSignature() -> correctly adds correct signature values from ecrecover with ChainID protection enabled', () => {
    const privKey = hexToBytes(`0x${txsData[0].privateKey}`)
    const tx = createLegacyTx({}, { common: new Common({ chain: Sepolia }) })
    const signedTx = tx.sign(privKey)
    // `convertV` set to false, since we use the raw value from the signed tx
    const addSignatureTx = tx.addSignature(signedTx.v!, signedTx.r!, signedTx.s!, false)

    assert.deepEqual(signedTx.toJSON(), addSignatureTx.toJSON())
    assert.isTrue(addSignatureTx.v! > BigInt(28))
  })

  it('addSignature() -> throws when adding the wrong v value', () => {
    const privKey = hexToBytes(`0x${txsData[0].privateKey}`)
    const tx = createLegacyTx({}, { common: new Common({ chain: Sepolia }) })
    const signedTx = tx.sign(privKey)
    // `convertV` set to true: this will apply EIP-155 replay transaction twice, so it should throw!
    assert.throws(() => {
      tx.addSignature(signedTx.v!, signedTx.r!, signedTx.s!, true)
    })
  })

  it('getValidationErrors() -> should validate', () => {
    for (const tx of transactions) {
      assert.strictEqual(typeof tx.getValidationErrors()[0], 'string')
    }
  })

  it('isValid() -> should validate', () => {
    for (const tx of transactions) {
      assert.strictEqual(typeof tx.isValid(), 'boolean')
    }
  })

  it('getIntrinsicGas() -> should return base fee', () => {
    const tx = createLegacyTx({})
    assert.strictEqual(tx.getIntrinsicGas(), BigInt(53000))
  })

  it('getDataGas() -> should return data fee', () => {
    let tx = createLegacyTx({})
    assert.strictEqual(tx.getDataGas(), BigInt(0))

    tx = createLegacyTxFromBytesArray(
      txsData[3].raw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
    )
    assert.strictEqual(tx.getDataGas(), BigInt(1716))

    tx = createLegacyTxFromBytesArray(
      txsData[3].raw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
      { freeze: false },
    )
    assert.strictEqual(tx.getDataGas(), BigInt(1716))
  })

  it('getDataGas() -> should return correct data fee for istanbul', () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Istanbul })
    let tx = createLegacyTx({}, { common })
    assert.strictEqual(tx.getDataGas(), BigInt(0))

    tx = createLegacyTxFromBytesArray(
      txsData[3].raw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
      {
        common,
      },
    )
    assert.strictEqual(tx.getDataGas(), BigInt(1716))
  })

  it('getDataGas() -> should invalidate cached value on hardfork change', () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Byzantium })
    const tx = createLegacyTxFromBytesArray(
      txsData[0].raw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
      {
        common,
      },
    )
    assert.strictEqual(tx.getDataGas(), BigInt(656))
    tx.common.setHardfork(Hardfork.Istanbul)
    assert.strictEqual(tx.getDataGas(), BigInt(240))
  })

  it('getEffectivePriorityFee() -> should return correct values', () => {
    const tx = createLegacyTx({
      gasPrice: BigInt(100),
    })

    assert.strictEqual(tx.getEffectivePriorityFee(), BigInt(100))
    assert.strictEqual(tx.getEffectivePriorityFee(BigInt(20)), BigInt(80))
    assert.strictEqual(tx.getEffectivePriorityFee(BigInt(100)), BigInt(0))
    assert.throws(() => tx.getEffectivePriorityFee(BigInt(101)))
  })

  it('getUpfrontCost() -> should return upfront cost', () => {
    const tx = createLegacyTx({
      gasPrice: 1000,
      gasLimit: 10000000,
      value: 42,
    })
    assert.strictEqual(tx.getUpfrontCost(), BigInt(10000000042))
  })

  it('serialize()', () => {
    for (const [i, tx] of transactions.entries()) {
      const s1 = tx.serialize()
      // Tron format inserts empty tokenId/tokenValue between value and data
      const tronRaw = [...txsData[i].raw.slice(0, 5), '0x', '0x', ...txsData[i].raw.slice(5)]
      const s2 = RLP.encode(tronRaw)
      assert.isTrue(equalsBytes(s1, s2))
    }
  })

  it('serialize() -> should round trip decode a tx', () => {
    const tx = createLegacyTx({ value: 5000 })
    const s1 = tx.serialize()

    const tx2 = createLegacyTxFromRLP(s1)
    const s2 = tx2.serialize()

    assert.isTrue(equalsBytes(s1, s2))
  })

  it('hash() / getHashedMessageToSign() / getMessageToSign()', () => {
    const common = new Common({
      chain: Mainnet,
      hardfork: Hardfork.TangerineWhistle,
    })

    let tx = createLegacyTxFromBytesArray(
      txsData[3].raw.slice(0, 6).map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
      {
        common,
      },
    )
    assert.throws(
      () => {
        tx.hash()
      },
      undefined,
      undefined,
      'should throw calling hash with unsigned tx',
    )
    tx = createLegacyTxFromBytesArray(
      txsData[3].raw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
      {
        common,
      },
    )
    assert.deepEqual(
      tx.hash(),
      hexToBytes('0xd0d7f34b9076ac01ee262649b580f2299fd4353f11fd313185d8a0a8a79b8d00'),
    )
    assert.deepEqual(
      tx.getHashedMessageToSign(),
      hexToBytes('0x9610731b614a8c8380ef10d30e5ad53dc0a111bfc3754410b9e9fb0cf5889eb3'),
    )
    assert.strictEqual(tx.getMessageToSign().length, 8)
    assert.deepEqual(
      tx.hash(),
      hexToBytes('0xd0d7f34b9076ac01ee262649b580f2299fd4353f11fd313185d8a0a8a79b8d00'),
    )
  })

  it('hash() -> with defined chainId', () => {
    const tx = createLegacyTxFromBytesArray(
      txsData[4].raw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
    )
    assert.strictEqual(
      bytesToHex(tx.hash()),
      '0x44587c0e7d0b6275fc1db63d69ee3f8f41ae538a7b485a607c60b14186dc69b0',
    )
    assert.strictEqual(
      bytesToHex(tx.hash()),
      '0x44587c0e7d0b6275fc1db63d69ee3f8f41ae538a7b485a607c60b14186dc69b0',
    )
    assert.strictEqual(
      bytesToHex(tx.getHashedMessageToSign()),
      '0x292bf3de19388e507919a45c33198573c62ce9e0fbcf7e8d26175818cc38237d',
    )
  })

  it("getHashedMessageToSign(), getSenderPublicKey() (implicit call) -> verify EIP155 signature based on Vitalik's tests", () => {
    for (const tx of transactionTestEip155VitalikTestsData) {
      const pt = createLegacyTxFromRLP(hexToBytes(tx.rlp as PrefixedHexString))
      assert.strictEqual(bytesToHex(pt.getHashedMessageToSign()), `0x${tx.hash}`)
      assert.strictEqual(bytesToHex(pt.serialize()), tx.rlp)
      assert.strictEqual(pt.getSenderAddress().toString(), `0x${tx.sender}`)
    }
  })

  it('sign() -> hedged signatures test', () => {
    const privateKey = hexToBytes(
      '0x4646464646464646464646464646464646464646464646464646464646464646',
    )
    // Verify 1000 signatures to ensure these have unique hashes (hedged signatures test)
    const tx = createLegacyTx({})
    const hashSet = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const hash = bytesToHex(tx.sign(privateKey, true).hash())
      if (hashSet.has(hash)) {
        assert.fail('should not reuse the same hash (hedged signature test)')
      }
      hashSet.add(hash)
    }
  })

  it('getHashedMessageToSign(), sign(), getSenderPublicKey() (implicit call) -> verify EIP155 signature before and after signing', () => {
    // Inputs and expected results for this test are taken directly from the example in https://eips.ethereum.org/EIPS/eip-155
    const txRaw = [
      '0x09',
      '0x4a817c800',
      '0x5208',
      '0x3535353535353535353535353535353535353535',
      '0x0de0b6b3a7640000',
      '0x',
    ]
    const privateKey = hexToBytes(
      '0x4646464646464646464646464646464646464646464646464646464646464646',
    )
    const pt = createLegacyTxFromBytesArray(
      txRaw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
    )

    // Note that Vitalik's example has a very similar value denoted "signing data".
    // It's not the output of `serialize()`, but the pre-image of the hash returned by `tx.hash(false)`.
    // We don't have a getter for such a value in LegacyTx.
    assert.strictEqual(
      bytesToHex(pt.serialize()),
      '0xee098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a7640000808080808080',
    )
    const signedTx = pt.sign(privateKey)
    assert.strictEqual(
      bytesToHex(signedTx.getHashedMessageToSign()),
      '0x5703945c76baf5811a7fb65a70a7c5043896bfcf05ed449371df4b8b2e8e42de',
    )
    assert.strictEqual(
      bytesToHex(signedTx.serialize()),
      '0xf86e098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080808026a0c71345e2e234a8356b4947ea8977d1037a40f560559c4b687f7ff445687e51a0a03c82ff47683b95051b2a871674373990d7f0a83b339389129262d31fb0dff302',
    )
  })

  it('sign(), getSenderPublicKey() (implicit call) -> EIP155 hashing when singing', () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Petersburg })
    for (const txData of txsData.slice(0, 3)) {
      const tx = createLegacyTxFromBytesArray(
        txData.raw.slice(0, 6).map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
        {
          common,
        },
      )

      const privKey = hexToBytes(`0x${txData.privateKey}`)
      const txSigned = tx.sign(privKey)

      assert.strictEqual(
        txSigned.getSenderAddress().toString(),
        '0x' + txData.sendersAddress,
        "computed sender address should equal the fixture's one",
      )
    }
  })

  it('sign(), serialize(): serialize correctly after being signed with EIP155 Signature for tx created on mainnet', () => {
    const txRaw = [
      '0x1',
      '0x02540be400',
      '0x5208',
      '0xd7250824390ec5c8b71d856b5de895e271170d9d',
      '0x0de0b6b3a7640000',
      '0x',
    ]
    const privateKey = hexToBytes(
      '0xDE3128752F183E8930D7F00A2AAA302DCB5E700B2CBA2D8CA5795660F07DEFD5',
    )
    const common = createCustomCommon({ chainId: 3 }, Mainnet)
    const tx = createLegacyTxFromBytesArray(
      txRaw.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
      { common },
    )
    const signedTx = tx.sign(privateKey)
    assert.strictEqual(
      bytesToHex(signedTx.serialize()),
      '0xf86e018502540be40082520894d7250824390ec5c8b71d856b5de895e271170d9d880de0b6b3a764000080808029a06c79d86b9367c7736131a43162499df6532bafbb931eac36ed90e4ba1cb45ea0a02d99a0e68b96e7b2d37187bfddd829f7c8da87aad3d79caf25ce27e6bb9bfd31',
    )
  })

  it('sign(), verifySignature(): should ignore any previous signature when decided if EIP155 should be used in a new one', () => {
    const txData: TxData[typeof TransactionType.Legacy] = {
      data: '0x7cf5dab00000000000000000000000000000000000000000000000000000000000000005',
      gasLimit: '0x15f90',
      gasPrice: '0x1',
      nonce: '0x01',
      to: '0xd9024df085d09398ec76fbed18cac0e1149f50dc',
      value: '0x0',
    }

    const privateKey = hexToBytes(
      '0x4646464646464646464646464646464646464646464646464646464646464646',
    )

    const common = new Common({
      chain: Mainnet,
      hardfork: Hardfork.TangerineWhistle,
    })

    const fixtureTxSignedWithoutEIP155 = createLegacyTx(txData, {
      common,
    }).sign(privateKey)

    let signedWithEIP155 = createLegacyTx(txData).sign(privateKey)

    assert.isTrue(signedWithEIP155.verifySignature())
    assert.notEqual(signedWithEIP155.v?.toString(16), '1c')
    assert.notEqual(signedWithEIP155.v?.toString(16), '1b')

    signedWithEIP155 = createLegacyTx(fixtureTxSignedWithoutEIP155.toJSON()).sign(privateKey)

    assert.isTrue(signedWithEIP155.verifySignature())
    assert.notEqual(signedWithEIP155.v?.toString(16), '1c')
    assert.notEqual(signedWithEIP155.v?.toString(16), '1b')

    let signedWithoutEIP155 = createLegacyTx(txData, {
      common,
    }).sign(privateKey)

    assert.isTrue(signedWithoutEIP155.verifySignature())
    assert.isTrue(
      signedWithoutEIP155.v?.toString(16) === '1c' || signedWithoutEIP155.v?.toString(16) === '1b',
      "v shouldn't be EIP155 encoded",
    )

    signedWithoutEIP155 = createLegacyTx(txData, {
      common,
    }).sign(privateKey)

    assert.isTrue(signedWithoutEIP155.verifySignature())
    assert.isTrue(
      signedWithoutEIP155.v?.toString(16) === '1c' || signedWithoutEIP155.v?.toString(16) === '1b',
      "v shouldn't be EIP155 encoded",
    )
  })

  it('constructor: throw on legacy transactions which have v !== 27 and v !== 28 and v < 37', () => {
    function getTxData(v: number) {
      return {
        v,
      }
    }
    for (let n = 0; n < 27; n++) {
      assert.throws(() => createLegacyTx(getTxData(n)))
    }
    assert.throws(() => createLegacyTx(getTxData(29)))
    assert.throws(() => createLegacyTx(getTxData(36)))

    assert.doesNotThrow(() => createLegacyTx(getTxData(27)))
    assert.doesNotThrow(() => createLegacyTx(getTxData(28)))
    assert.doesNotThrow(() => createLegacyTx(getTxData(37)))
  })

  it('sign(), verifySignature(): sign tx with chainId specified in params', () => {
    const common = new Common({ chain: goerliChainConfig, hardfork: Hardfork.Petersburg })
    let tx = createLegacyTx({}, { common })
    assert.strictEqual(tx.common.chainId(), BigInt(5))

    const privKey = hexToBytes(`0x${txsData[0].privateKey}`)
    tx = tx.sign(privKey)

    const serialized = tx.serialize()

    const reTx = createLegacyTxFromRLP(serialized, { common })
    assert.strictEqual(reTx.verifySignature(), true)
    assert.strictEqual(reTx.common.chainId(), BigInt(5))
  })

  it('freeze property propagates from unsigned tx to signed tx', () => {
    const tx = createLegacyTx({}, { freeze: false })
    assert.isFalse(Object.isFrozen(tx), 'tx object is not frozen')
    const privKey = hexToBytes(`0x${txsData[0].privateKey}`)
    const signedTxn = tx.sign(privKey)
    assert.isFalse(Object.isFrozen(signedTxn), 'tx object is not frozen')
  })

  it('common propagates from the common of tx, not the common in TxOptions', () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.London })
    const pkey = hexToBytes(`0x${txsData[0].privateKey}`)
    const txn = createLegacyTx({}, { common, freeze: false })
    const newCommon = new Common({ chain: Mainnet, hardfork: Hardfork.Paris })
    assert.notDeepEqual(newCommon, common, 'new common is different than original common')
    Object.defineProperty(txn, 'common', {
      get() {
        return newCommon
      },
    })
    const signedTxn = txn.sign(pkey)
    assert.strictEqual(
      signedTxn.common.hardfork(),
      Hardfork.Paris,
      'signed tx common is taken from tx.common',
    )
  })

  it('isSigned() -> returns correct values', () => {
    let tx = createLegacyTx({})
    assert.isFalse(tx.isSigned())

    const txData: TxData[typeof TransactionType.Legacy] = {
      data: '0x7cf5dab00000000000000000000000000000000000000000000000000000000000000005',
      gasLimit: '0x15f90',
      gasPrice: '0x1',
      nonce: '0x01',
      to: '0xd9024df085d09398ec76fbed18cac0e1149f50dc',
      value: '0x0',
    }
    const privateKey = hexToBytes(
      '0x4646464646464646464646464646464646464646464646464646464646464646',
    )
    tx = createLegacyTx(txData)
    assert.isFalse(tx.isSigned())
    tx = tx.sign(privateKey)
    assert.isTrue(tx.isSigned())

    tx = createLegacyTx(txData)
    assert.isFalse(tx.isSigned())
    const rawUnsigned = tx.serialize()
    tx = tx.sign(privateKey)
    const rawSigned = tx.serialize()
    assert.isTrue(tx.isSigned())

    tx = createLegacyTxFromRLP(rawUnsigned)
    assert.isFalse(tx.isSigned())
    tx = tx.sign(privateKey)
    assert.isTrue(tx.isSigned())
    tx = createLegacyTxFromRLP(rawSigned)
    assert.isTrue(tx.isSigned())

    const signedValues = RLP.decode(Uint8Array.from(rawSigned)) as Uint8Array[]
    tx = createLegacyTxFromBytesArray(signedValues)
    assert.isTrue(tx.isSigned())
    tx = createLegacyTxFromBytesArray(signedValues.slice(0, 6))
    assert.isFalse(tx.isSigned())
  })
})
