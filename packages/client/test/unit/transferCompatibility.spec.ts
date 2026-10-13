import { TronWeb, utils } from 'tronweb'
import { assert, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { parseTronAddress, toTronHex } from '../../src/dialect/tron/address.ts'
import { validateForBuild } from '../../src/dialect/tron/wallet/contractAdapter.ts'

describe('contract metadata feature gates', () => {
  it('keeps ClearABI enabled while runtime activation remains configurable', async () => {
    const config = resolveConfig({
      runtime: { energyLimitActivationBlock: 2n },
    })
    const node = await createNode(config, new Clock())
    const owner = parseTronAddress(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[0].privateKey) as string,
    )
    const target = parseTronAddress(utils.accounts.generateAccount().address.base58)

    assert.strictEqual(
      await validateForBuild(nodeCore(node), 'ClearABIContract', {
        owner_address: toTronHex(owner),
        contract_address: toTronHex(target),
      }),
      'Contract not exists',
    )
    assert.strictEqual(
      await validateForBuild(nodeCore(node), 'UpdateEnergyLimitContract', {
        owner_address: toTronHex(owner),
        contract_address: toTronHex(target),
        origin_energy_limit: 1,
      }),
      'contract type error, unexpected type [UpdateEnergyLimitContract]',
    )
  })
})

describe('account-name update gate', () => {
  it('permits replacement and duplicate names only while the proposal is active', async () => {
    const config = resolveConfig({
      chainParameters: { allowUpdateAccountName: 1 },
    })
    const node = await createNode(config, new Clock())
    const owner = parseTronAddress(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[0].privateKey) as string,
    )
    const other = parseTronAddress(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[1].privateKey) as string,
    )
    nodeCore(node).setAccountName(owner, '6f6c64')
    nodeCore(node).setAccountName(other, '6e6577')

    assert.isUndefined(
      await validateForBuild(nodeCore(node), 'AccountUpdateContract', {
        owner_address: toTronHex(owner),
        account_name: '6e6577',
      }),
    )
  })
})

describe('legacy TRC-10 name store', () => {
  it('uses its distinct name and precision rules when duplicate names are disabled', async () => {
    const config = resolveConfig({
      chainParameters: { allowSameTokenName: 0 },
    })
    const node = await createNode(config, new Clock())
    const owner = parseTronAddress(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[0].privateKey) as string,
    )
    const other = parseTronAddress(
      TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[1].privateKey) as string,
    )
    const startTime = nodeCore(node).head().timestampMs + 1
    const issue = (name: string, totalSupply = 1): Record<string, unknown> => ({
      owner_address: toTronHex(owner),
      name,
      abbr: '41',
      total_supply: totalSupply,
      trx_num: 1,
      num: 1,
      precision: 7,
      start_time: startTime,
      end_time: startTime + 1,
      url: '68',
      description: '',
    })

    assert.isUndefined(
      await validateForBuild(nodeCore(node), 'AssetIssueContract', issue('545258')),
    )
    await nodeCore(node).issueAsset(other, {
      name: 'DUP',
      abbr: 'DUP',
      totalSupply: 1n,
      trxNum: 1,
      num: 1,
      precision: 0,
      startTime: BigInt(startTime),
      endTime: BigInt(startTime + 1),
      order: 0n,
      voteScore: 0,
      description: '',
      url: 'h',
      freeAssetNetLimit: 0,
      publicFreeAssetNetLimit: 0,
      publicFreeAssetNetUsage: 0,
      publicLatestFreeNetTime: 0,
    })
    assert.strictEqual(
      await validateForBuild(nodeCore(node), 'AssetIssueContract', issue('445550', 0)),
      'Token exists',
    )

    await nodeCore(node).issueAsset(owner, {
      name: 'TOKEN',
      abbr: 'T',
      totalSupply: 1n,
      trxNum: 1,
      num: 1,
      precision: 0,
      startTime: BigInt(startTime),
      endTime: BigInt(startTime + 1),
      order: 0n,
      voteScore: 0,
      description: '',
      url: 'h',
      freeAssetNetLimit: 0,
      publicFreeAssetNetLimit: 0,
      publicFreeAssetNetUsage: 0,
      publicLatestFreeNetTime: 0,
    })
    await nodeCore(node).setBalanceUnlocked(owner, 0n)
    const newRecipient = parseTronAddress(utils.accounts.generateAccount().address.base58)
    assert.strictEqual(
      await validateForBuild(nodeCore(node), 'TransferAssetContract', {
        owner_address: toTronHex(owner),
        to_address: toTronHex(newRecipient),
        asset_name: '544f4b454e',
        amount: 1,
      }),
      'Validate TransferAssetActuator error, insufficient fee.',
    )
  })
})
