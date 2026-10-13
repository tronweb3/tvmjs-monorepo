import { TronWeb, utils } from 'tronweb'
import { assert, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { packContracts } from '../../src/dialect/tron/wallet/pack.ts'
import { printTransaction } from '../../src/dialect/tron/wallet/print.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'

/**
 * A built transaction leaves through a protobuf printer: keys in proto field
 * order, enums by member name, zero values left off — whatever spelling and
 * order the request used.
 */
describe('the printed contract of a built transaction', () => {
  let provider: TronProvider
  let ownerKey = ''
  let ownerHex = ''
  let otherHex = ''

  const build = async (path: string, body: Record<string, unknown>) =>
    (await provider.request({ method: path, params: body as never })) as {
      raw_data?: { contract: { parameter: { value: Record<string, unknown> } }[] }
      Error?: string
    }
  const valueOf = (built: Awaited<ReturnType<typeof build>>): Record<string, unknown> => {
    assert.isUndefined(built.Error, built.Error)
    return built.raw_data?.contract[0].parameter.value ?? {}
  }

  beforeAll(async () => {
    const config = resolveConfig()
    provider = new TronProvider(await TronNode.create(config))
    ownerKey = accountsFromMnemonic(config.mnemonic)[0].privateKey
    ownerHex = TronWeb.address.toHex(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[0].privateKey) as string,
    )
    otherHex = TronWeb.address.toHex(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[1].privateKey) as string,
    )
  })

  it('orders the stake family by field number and names the resource', async () => {
    // a delegation needs a stake behind it, so the freeze is signed and sent
    const freeze = await build('wallet/freezebalancev2', {
      owner_address: ownerHex,
      frozen_balance: 2_000_000_000,
      resource: 1,
    })
    assert.isUndefined(freeze.Error, freeze.Error)
    // the in-process reply keeps bigints, which the signer cannot ingest —
    // clone it as a wire reader would see it
    const wire = JSON.parse(
      JSON.stringify(freeze, (_key, held) => (typeof held === 'bigint' ? Number(held) : held)),
    )
    const sent = (await provider.request({
      method: 'wallet/broadcasttransaction',
      params: utils.crypto.signTransaction(ownerKey, wire as never) as never,
    })) as { result?: boolean; txid?: string }
    assert.isTrue(sent.result, JSON.stringify(sent))
    const stored = valueOf(
      (await provider.request({
        method: 'wallet/gettransactionbyid',
        params: { value: sent.txid ?? '' } as never,
      })) as Awaited<ReturnType<typeof build>>,
    )
    assert.deepEqual(Object.keys(stored), ['owner_address', 'frozen_balance', 'resource'])
    assert.strictEqual(stored.resource, 'ENERGY')
    const delegate = valueOf(
      await build('wallet/delegateresource', {
        receiver_address: otherHex,
        balance: 1_000_000,
        owner_address: ownerHex,
        resource: 'ENERGY',
      }),
    )
    assert.deepEqual(Object.keys(delegate), [
      'owner_address',
      'resource',
      'balance',
      'receiver_address',
    ])
    assert.strictEqual(delegate.resource, 'ENERGY')
    // the zero member is the default, which a printer leaves off
    const bandwidth = valueOf(
      await build('wallet/freezebalancev2', {
        owner_address: ownerHex,
        frozen_balance: 1_000_000,
        resource: 0,
      }),
    )
    assert.deepEqual(Object.keys(bandwidth), ['owner_address', 'frozen_balance'])
    const energy = valueOf(
      await build('wallet/freezebalancev2', {
        owner_address: ownerHex,
        frozen_balance: 1_000_000,
        resource: 1,
      }),
    )
    assert.strictEqual(energy.resource, 'ENERGY')
  })

  it('prints permissions in proto order, naming the type and dropping defaults', async () => {
    const value = valueOf(
      await build('wallet/accountpermissionupdate', {
        owner_address: ownerHex,
        owner: {
          keys: [{ weight: 1, address: ownerHex }],
          threshold: 1,
          permission_name: 'owner',
          type: 0,
          id: 0,
        },
        actives: [
          {
            keys: [{ address: ownerHex, weight: 1 }],
            operations: '7fff1fc0033ec30f000000000000000000000000000000000000000000000000',
            threshold: 1,
            permission_name: 'active',
            type: 2,
          },
        ],
      }),
    )
    const owner = value.owner as Record<string, unknown>
    assert.deepEqual(Object.keys(owner), ['permission_name', 'threshold', 'keys'])
    assert.deepEqual(Object.keys((owner.keys as Record<string, unknown>[])[0]), [
      'address',
      'weight',
    ])
    const active = (value.actives as Record<string, unknown>[])[0]
    assert.deepEqual(Object.keys(active), [
      'type',
      'permission_name',
      'threshold',
      'operations',
      'keys',
    ])
    assert.strictEqual(active.type, 'Active')
  })

  it('names the account type of a creation, and leaves Normal off', async () => {
    const fresh = TronWeb.address.toHex(utils.accounts.generateAccount().address.base58)
    const declared = valueOf(
      await build('wallet/createaccount', {
        owner_address: ownerHex,
        account_address: fresh,
        type: 1,
      }),
    )
    assert.strictEqual(declared.type, 'AssetIssue')
    const normal = valueOf(
      await build('wallet/createaccount', {
        owner_address: ownerHex,
        account_address: fresh,
        type: 0,
      }),
    )
    assert.notProperty(normal, 'type')
  })

  it('prints the legacy stake contracts in their protobuf order', async () => {
    const legacyConfig = resolveConfig({ chainParameters: { unfreezeDelayDays: 0 } })
    const legacyNode = await TronNode.create(legacyConfig)
    const legacyProvider = new TronProvider(legacyNode)
    const legacyOwnerBase58 = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(legacyConfig.mnemonic)[0]!.privateKey,
    )
    assert.isString(legacyOwnerBase58)
    const legacyOwner = String(legacyOwnerBase58)
    const legacyOwnerHex = TronWeb.address.toHex(legacyOwner)
    const legacyBuild = async (path: string, body: Record<string, unknown>) =>
      (await legacyProvider.request({ method: path, params: body as never })) as {
        raw_data?: { contract: { parameter: { value: Record<string, unknown> } }[] }
        Error?: string
      }

    const freeze = await legacyBuild('wallet/freezebalance', {
      owner_address: legacyOwnerHex,
      frozen_balance: 1_000_000,
      frozen_duration: 3,
      resource: 1,
    })
    assert.isUndefined(freeze.Error, freeze.Error)
    const freezeValue = freeze.raw_data?.contract[0].parameter.value ?? {}
    assert.deepEqual(Object.keys(freezeValue), [
      'owner_address',
      'frozen_balance',
      'frozen_duration',
      'resource',
    ])
    assert.strictEqual(freezeValue.resource, 'ENERGY')

    await nodeCore(legacyNode).freezeLegacy(parseTronAddress(legacyOwner), 1_000_000n, 'ENERGY', 3)
    await legacyNode.tre.increaseTime(3 * 86_400 + 3)
    const unfreeze = await legacyBuild('wallet/unfreezebalance', {
      owner_address: legacyOwnerHex,
      resource: 1,
    })
    assert.isUndefined(unfreeze.Error, unfreeze.Error)
    const unfreezeValue = unfreeze.raw_data?.contract[0].parameter.value ?? {}
    assert.deepEqual(Object.keys(unfreezeValue), ['owner_address', 'resource'])
    assert.strictEqual(unfreezeValue.resource, 'ENERGY')
  })

  it('omits nonpositive contract permission IDs without changing the input', () => {
    for (const Permission_id of [-2_147_483_648, -1, 0, 2, 2_147_483_647]) {
      const transaction = {
        raw_data: {
          contract: [
            { type: 'TransferContract', Permission_id, parameter: { value: { amount: 1 } } },
          ],
        },
      }
      const original = structuredClone(transaction)
      const printed = printTransaction(transaction)
      assert.deepEqual(transaction, original)
      assert.strictEqual(
        printed.raw_data.contract[0].Permission_id,
        Permission_id > 0 ? Permission_id : undefined,
      )
    }
  })

  it('orders every contract the signature-inspection echo can carry', () => {
    const values: Record<string, Record<string, unknown>> = {
      ExchangeCreateContract: {
        second_token_balance: 5,
        second_token_id: '32',
        first_token_balance: 3,
        first_token_id: '31',
        owner_address: ownerHex,
      },
      ExchangeInjectContract: { quant: 4, token_id: '31', exchange_id: 2, owner_address: ownerHex },
      ExchangeTransactionContract: {
        expected: 5,
        quant: 4,
        token_id: '31',
        exchange_id: 2,
        owner_address: ownerHex,
      },
      ExchangeWithdrawContract: {
        quant: 4,
        token_id: '31',
        exchange_id: 2,
        owner_address: ownerHex,
      },
      MarketCancelOrderContract: { order_id: 'ab', owner_address: ownerHex },
      MarketSellAssetContract: {
        buy_token_quantity: 5,
        buy_token_id: '32',
        sell_token_quantity: 3,
        sell_token_id: '31',
        owner_address: ownerHex,
      },
      ProposalApproveContract: { is_add_approval: true, proposal_id: 2, owner_address: ownerHex },
      ProposalCreateContract: {
        parameters: [
          { value: 3, key: 2 },
          { value: 2, key: 1 },
        ],
        owner_address: ownerHex,
      },
      ProposalDeleteContract: { proposal_id: 2, owner_address: ownerHex },
      UpdateBrokerageContract: { brokerage: 20, owner_address: ownerHex },
    }
    const expected: Record<string, string[]> = {
      ExchangeCreateContract: [
        'owner_address',
        'first_token_id',
        'first_token_balance',
        'second_token_id',
        'second_token_balance',
      ],
      ExchangeInjectContract: ['owner_address', 'exchange_id', 'token_id', 'quant'],
      ExchangeTransactionContract: [
        'owner_address',
        'exchange_id',
        'token_id',
        'quant',
        'expected',
      ],
      ExchangeWithdrawContract: ['owner_address', 'exchange_id', 'token_id', 'quant'],
      MarketCancelOrderContract: ['owner_address', 'order_id'],
      MarketSellAssetContract: [
        'owner_address',
        'sell_token_id',
        'sell_token_quantity',
        'buy_token_id',
        'buy_token_quantity',
      ],
      ProposalApproveContract: ['owner_address', 'proposal_id', 'is_add_approval'],
      ProposalCreateContract: ['owner_address', 'parameters'],
      ProposalDeleteContract: ['owner_address', 'proposal_id'],
      UpdateBrokerageContract: ['owner_address', 'brokerage'],
    }
    for (const [type, value] of Object.entries(values)) {
      const printed = printTransaction({
        raw_data: { contract: [{ type, parameter: { value } }] },
      })
      const printedValue = printed.raw_data.contract[0].parameter.value as Record<string, unknown>
      assert.deepEqual(Object.keys(printedValue), expected[type], type)
      if (type === 'ProposalCreateContract') {
        assert.deepEqual(Object.keys((printedValue.parameters as Record<string, unknown>[])[0]), [
          'key',
          'value',
        ])
      }
    }

    const shielded = printTransaction({
      raw_data: {
        contract: [
          {
            type: 'ShieldedTransferContract',
            parameter: {
              value: {
                to_amount: 7,
                transparent_to_address: otherHex,
                binding_signature: 'bb',
                receive_description: [
                  {
                    zkproof: '06',
                    c_out: '05',
                    c_enc: '04',
                    epk: '03',
                    note_commitment: '02',
                    value_commitment: '01',
                  },
                ],
                spend_description: [
                  {
                    spend_authority_signature: '06',
                    zkproof: '05',
                    rk: '04',
                    nullifier: '03',
                    anchor: '02',
                    value_commitment: '01',
                  },
                ],
                from_amount: 2,
                transparent_from_address: ownerHex,
              },
            },
          },
        ],
      },
    })
    const shieldedValue = shielded.raw_data.contract[0].parameter.value as Record<string, unknown>
    assert.deepEqual(Object.keys(shieldedValue), [
      'transparent_from_address',
      'from_amount',
      'spend_description',
      'receive_description',
      'binding_signature',
      'transparent_to_address',
      'to_amount',
    ])
    assert.deepEqual(
      Object.keys((shieldedValue.spend_description as Record<string, unknown>[])[0]),
      ['value_commitment', 'anchor', 'nullifier', 'rk', 'zkproof', 'spend_authority_signature'],
    )
    assert.deepEqual(
      Object.keys((shieldedValue.receive_description as Record<string, unknown>[])[0]),
      ['value_commitment', 'note_commitment', 'epk', 'c_enc', 'c_out', 'zkproof'],
    )

    const vote = printTransaction({
      raw_data: {
        contract: [
          {
            type: 'VoteWitnessContract',
            parameter: {
              value: {
                support: true,
                votes: [{ vote_count: 1, vote_address: otherHex }],
                owner_address: ownerHex,
              },
            },
          },
        ],
      },
    })
    const voteValue = vote.raw_data.contract[0].parameter.value as Record<string, unknown>
    assert.deepEqual(Object.keys(voteValue), ['owner_address', 'votes', 'support'])
    assert.deepEqual(Object.keys((voteValue.votes as Record<string, unknown>[])[0]), [
      'vote_address',
      'vote_count',
    ])

    const proposal = {
      raw_data: {
        contract: [
          {
            type: 'ProposalCreateContract',
            parameter: {
              value: {
                owner_address: ownerHex,
                parameters: [
                  { key: 1, value: 2 },
                  { key: 2, value: 3 },
                ],
              },
            },
          },
        ],
      },
    }
    packContracts(proposal as never, false)
    assert.lengthOf(proposal.raw_data.contract, 1)

    // It remains in the protocol schema, but Java TransactionFactory has no
    // actuator/protobuf registration for this retired type. Util.packTransaction
    // drops it before both signature-inspection endpoints see the transaction.
    const retired = {
      raw_data: {
        contract: [
          {
            type: 'VoteAssetContract',
            parameter: {
              value: {
                owner_address: ownerHex,
                vote_address: [otherHex],
                support: true,
                count: 1,
              },
            },
          },
        ],
      },
    }
    packContracts(retired as never, false)
    assert.lengthOf(retired.raw_data.contract, 0)
  })
})
