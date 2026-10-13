import { assert, describe, it } from 'vitest'

import { bytesToHex } from '@tvmjs/util'

import {
  canEncodeLocally,
  transactionId,
  transactionToPb,
} from '../../src/dialect/tron/wallet/encode.ts'

import type { SignedTronTx } from '../../src/dialect/tron/wallet/types.ts'

const envelope = (over: Record<string, unknown> = {}): SignedTronTx =>
  ({
    txID: '',
    raw_data: {
      ref_block_bytes: '0001',
      ref_block_hash: '3733eddf4d46796a',
      expiration: 1_787_109_655_635,
      timestamp: 1_787_109_595_635,
      contract: [],
      ...over,
    },
  }) as unknown as SignedTronTx

const transfer = (value: Record<string, unknown>) =>
  envelope({
    contract: [
      {
        type: 'TransferContract',
        parameter: { value, type_url: 'type.googleapis.com/protocol.TransferContract' },
      },
    ],
  })

const address = (byte: string) => `41${byte.repeat(20)}`

/** Read wire integers independently of the transaction encoder's generated getters. */
function rawIntegers(bytes: Uint8Array): Map<number, bigint> {
  const fields = new Map<number, bigint>()
  let offset = 0
  const read = (): bigint => {
    let value = 0n
    for (let shift = 0n; ; shift += 7n) {
      const byte = bytes[offset++]
      value |= BigInt(byte & 127) << shift
      if ((byte & 128) === 0) return value
    }
  }
  while (offset < bytes.length) {
    const tag = read()
    if ((tag & 7n) === 0n) fields.set(Number(tag >> 3n), BigInt.asIntN(64, read()))
    else {
      assert.strictEqual(tag & 7n, 2n)
      const length = Number(read())
      offset += length
    }
  }
  return fields
}

const deployment = (version: number, parameter?: string): SignedTronTx =>
  envelope({
    contract: [
      {
        type: 'CreateSmartContract',
        parameter: {
          type_url: 'type.googleapis.com/protocol.CreateSmartContract',
          value: {
            owner_address: address('11'),
            new_contract: {
              origin_address: address('11'),
              abi: { entrys: [] },
              bytecode: '60006000f3',
              name: 'example',
              consume_user_resource_percent: 100,
              origin_energy_limit: 1,
              version,
              ...(parameter === undefined ? {} : { parameter }),
            },
          },
        },
      },
    ],
  })

