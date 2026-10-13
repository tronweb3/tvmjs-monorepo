import { postMergeGethGenesis } from '@tvmjs/testdata'
import { describe, expect, it } from 'vitest'

import { Common, TronMainnet, TronNile, TronShasta, parseGethGenesis } from '../src/index.ts'

describe.each([TronMainnet, TronNile, TronShasta])(
  'removed Blob configuration on $name',
  (chain) => {
    it('cannot activate Blob execution or expose a Blob gas schedule', () => {
      const common = new Common({ chain })
      for (const eip of [4844, 7516, 7594, 7691, 7892, 7918]) {
        expect(common.isActivatedEIP(eip)).toBe(false)
        expect(() => common.setEIPs([eip])).toThrow(/not supported/)
        expect(() => common.paramByEIP('blobGasPerBlob', eip)).toThrow(/not supported/)
      }
      expect(common).not.toHaveProperty('getBlobGasSchedule')
    })

    it('rejects removed crypto and genesis fields, including null and undefined', () => {
      for (const value of [undefined, null, 0, 0n, '0x0', {}]) {
        expect(() => new Common({ chain, customCrypto: { kzg: value } } as any)).toThrow(
          'customCrypto.kzg is no longer supported',
        )
        for (const field of ['excessBlobGas', 'blobGasUsed']) {
          expect(
            () => new Common({ chain: { ...chain, genesis: { [field]: value } } } as any),
          ).toThrow('Blob gas fields are not supported')
        }
      }
    })
  },
)

it('rejects removed Blob genesis fields before parsing or copying configuration data', () => {
  for (const value of [undefined, null, 0, 0n, '0x0', {}]) {
    for (const field of ['excessBlobGas', 'blobGasUsed']) {
      expect(() => parseGethGenesis({ ...postMergeGethGenesis, [field]: value })).toThrow(
        'Blob gas fields are not supported',
      )
    }
    expect(() =>
      parseGethGenesis({
        ...postMergeGethGenesis,
        config: { ...postMergeGethGenesis.config, blobSchedule: value },
      } as any),
    ).toThrow('blobSchedule is not supported')
  }
})

describe.each(['excessBlobGas', 'blobGasUsed'])('Geth genesis %s field presence', (field) => {
  it.each(['inherited', 'non-enumerable'])(
    'rejects %s fields before copying the input',
    (placement) => {
      for (const value of [undefined, null, 0, 0n, '0x0', {}]) {
        const genesis =
          placement === 'inherited'
            ? Object.assign(Object.create({ [field]: value }), postMergeGethGenesis)
            : Object.defineProperty({ ...postMergeGethGenesis }, field, { value })
        expect(() => parseGethGenesis(genesis)).toThrow('Blob gas fields are not supported')
      }
    },
  )

  it('rejects the retired field before evaluating input getters', () => {
    const genesis = {
      ...postMergeGethGenesis,
      [field]: undefined,
      get extraData(): string {
        throw new Error('Input must be rejected before reading extraData')
      },
    }
    expect(() => parseGethGenesis(genesis)).toThrow('Blob gas fields are not supported')
  })
})

it('rejects inherited and non-enumerable Blob schedules in raw data', () => {
  for (const value of [undefined, null, {}]) {
    const configs = [
      Object.assign(Object.create({ blobSchedule: value }), postMergeGethGenesis.config),
      Object.defineProperty({ ...postMergeGethGenesis.config }, 'blobSchedule', { value }),
    ]
    for (const config of configs) {
      expect(() => parseGethGenesis({ ...postMergeGethGenesis, config })).toThrow(
        'blobSchedule is not supported',
      )
    }
  }
})
