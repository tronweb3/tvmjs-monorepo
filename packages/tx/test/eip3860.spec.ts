import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { createZeroAddress, hexToBytes } from '@tvmjs/util'
import { describe, expect, it } from 'vitest'

import {
  AccessList2930Tx,
  Capability,
  FeeMarket1559Tx,
  LegacyTx,
  TransactionType,
  createTx,
  createTxFromRLP,
  paramsTx,
} from '../src/index.ts'

const txTypes = [
  TransactionType.Legacy,
  TransactionType.AccessListEIP2930,
  TransactionType.FeeMarketEIP1559,
]

describe.each([TronMainnet, TronNile, TronShasta])('TRON initcode on $name', (chain) => {
  it.each([0, 31, 32, 33, 49151, 49152, 49153])(
    'does not limit or charge word gas for %s bytes',
    (size) => {
      const common = new Common({ chain })
      const data = new Uint8Array(size)
      for (const type of txTypes) {
        const deployment = createTx({ type, data }, { common })
        const call = createTx({ type, data, to: createZeroAddress() }, { common })
        expect(deployment.data).toEqual(data)
        expect(deployment.getDataGas()).toBe(call.getDataGas())
        expect(deployment.getDataGas()).toBe(BigInt(size) * 4n)
        expect(deployment.getIntrinsicGas()).toBe(53000n + BigInt(size) * 4n)
        expect(call.getIntrinsicGas()).toBe(21000n + BigInt(size) * 4n)
      }
    },
  )

  it('retains data byte fees with obsolete custom initcode parameters', () => {
    const params = structuredClone(paramsTx)
    params[1].maxInitCodeSize = 1
    params[1].initCodeWordGas = 1000000
    for (const type of txTypes) {
      const data = new Uint8Array(49153)
      data[0] = 1
      data[data.length - 1] = 255
      const tx = createTx({ type, data }, { common: new Common({ chain }), params })
      expect(tx.getDataGas()).toBe(BigInt(data.length - 2) * 4n + 32n)
      expect(tx.getIntrinsicGas()).toBe(53000n + tx.getDataGas())
      expect(paramsTx).not.toHaveProperty('3860')
    }
  })

  it('preserves signing, replay protection and serialization for large deployments', () => {
    const common = new Common({ chain })
    const privateKey = hexToBytes(`0x${'20'.repeat(32)}`)
    for (const type of txTypes) {
      const tx = createTx(
        { type, data: new Uint8Array(49153), gasLimit: 1000000n },
        { common },
      ).sign(privateKey)
      const decoded = createTxFromRLP(tx.serialize(), { common })
      expect(decoded.hash()).toEqual(tx.hash())
      expect(decoded.getSenderAddress().equals(tx.getSenderAddress())).toBe(true)
      expect(decoded.verifySignature()).toBe(true)
      expect(decoded.data).toEqual(tx.data)
      expect(decoded.getIntrinsicGas()).toBe(249612n)
      if (type === TransactionType.Legacy) {
        expect(tx.supports(Capability.EIP155ReplayProtection)).toBe(true)
        expect([35n, 36n]).toContain(tx.v! - 2n * common.chainId())
      }
    }
  })

  it('rejects the removed initcode bypass option on factories, decoders and constructors', () => {
    const common = new Common({ chain })
    const before = common.copy()
    for (const type of txTypes) {
      const encoded = createTx({ type }, { common }).serialize()
      for (const value of [true, false, undefined, null]) {
        for (const opts of [
          { common, allowUnlimitedInitCodeSize: value },
          Object.assign(Object.create({ allowUnlimitedInitCodeSize: value }), { common }),
        ]) {
          expect(() => createTx({ type }, opts)).toThrow(
            /allowUnlimitedInitCodeSize option has been removed/,
          )
          expect(() => createTxFromRLP(encoded, opts)).toThrow(
            /allowUnlimitedInitCodeSize option has been removed/,
          )
          const Constructor = [LegacyTx, AccessList2930Tx, FeeMarket1559Tx][type]
          expect(() => new Constructor({}, opts)).toThrow(
            /allowUnlimitedInitCodeSize option has been removed/,
          )
        }
      }
    }
    expect(common.isCompatibleWith(before)).toBe(true)
  })
})