describe('transaction encoding', () => {
  for (const type of ['', 'TransferContract', 'AssetIssueContract', 'UnfreezeAssetContract']) {
    const tx = () =>
      envelope({
        contract:
          type === ''
            ? []
            : [
                {
                  type,
                  parameter: {
                    type_url: `type.googleapis.com/protocol.${type}`,
                    value: {
                      owner_address: address('11'),
                      to_address: address('22'),
                      amount: 1,
                      name: '41',
                      total_supply: 1,
                      trx_num: 1,
                      num: 1,
                    },
                  },
                },
              ],
      })
    it(`keeps every envelope integer exact for ${type || 'an empty contract list'}`, () => {
      for (const [field, tag] of Object.entries({
        ref_block_num: 3,
        expiration: 8,
        timestamp: 14,
        fee_limit: 18,
      })) {
        for (const value of [0, 22, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
          for (const input of [value, BigInt(value), String(value)]) {
            const draft = tx()
            Object.assign(draft.raw_data, { [field]: input })
            const before = structuredClone(draft)
            const fields = rawIntegers(transactionToPb(draft).getRawData().serializeBinary())
            assert.strictEqual(fields.get(tag) ?? 0n, BigInt(value))
            assert.deepEqual(draft, before)
          }
        }
      }
    })
    it(`rejects unrepresentable envelope integers for ${type || 'an empty contract list'}`, () => {
      for (const field of ['ref_block_num', 'expiration', 'timestamp', 'fee_limit']) {
        for (const input of [
          9007199254740993n,
          '9007199254740993',
          '-9007199254740993',
          '9223372036854775807',
          Number.MAX_SAFE_INTEGER + 1,
          1.5,
          'bad',
          true,
        ]) {
          const draft = tx()
          Object.assign(draft.raw_data, { [field]: input })
          assert.throws(() => transactionToPb(draft), new RegExp(`raw_data.${field}`))
        }
      }
    })
  }

  it('knows which contract types it encodes itself', () => {
    // the bundled helper covers most types; this table holds the ones it does not
    assert.isTrue(canEncodeLocally('UnfreezeAssetContract'))
    assert.isFalse(canEncodeLocally('TransferContract'))
    assert.isFalse(canEncodeLocally('NoSuchContract'))
    assert.isFalse(canEncodeLocally(''))
  })

  it('encodes an envelope with no contract at all', () => {
    const pb = transactionToPb(envelope())
    assert.strictEqual(pb.getRawData().getRefBlockBytes_asU8().length, 2)
    assert.strictEqual(pb.getRawData().getExpiration(), 1_787_109_655_635)
  })

  it('carries the optional envelope fields only where they are set', () => {
    const bare = transactionToPb(
      envelope({ expiration: 0, timestamp: 0, fee_limit: 0, data: '' }),
    ).getRawData()
    assert.strictEqual(bare.getExpiration(), 0)
    assert.strictEqual(bare.getFeeLimit(), 0)
    assert.strictEqual(bare.getData_asU8().length, 0)

    const full = transactionToPb(envelope({ fee_limit: 1_000_000, data: '6d656d6f' })).getRawData()
    assert.strictEqual(full.getFeeLimit(), 1_000_000)
    assert.strictEqual(full.getData_asU8().length, 4)
  })

  it('derives an id from raw_data, ignoring whatever id the request stated', () => {
    const tx = transfer({
      owner_address: '4171b0af54e0a1182a5e0947d6a64f3b22740ef318',
      to_address: '41928c9af0651632157ef27a2cf17ca72c575a4d21',
      amount: 1,
    })
    const id = transactionId(tx)
    assert.match(id, /^[0-9a-f]{64}$/)
    // the stated id is not a protobuf field, so it cannot move the result
    ;(tx as unknown as { txID: string }).txID = 'f'.repeat(64)
    assert.strictEqual(transactionId(tx), id)
  })

  it('gives two different transfers two different ids', () => {
    const one = transactionId(
      transfer({
        owner_address: '4171b0af54e0a1182a5e0947d6a64f3b22740ef318',
        to_address: '41928c9af0651632157ef27a2cf17ca72c575a4d21',
        amount: 1,
      }),
    )
    const two = transactionId(
      transfer({
        owner_address: '4171b0af54e0a1182a5e0947d6a64f3b22740ef318',
        to_address: '41928c9af0651632157ef27a2cf17ca72c575a4d21',
        amount: 2,
      }),
    )
    assert.notStrictEqual(one, two)
  })

  it('uses its own encoder for a type the bundled helper does not carry', () => {
    const tx = envelope({
      contract: [
        {
          type: 'UnfreezeAssetContract',
          parameter: {
            value: { owner_address: '4171b0af54e0a1182a5e0947d6a64f3b22740ef318' },
            type_url: 'type.googleapis.com/protocol.UnfreezeAssetContract',
          },
        },
      ],
    })
    assert.match(transactionId(tx), /^[0-9a-f]{64}$/)
  })

  it('hashes the canonical contract fields that execution reads', () => {
    const resource = (value: string | number) =>
      envelope({
        contract: [
          {
            type: 'FreezeBalanceV2Contract',
            parameter: {
              type_url: 'type.googleapis.com/protocol.FreezeBalanceV2Contract',
              value: { owner_address: address('11'), frozen_balance: 1_000_000, resource: value },
            },
          },
        ],
      })
    assert.strictEqual(transactionId(resource(1)), transactionId(resource('ENERGY')))
    assert.notStrictEqual(transactionId(resource(1)), transactionId(resource('BANDWIDTH')))

    const account = (type: string) =>
      envelope({
        contract: [
          {
            type: 'AccountCreateContract',
            parameter: {
              type_url: 'type.googleapis.com/protocol.AccountCreateContract',
              value: { owner_address: address('11'), account_address: address('22'), type },
            },
          },
        ],
      })
    assert.notStrictEqual(transactionId(account('Normal')), transactionId(account('AssetIssue')))

    assert.notStrictEqual(transactionId(deployment(0)), transactionId(deployment(1)))
    // Constructor bytes are folded into bytecode by a builder.  They are not
    // an independent raw-transaction field that execution may reinterpret.
    assert.strictEqual(transactionId(deployment(0)), transactionId(deployment(0, '6001')))
  })

  it('keeps signed envelope and contract metadata in the protobuf', () => {
    const tx = transfer({
      owner_address: address('11'),
      to_address: address('22'),
      amount: 1,
    })
    tx.raw_data.ref_block_num = 22
    tx.raw_data.scripts = '01'
    tx.raw_data.auths = [
      {
        permission_name: '7065726d',
        account: { name: '6e616d65', address: address('11') },
      },
    ]
    tx.raw_data.contract[0].provider = '70726f7669646572'
    tx.raw_data.contract[0].ContractName = '6e616d65'

    const raw = transactionToPb(tx).getRawData() as unknown as {
      getRefBlockNum(): number
      getScripts_asU8(): Uint8Array
      getAuthsList(): {
        getPermissionName_asU8(): Uint8Array
        getAccount(): { getName_asU8(): Uint8Array; getAddress_asU8(): Uint8Array }
      }[]
      getContractList(): {
        getProvider_asU8(): Uint8Array
        getContractname_asU8(): Uint8Array
        getParameter(): { getTypeUrl(): string }
      }[]
    }
    assert.strictEqual(raw.getRefBlockNum(), 22)
    assert.strictEqual(bytesToHex(raw.getScripts_asU8()).slice(2), '01')
    assert.deepEqual(
      raw
        .getAuthsList()
        .map((authority) => [
          bytesToHex(authority.getPermissionName_asU8()).slice(2),
          bytesToHex(authority.getAccount().getName_asU8()).slice(2),
          bytesToHex(authority.getAccount().getAddress_asU8()).slice(2),
        ]),
      [['7065726d', '6e616d65', address('11')]],
    )
    const contract = raw.getContractList()[0]
    assert.strictEqual(bytesToHex(contract.getProvider_asU8()).slice(2), '70726f7669646572')
    assert.strictEqual(bytesToHex(contract.getContractname_asU8()).slice(2), '6e616d65')
    assert.strictEqual(
      contract.getParameter().getTypeUrl(),
      'type.googleapis.com/protocol.TransferContract',
    )
  })
})
