import { TronWeb, utils } from 'tronweb'
import { assert, afterEach, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { createNode } from '../createNode.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { transactionId } from '../../src/dialect/tron/wallet/encode.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'
import { probeState } from '../stateProbe.ts'

import type { Server } from 'node:http'
import type { ChainParameters } from '../../src/config.ts'
import type { SignedTronTx } from '../../src/dialect/tron/wallet/types.ts'

const TRX = 1_000_000
const NOW = 1_800_000_000_000
const DAY_MS = 86_400_000
const DEFAULT_LOCK = 86_400
const MAX_LOCK = 864_000

describe('java-tron 4.8.2 stake validation and execution', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error === undefined ? resolve() : reject(error)))
      })
      server = undefined
    }
  })

  async function fixture(chainParameters: Partial<ChainParameters> = {}) {
    const config = resolveConfig({ chainParameters })
    const [ownerKey, peerKey] = accountsFromMnemonic(config.mnemonic)
    const owner = TronWeb.address.toHex(
      TronWeb.address.fromPrivateKey(ownerKey.privateKey) as string,
    )
    const peer = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(peerKey.privateKey) as string)
    const node = await createNode(config, new Clock(() => NOW))
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${started.url}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>
    const build = async (path: string, fields: Record<string, unknown>): Promise<SignedTronTx> => {
      const tx = await post(path, { owner_address: owner, ...fields })
      assert.isUndefined(tx.Error, String(tx.Error))
      assert.isString(tx.txID)
      return tx as unknown as SignedTronTx
    }
    const broadcast = async (tx: SignedTronTx): Promise<Record<string, unknown>> => {
      tx.txID = transactionId(tx)
      return post(
        'wallet/broadcasttransaction',
        utils.crypto.signTransaction(ownerKey.privateKey, tx as never),
      )
    }
    const execute = async (path: string, fields: Record<string, unknown>): Promise<void> => {
      const result = await broadcast(await build(path, fields))
      assert.isTrue(result.result, JSON.stringify(result))
    }
    const reject = async (
      path: string,
      valid: Record<string, unknown>,
      invalid: Record<string, unknown>,
      message: string,
    ): Promise<void> => {
      const before = await probeState(node)
      const refusal = await post(path, { owner_address: owner, ...valid, ...invalid })
      assert.strictEqual(refusal.Error, message)
      // Send the same invalid contract without relying on the builder to refuse it.
      const tx = await build(path, valid)
      Object.assign(tx.raw_data.contract[0].parameter.value, invalid)
      const reply = await broadcast(tx)
      assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR', JSON.stringify(reply))
      assert.include(TronWeb.toUtf8(String(reply.message)), message)
      assert.deepEqual(await probeState(node), before)
    }
    return { node, owner, peer, post, execute, reject, broadcast }
  }

  it.each([0, 14])(
    'rejects deployed receivers with empty or nonempty runtime, unfreezeDelayDays=%i',
    async (delay) => {
      const f = await fixture({ unfreezeDelayDays: delay, forbidTransferToContract: 1 })
      if (delay > 0)
        await f.execute('wallet/freezebalancev2', { frozen_balance: 5 * TRX, resource: 'ENERGY' })
      for (const bytecode of ['60006000f3', '600160005360016000f3']) {
        const deployment = await f.post('wallet/deploycontract', {
          owner_address: f.owner,
          bytecode,
          abi: [],
          consume_user_resource_percent: 100,
          origin_energy_limit: 1,
          fee_limit: 100_000_000,
        })
        assert.isTrue((await f.broadcast(deployment as unknown as SignedTronTx)).result)
        const receiver = deployment.contract_address
        const result = await f.post(
          delay > 0 ? 'wallet/delegateresource' : 'wallet/freezebalance',
          {
            owner_address: f.owner,
            receiver_address: receiver,
            resource: 'ENERGY',
            ...(delay > 0 ? { balance: TRX } : { frozen_balance: TRX, frozen_duration: 3 }),
          },
        )
        assert.strictEqual(result.Error, 'Do not allow delegate resources to contract addresses')
        const transfer = await f.post('wallet/createtransaction', {
          owner_address: f.owner,
          to_address: receiver,
          amount: 1,
        })
        assert.strictEqual(transfer.Error, 'Cannot transfer TRX to a smartContract.')
      }
    },
  )

  it.each([0, 14])(
    'orders delegation peers by their latest operation with unfreezeDelayDays=%i',
    async (delay) => {
      const f = await fixture({ unfreezeDelayDays: delay })
      const second = utils.accounts.generateAccount().address.hex.toLowerCase()
      await f.execute('wallet/createaccount', { account_address: second })
      if (delay > 0)
        await f.execute('wallet/freezebalancev2', { frozen_balance: 5 * TRX, resource: 'ENERGY' })
      for (const receiver of [f.peer, second, f.peer]) {
        await f.node.tre.increaseTime(3)
        await f.node.tre.mine()
        await f.execute(delay > 0 ? 'wallet/delegateresource' : 'wallet/freezebalance', {
          receiver_address: receiver,
          resource: 'ENERGY',
          ...(delay > 0 ? { balance: TRX } : { frozen_balance: TRX, frozen_duration: 3 }),
        })
      }
      const index = await f.post(
        delay > 0
          ? 'wallet/getdelegatedresourceaccountindexv2'
          : 'wallet/getdelegatedresourceaccountindex',
        { value: f.owner },
      )
      assert.deepEqual(index.toAccounts, [second, f.peer])
    },
  )

  it.each([0, 14])(
    'rejects a Contract-typed receiver with empty code, unfreezeDelayDays=%i',
    async (delay) => {
      const f = await fixture({ unfreezeDelayDays: delay })
      const receiver = utils.accounts.generateAccount().address.hex.toLowerCase()
      await f.execute('wallet/createaccount', { account_address: receiver, type: 'Contract' })
      if (delay > 0)
        await f.execute('wallet/freezebalancev2', { frozen_balance: 5 * TRX, resource: 'ENERGY' })
      const result = await f.post(delay > 0 ? 'wallet/delegateresource' : 'wallet/freezebalance', {
        owner_address: f.owner,
        receiver_address: receiver,
        resource: 'ENERGY',
        ...(delay > 0 ? { balance: TRX } : { frozen_balance: TRX, frozen_duration: 3 }),
      })
      assert.isUndefined(result.txID)
      assert.include(String(result.Error), 'contract')
    },
  )

  it('uses the bandwidth expiry for legacy energy delegation before multisign activation', async () => {
    const f = await fixture({ unfreezeDelayDays: 0, allowMultiSign: 0 })
    await f.execute('wallet/freezebalance', {
      receiver_address: f.peer,
      frozen_balance: TRX,
      frozen_duration: 3,
      resource: 'ENERGY',
    })
    await f.execute('wallet/unfreezebalance', { receiver_address: f.peer, resource: 'ENERGY' })
    assert.deepEqual(
      await f.post('wallet/getdelegatedresource', { fromAddress: f.owner, toAddress: f.peer }),
      {},
    )
  })

  it.each(['missing', 'contract', 'smaller'] as const)(
    'releases a legacy claim when its receiver is %s without creating a negative balance',
    async (state) => {
      const f = await fixture({ unfreezeDelayDays: 0 })
      const core = nodeCore(f.node)
      const owner = parseTronAddress(f.owner)
      const receiver = parseTronAddress(f.peer)
      await core.freezeLegacy(owner, 2_000_000n, 'ENERGY', 0, receiver)
      const beforeWeight = core.totalEnergyWeightTrx
      if (state === 'missing') await core.stateManager.deleteAccount(receiver)
      if (state === 'contract') core.noteAccountType(receiver, 'Contract')
      if (state === 'smaller') {
        // A deleted and recreated receiver has lost its original acquired-resource record.
        const records = core as unknown as {
          accounts: Map<string, { acquiredLegacy?: { energy: bigint } }>
        }
        records.accounts.get(f.peer.slice(2))!.acquiredLegacy = { energy: 1n }
      }
      const recordsBefore = core.accountRecordEntries()
      assert.strictEqual(await core.unfreezeLegacy(owner, 'ENERGY', receiver), 2_000_000n)
      assert.strictEqual(core.totalEnergyWeightTrx, beforeWeight - 2n)
      if (state === 'smaller')
        assert.strictEqual(core.legacyAcquiredDelegatedOf(receiver).energy, 0n)
      else
        assert.deepEqual(
          core.accountRecordEntries().find(([key]) => key === f.peer.slice(2)),
          recordsBefore.find(([key]) => key === f.peer.slice(2)),
        )
      if (state === 'missing') assert.isUndefined(await core.getAccount(receiver))
    },
  )

  // FreezeBalanceActuator.validate gates its duration range on checkFrozenTime.
  // execute stores now + duration * day, including dates before the Unix epoch.
  it.each([-30_000, -1, 0, 3, 4])(
    'accepts frozen_duration=%i when checkFrozenTime is disabled',
    async (duration) => {
      const f = await fixture({ unfreezeDelayDays: 0, checkFrozenTime: 0 })
      await f.execute('wallet/freezebalance', { frozen_balance: TRX, frozen_duration: duration })
      const account = await f.post('wallet/getaccount', { address: f.owner })
      assert.deepEqual(account.frozen, [
        { frozen_balance: TRX, expire_time: NOW + duration * DAY_MS },
      ])
      if (duration <= 0) {
        await f.execute('wallet/unfreezebalance', {})
        assert.isUndefined((await f.post('wallet/getaccount', { address: f.owner })).frozen)
      }
    },
  )

  it.each([-1, 0, 2, 4])(
    'rejects frozen_duration=%i when duration checking is enabled',
    async (duration) => {
      const f = await fixture({ unfreezeDelayDays: 0, checkFrozenTime: 1 })
      await f.reject(
        'wallet/freezebalance',
        { frozen_balance: TRX, frozen_duration: 3 },
        { frozen_duration: duration },
        'frozenDuration must be less than 3 days and more than 3 days',
      )
    },
  )

  it('accepts the configured freeze duration when checking is enabled', async () => {
    const f = await fixture({ unfreezeDelayDays: 0, checkFrozenTime: 1 })
    await f.execute('wallet/freezebalance', { frozen_balance: TRX, frozen_duration: 3 })
    assert.deepEqual((await f.post('wallet/getaccount', { address: f.owner })).frozen, [
      { frozen_balance: TRX, expire_time: NOW + 3 * DAY_MS },
    ])
  })

  // DelegateResourceActuator validates the period only for an enabled, locked
  // delegation. getLockPeriod uses three days before the proposal is active.
  it.each([
    { max: MAX_LOCK, lock: false, period: -1, blocks: 0 },
    { max: MAX_LOCK, lock: false, period: 0, blocks: 0 },
    { max: MAX_LOCK, lock: false, period: MAX_LOCK + 1, blocks: 0 },
    { max: DEFAULT_LOCK, lock: false, period: -1, blocks: 0 },
    { max: DEFAULT_LOCK, lock: true, period: -1, blocks: DEFAULT_LOCK },
    { max: DEFAULT_LOCK, lock: true, period: 1, blocks: DEFAULT_LOCK },
    { max: DEFAULT_LOCK, lock: true, period: MAX_LOCK + 1, blocks: DEFAULT_LOCK },
    { max: MAX_LOCK, lock: true, period: 0, blocks: DEFAULT_LOCK },
    { max: MAX_LOCK, lock: true, period: 1, blocks: 1 },
    { max: MAX_LOCK, lock: true, period: MAX_LOCK, blocks: MAX_LOCK },
  ])(
    'delegates with max=$max, lock=$lock, period=$period',
    async ({ max, lock, period, blocks }) => {
      const f = await fixture({ maxDelegateLockPeriod: max })
      await f.execute('wallet/freezebalancev2', { frozen_balance: 100 * TRX, resource: 'ENERGY' })
      await f.execute('wallet/delegateresource', {
        receiver_address: f.peer,
        balance: TRX,
        resource: 'ENERGY',
        lock,
        lock_period: period,
      })
      const pair = await f.post('wallet/getdelegatedresourcev2', {
        fromAddress: f.owner,
        toAddress: f.peer,
      })
      const entries = pair.delegatedResource as Record<string, unknown>[]
      assert.lengthOf(entries, 1)
      assert.strictEqual(entries[0].frozen_balance_for_energy, TRX)
      assert.strictEqual(
        entries[0].expire_time_for_energy ?? 0,
        blocks === 0 ? 0 : NOW + blocks * 3_000,
      )
      if (!lock) {
        await f.execute('wallet/undelegateresource', {
          receiver_address: f.peer,
          balance: TRX,
          resource: 'ENERGY',
        })
        assert.deepEqual(
          await f.post('wallet/getdelegatedresourcev2', {
            fromAddress: f.owner,
            toAddress: f.peer,
          }),
          {},
        )
      }
    },
  )

  it.each([-1, MAX_LOCK + 1])(
    'rejects locked period=%i while the period proposal is active',
    async (period) => {
      const f = await fixture({ maxDelegateLockPeriod: MAX_LOCK })
      await f.execute('wallet/freezebalancev2', { frozen_balance: 100 * TRX, resource: 'ENERGY' })
      await f.reject(
        'wallet/delegateresource',
        {
          receiver_address: f.peer,
          balance: TRX,
          resource: 'ENERGY',
          lock: true,
          lock_period: 0,
        },
        { lock_period: period },
        `The lock period of delegate resource cannot be less than 0 and cannot exceed ${MAX_LOCK}!`,
      )
    },
  )
})
