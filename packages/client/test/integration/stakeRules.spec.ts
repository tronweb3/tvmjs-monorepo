import { hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, afterAll, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { INT64_MAX } from '../../src/intBounds.ts'
import type { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'
import { probeState } from '../stateProbe.ts'

import type { Server } from 'node:http'

const TRX = 1_000_000
/** slots one account's pending unstakes may occupy */
const UNFREEZE_SLOTS = 32
/** blocks a locked delegation runs for when the request states no period */
const DEFAULT_LOCK_BLOCKS = 86_400
const BLOCK_MS = 3_000
const hexOf = (base58: string): string => TronWeb.address.toHex(base58).toLowerCase()

/**
 * What each stake actuator refuses, in the wording and the order it refuses
 * it. A request that breaks two rules is answered by the earlier one, so the
 * cases that pin an order state both faults and name the answer. Every attempt
 * here is a build, and a refused build writes nothing, which the probe on
 * either side of it says.
 *
 * Each account has one standing: the stakes are laid down before the first
 * case, so no case depends on another having run.
 */
describe('stake refusals', () => {
  const config = resolveConfig()
  const [ownerKey, peerKey, idleKey, bareKey, saverKey, lenderKey, underKey] = accountsFromMnemonic(
    config.mnemonic,
  ).map((account) => account.privateKey)
  const ownerBase58 = TronWeb.address.fromPrivateKey(ownerKey) as string
  const owner = parseTronAddress(ownerBase58)
  const peerBase58 = TronWeb.address.fromPrivateKey(peerKey) as string
  const peer = parseTronAddress(peerBase58)
  const idleBase58 = TronWeb.address.fromPrivateKey(idleKey) as string
  const idle = parseTronAddress(idleBase58)
  const bareBase58 = TronWeb.address.fromPrivateKey(bareKey) as string
  const bare = parseTronAddress(bareBase58)
  const saverBase58 = TronWeb.address.fromPrivateKey(saverKey) as string
  const saver = parseTronAddress(saverBase58)
  const lenderBase58 = TronWeb.address.fromPrivateKey(lenderKey) as string
  const lender = parseTronAddress(lenderBase58)
  const underBase58 = TronWeb.address.fromPrivateKey(underKey) as string
  const under = parseTronAddress(underBase58)
  // an address the chain has never heard of, and one that holds code
  const strangerBase58 = utils.accounts.generateAccount().address.base58
  const strangerHex = hexOf(strangerBase58)
  const contractBase58 = utils.accounts.generateAccount().address.base58
  const clock = new Clock()
  let node: TronNode
  let server: Server
  let baseUrl = ''

  beforeAll(async () => {
    node = await createNode(config, clock)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    await nodeCore(node).setCode(parseTronAddress(contractBase58), hexToBytes('0x6001'))

    await nodeCore(node).freezeV2(owner, BigInt(100 * TRX), 'ENERGY')
    await nodeCore(node).freezeV2(saver, BigInt(10 * TRX), 'BANDWIDTH')
    await nodeCore(node).freezeV2(under, BigInt(TRX - 1), 'ENERGY')
    await nodeCore(node).freezeV2(lender, BigInt(20 * TRX), 'BANDWIDTH')
    await nodeCore(node).delegateResource(lender, peer, BigInt(5 * TRX), 'BANDWIDTH', false, 0)
    // every slot filled, with stake to spare so the count is what refuses
    await nodeCore(node).freezeV2(idle, BigInt(40 * TRX), 'ENERGY')
    for (let slot = 0; slot < UNFREEZE_SLOTS; slot += 1) {
      await nodeCore(node).unfreezeV2(idle, BigInt(TRX), 'ENERGY')
    }
  })

  afterAll(() => {
    server.close()
  })

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>

  /** the actuator's answer to one build, and the proof it cost nothing */
  const refusal = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    const before = await probeState(node)
    const reply = await post(path, { visible: true, ...body })
    assert.deepEqual(await probeState(node), before, path)
    if (reply.Error === undefined) return undefined
    return String(reply.Error)
  }

  it('freezebalancev2 answers the earliest broken rule', async () => {
    assert.strictEqual(
      await refusal('wallet/freezebalancev2', {
        owner_address: strangerBase58,
        frozen_balance: TRX,
      }),
      `Account[${strangerHex}] not exists`,
    )
    // the amount is judged before the resource: both are wrong, the amount answers
    assert.strictEqual(
      await refusal('wallet/freezebalancev2', {
        owner_address: bareBase58,
        frozen_balance: 0,
        resource: 'TRON_POWER',
      }),
      'frozenBalance must be positive',
    )
    assert.strictEqual(
      await refusal('wallet/freezebalancev2', { owner_address: bareBase58, frozen_balance: -1 }),
      'frozenBalance must be positive',
    )
    assert.strictEqual(
      await refusal('wallet/freezebalancev2', {
        owner_address: bareBase58,
        frozen_balance: TRX - 1,
      }),
      'frozenBalance must be greater than or equal to 1 TRX',
    )
    assert.strictEqual(
      await refusal('wallet/freezebalancev2', {
        owner_address: bareBase58,
        frozen_balance: 10_001 * TRX,
      }),
      'frozenBalance must be less than or equal to accountBalance',
    )
    assert.strictEqual(
      await refusal('wallet/freezebalancev2', {
        owner_address: bareBase58,
        frozen_balance: TRX,
        resource: 'TRON_POWER',
      }),
      'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY]',
    )
    // the whole balance is stakeable: the ceiling is inclusive
    assert.isUndefined(
      await refusal('wallet/freezebalancev2', {
        owner_address: bareBase58,
        frozen_balance: 10_000 * TRX,
      }),
    )
  })

  it('unfreezebalancev2 judges the resource before the amount', async () => {
    assert.strictEqual(
      await refusal('wallet/unfreezebalancev2', {
        owner_address: strangerBase58,
        unfreeze_balance: TRX,
      }),
      `Account[${strangerHex}] does not exist`,
    )
    // an unstakeable resource answers even though the amount is also wrong
    assert.strictEqual(
      await refusal('wallet/unfreezebalancev2', {
        owner_address: bareBase58,
        unfreeze_balance: 0,
        resource: 'TRON_POWER',
      }),
      'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy]',
    )
    assert.strictEqual(
      await refusal('wallet/unfreezebalancev2', {
        owner_address: bareBase58,
        unfreeze_balance: TRX,
        resource: 'BANDWIDTH',
      }),
      'no frozenBalance(BANDWIDTH)',
    )
    assert.strictEqual(
      await refusal('wallet/unfreezebalancev2', {
        owner_address: bareBase58,
        unfreeze_balance: TRX,
        resource: 'ENERGY',
      }),
      'no frozenBalance(Energy)',
    )
    assert.strictEqual(
      await refusal('wallet/unfreezebalancev2', {
        owner_address: saverBase58,
        unfreeze_balance: 0,
        resource: 'BANDWIDTH',
      }),
      'Invalid unfreeze_balance, [0] is error',
    )
    assert.strictEqual(
      await refusal('wallet/unfreezebalancev2', {
        owner_address: saverBase58,
        unfreeze_balance: 11 * TRX,
        resource: 'BANDWIDTH',
      }),
      `Invalid unfreeze_balance, [${11 * TRX}] is error`,
    )
    // the whole holding unstakes: the ceiling is inclusive
    assert.isUndefined(
      await refusal('wallet/unfreezebalancev2', {
        owner_address: saverBase58,
        unfreeze_balance: 10 * TRX,
        resource: 'BANDWIDTH',
      }),
    )
  })

  it('the pending-unstake slots run out at 32', async () => {
    const counted = async (address: string): Promise<unknown> =>
      (
        await post('wallet/getavailableunfreezecount', {
          owner_address: address,
          visible: true,
        })
      ).count
    assert.strictEqual(await counted(saverBase58), UNFREEZE_SLOTS)
    // a count of zero is the proto default and stays off the wire
    assert.isUndefined(await counted(idleBase58))

    assert.strictEqual(
      await refusal('wallet/unfreezebalancev2', {
        owner_address: idleBase58,
        unfreeze_balance: TRX,
        resource: 'ENERGY',
      }),
      'Invalid unfreeze operation, unfreezing times is over limit',
    )
  })

  it('withdrawexpireunfreeze and cancelallunfreezev2 need an account first', async () => {
    assert.strictEqual(
      await refusal('wallet/withdrawexpireunfreeze', { owner_address: strangerBase58 }),
      `Account[${strangerHex}] not exists`,
    )
    assert.strictEqual(
      await refusal('wallet/cancelallunfreezev2', { owner_address: strangerBase58 }),
      `Account[${strangerHex}] not exists`,
    )
  })

  it('delegateresource walks owner, amount, resource, holding, then receiver', async () => {
    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        owner_address: strangerBase58,
        receiver_address: peerBase58,
        balance: TRX,
      }),
      `Account[${strangerHex}] not exists`,
    )
    // the amount is judged before the resource, and both before the receiver
    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        owner_address: ownerBase58,
        receiver_address: strangerBase58,
        balance: TRX - 1,
        resource: 'TRON_POWER',
      }),
      'delegateBalance must be greater than or equal to 1 TRX',
    )
    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        owner_address: ownerBase58,
        receiver_address: strangerBase58,
        balance: TRX,
        resource: 'TRON_POWER',
      }),
      'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY]',
    )
    // staked energy is no help to a bandwidth delegation, and the other way round
    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        owner_address: ownerBase58,
        receiver_address: peerBase58,
        balance: TRX,
        resource: 'BANDWIDTH',
      }),
      'delegateBalance must be less than or equal to available FreezeBandwidthV2 balance',
    )
    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        owner_address: saverBase58,
        receiver_address: peerBase58,
        balance: TRX,
        resource: 'ENERGY',
      }),
      'delegateBalance must be less than or equal to available FreezeEnergyV2 balance',
    )
    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        owner_address: ownerBase58,
        receiver_address: ownerBase58,
        balance: TRX,
        resource: 'ENERGY',
      }),
      'receiverAddress must not be the same as ownerAddress',
    )
    // 21 bytes that are no TRON address: the prefix is not 41
    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        visible: false,
        owner_address: hexOf(ownerBase58),
        receiver_address: `42${strangerHex.slice(2)}`,
        balance: TRX,
        resource: 'ENERGY',
      }),
      'Invalid receiverAddress',
    )
    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        owner_address: ownerBase58,
        receiver_address: strangerBase58,
        balance: TRX,
        resource: 'ENERGY',
      }),
      `Account[${strangerHex}] not exists`,
    )
    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        owner_address: ownerBase58,
        receiver_address: contractBase58,
        balance: TRX,
        resource: 'ENERGY',
      }),
      'Do not allow delegate resources to contract addresses',
    )
  })

  it('a locked delegation states a period inside the ceiling, or none at all', async () => {
    const max = config.chainParameters.maxDelegateLockPeriod
    for (const lock_period of [-1, max + 1]) {
      assert.strictEqual(
        await refusal('wallet/delegateresource', {
          owner_address: ownerBase58,
          receiver_address: peerBase58,
          balance: TRX,
          resource: 'ENERGY',
          lock: true,
          lock_period,
        }),
        `The lock period of delegate resource cannot be less than 0 and cannot exceed ${max}!`,
        String(lock_period),
      )
    }

    await nodeCore(node).delegateResource(owner, peer, BigInt(10 * TRX), 'ENERGY', true, 0)
    const locked = nodeCore(node)
      .delegationEntriesOf(hexOf(ownerBase58).slice(2), hexOf(peerBase58).slice(2))
      .find((entry) => entry.locked)
    const remain = (locked?.expireEnergyMs ?? 0) - nodeCore(node).head().timestampMs
    assert.strictEqual(remain, DEFAULT_LOCK_BLOCKS * BLOCK_MS)

    assert.strictEqual(
      await refusal('wallet/delegateresource', {
        owner_address: ownerBase58,
        receiver_address: peerBase58,
        balance: TRX,
        resource: 'ENERGY',
        lock: true,
        lock_period: 10,
      }),
      `The lock period for ENERGY this time cannot be less than the remaining time[${remain}ms] ` +
        'of the last lock period for ENERGY!',
    )
    // a request that states no period asks for the three-day default, which is
    // never shorter than what a default-locked delegation has left
    assert.isUndefined(
      await refusal('wallet/delegateresource', {
        owner_address: ownerBase58,
        receiver_address: peerBase58,
        balance: TRX,
        resource: 'ENERGY',
        lock: true,
      }),
    )
  })

  it('undelegateresource judges the delegation before the amount', async () => {
    assert.strictEqual(
      await refusal('wallet/undelegateresource', {
        owner_address: strangerBase58,
        receiver_address: peerBase58,
        balance: TRX,
      }),
      `Account[${strangerHex}] does not exist`,
    )
    assert.strictEqual(
      await refusal('wallet/undelegateresource', {
        visible: false,
        owner_address: hexOf(lenderBase58),
        receiver_address: `42${strangerHex.slice(2)}`,
        balance: TRX,
      }),
      'Invalid receiverAddress',
    )
    assert.strictEqual(
      await refusal('wallet/undelegateresource', {
        owner_address: lenderBase58,
        receiver_address: lenderBase58,
        balance: TRX,
      }),
      'receiverAddress must not be the same as ownerAddress',
    )
    // no delegation answers even though the amount is also wrong
    assert.strictEqual(
      await refusal('wallet/undelegateresource', {
        owner_address: lenderBase58,
        receiver_address: idleBase58,
        balance: 0,
      }),
      'delegated Resource does not exist',
    )
    assert.strictEqual(
      await refusal('wallet/undelegateresource', {
        owner_address: lenderBase58,
        receiver_address: peerBase58,
        balance: 0,
      }),
      'unDelegateBalance must be more than 0 TRX',
    )
    // the two shortfalls are worded differently: delegated for one, delegate for the other
    assert.strictEqual(
      await refusal('wallet/undelegateresource', {
        owner_address: lenderBase58,
        receiver_address: peerBase58,
        balance: 6 * TRX,
        resource: 'BANDWIDTH',
      }),
      `insufficient delegatedFrozenBalance(BANDWIDTH), request=${6 * TRX}, unlock_balance=${5 * TRX}`,
    )
    assert.strictEqual(
      await refusal('wallet/undelegateresource', {
        owner_address: lenderBase58,
        receiver_address: peerBase58,
        balance: TRX,
        resource: 'ENERGY',
      }),
      `insufficient delegateFrozenBalance(Energy), request=${TRX}, unlock_balance=0`,
    )
    assert.strictEqual(
      await refusal('wallet/undelegateresource', {
        owner_address: lenderBase58,
        receiver_address: peerBase58,
        balance: TRX,
        resource: 'TRON_POWER',
      }),
      'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy]',
    )
  })

  it('freezebalance runs the whole v1 ladder before reporting the closure', async () => {
    const v1 = async (body: Record<string, unknown>): Promise<unknown> =>
      refusal('wallet/freezebalance', {
        owner_address: bareBase58,
        frozen_duration: 3,
        resource: 'BANDWIDTH',
        ...body,
      })

    assert.strictEqual(
      await v1({ owner_address: strangerBase58, frozen_balance: TRX }),
      `Account[${strangerHex}] not exists`,
    )
    assert.strictEqual(await v1({ frozen_balance: 0 }), 'frozenBalance must be positive')
    assert.strictEqual(
      await v1({ frozen_balance: TRX - 1 }),
      'frozenBalance must be greater than or equal to 1 TRX',
    )
    assert.strictEqual(
      await v1({ frozen_balance: 10_001 * TRX }),
      'frozenBalance must be less than or equal to accountBalance',
    )
    for (const frozen_duration of [0, 2, 4]) {
      assert.strictEqual(
        await v1({ frozen_balance: TRX, frozen_duration }),
        'frozenDuration must be less than 3 days and more than 3 days',
        String(frozen_duration),
      )
    }
    assert.strictEqual(
      await v1({ frozen_balance: TRX, resource: 'TRON_POWER' }),
      'ResourceCode error, valid ResourceCode[BANDWIDTH、ENERGY]',
    )
    assert.strictEqual(
      await v1({ frozen_balance: TRX, receiver_address: bareBase58 }),
      'receiverAddress must not be the same as ownerAddress',
    )
    assert.strictEqual(
      await v1({
        visible: false,
        owner_address: hexOf(bareBase58),
        frozen_balance: TRX,
        receiver_address: `42${strangerHex.slice(2)}`,
      }),
      'Invalid receiverAddress',
    )
    assert.strictEqual(
      await v1({ frozen_balance: TRX, receiver_address: strangerBase58 }),
      `Account[${strangerHex}] not exists`,
    )
    assert.strictEqual(
      await v1({ frozen_balance: TRX, receiver_address: contractBase58 }),
      'Do not allow delegate resources to contract addresses',
    )
    // every field is in order, and the endpoint is still closed
    for (const receiver of [undefined, peerBase58]) {
      assert.strictEqual(
        await v1({
          frozen_balance: TRX,
          ...(receiver === undefined ? {} : { receiver_address: receiver }),
        }),
        'freeze v2 is open, old freeze is closed',
        String(receiver),
      )
    }
  })

  it('unfreezebalance answers for the delegation, not for the receiver account', async () => {
    assert.strictEqual(
      await refusal('wallet/unfreezebalance', { owner_address: strangerBase58 }),
      `Account[${strangerHex}] does not exist`,
    )
    assert.strictEqual(
      await refusal('wallet/unfreezebalance', {
        owner_address: bareBase58,
        receiver_address: bareBase58,
      }),
      'receiverAddress must not be the same as ownerAddress',
    )
    assert.strictEqual(
      await refusal('wallet/unfreezebalance', {
        visible: false,
        owner_address: hexOf(bareBase58),
        receiver_address: `42${strangerHex.slice(2)}`,
      }),
      'Invalid receiverAddress',
    )
    // a named receiver sends the lookup to the v1 delegation table, which holds
    // nothing on this chain — whether or not the receiver has an account
    for (const receiver of [peerBase58, strangerBase58]) {
      assert.strictEqual(
        await refusal('wallet/unfreezebalance', {
          owner_address: bareBase58,
          receiver_address: receiver,
        }),
        'delegated Resource does not exist',
        receiver,
      )
    }
    assert.strictEqual(
      await refusal('wallet/unfreezebalance', {
        owner_address: bareBase58,
        resource: 'BANDWIDTH',
      }),
      'no frozenBalance(BANDWIDTH)',
    )
    assert.strictEqual(
      await refusal('wallet/unfreezebalance', { owner_address: bareBase58, resource: 'ENERGY' }),
      'no frozenBalance(Energy)',
    )
    assert.strictEqual(
      await refusal('wallet/unfreezebalance', {
        owner_address: bareBase58,
        resource: 'TRON_POWER',
      }),
      'ResourceCode error.valid ResourceCode[BANDWIDTH、Energy]',
    )
  })

  it('the stake queries stay silent on what they cannot answer', async () => {
    const asked = async (path: string, body: Record<string, unknown>): Promise<unknown> =>
      post(path, { visible: true, ...body })

    for (const type of [0, 1]) {
      assert.deepEqual(
        await asked('wallet/getcandelegatedmaxsize', { owner_address: strangerBase58, type }),
        {},
        String(type),
      )
    }
    // TRON_POWER is delegatable to nobody, so no ceiling is computed
    assert.deepEqual(
      await asked('wallet/getcandelegatedmaxsize', { owner_address: ownerBase58, type: 2 }),
      {},
    )
    // a holding under 1 TRX is reported as none at all
    assert.deepEqual(
      await asked('wallet/getcandelegatedmaxsize', { owner_address: underBase58, type: 1 }),
      {},
    )
    // a staker of energy alone has no bandwidth to delegate
    assert.deepEqual(
      await asked('wallet/getcandelegatedmaxsize', { owner_address: ownerBase58, type: 0 }),
      {},
    )

    assert.deepEqual(
      await asked('wallet/getavailableunfreezecount', { owner_address: strangerBase58 }),
      {},
    )
    assert.deepEqual(
      await asked('wallet/getcanwithdrawunfreezeamount', { owner_address: strangerBase58 }),
      {},
    )
    // a timestamp before the epoch is answered with silence, not clamped
    assert.deepEqual(
      await asked('wallet/getcanwithdrawunfreezeamount', {
        owner_address: idleBase58,
        timestamp: -1,
      }),
      {},
    )
    // nothing has matured yet, and a zero amount stays off the wire
    assert.deepEqual(
      await asked('wallet/getcanwithdrawunfreezeamount', { owner_address: idleBase58 }),
      {},
    )
    // the whole pending stack is withdrawable once the delay is behind it
    assert.deepEqual(
      await asked('wallet/getcanwithdrawunfreezeamount', {
        owner_address: idleBase58,
        timestamp:
          nodeCore(node).head().timestampMs + config.chainParameters.unfreezeDelayDays * 86_400_000,
      }),
      { amount: UNFREEZE_SLOTS * TRX },
    )

    assert.deepEqual(
      await asked('wallet/getdelegatedresourcev2', {
        fromAddress: lenderBase58,
        toAddress: strangerBase58,
      }),
      {},
    )
    assert.deepEqual(
      await asked('wallet/getdelegatedresourcev2', { fromAddress: lenderBase58 }),
      {},
    )
  })

  it('the delegation index reads a hex address when visible is off', async () => {
    const index = (await post('wallet/getdelegatedresourceaccountindexv2', {
      value: hexOf(lenderBase58),
    })) as { account?: string; toAccounts?: string[] }
    assert.strictEqual(index.account, hexOf(lenderBase58))
    assert.deepEqual(index.toAccounts, [hexOf(peerBase58)])

    // a value that is no address at all is answered with silence
    assert.deepEqual(await post('wallet/getdelegatedresourceaccountindexv2', { value: '41ab' }), {})
  })

  it('withdrawexpireunfreeze rejects a signed-long balance overflow', async () => {
    const amount = BigInt(TRX)
    await nodeCore(node).freezeV2(bare, amount, 'BANDWIDTH')
    await nodeCore(node).unfreezeV2(bare, amount, 'BANDWIDTH')
    await node.tre.increaseTime((config.chainParameters.unfreezeDelayDays * 86_400_000) / 1000 + 3)
    await nodeCore(node).setBalance(bare, INT64_MAX)

    assert.strictEqual(
      await refusal('wallet/withdrawexpireunfreeze', { owner_address: bareBase58 }),
      'long overflow',
    )
  })
})

/**
 * The delegatable ceiling to the sun. A build is charged for the bytes the
 * delegation it is asking about will cost, so the ceiling sits below the stake
 * by that estimate's share of the grid.
 */
describe('the delegatable ceiling counts the delegation it is asked about', () => {
  // the only staker on the chain, holding a millionth of the daily bandwidth
  // grid in TRX: one estimated byte then costs exactly one sun
  const config = resolveConfig()
  config.mnemonic.count = 1
  config.mnemonic.balance = 100_000_000_000n
  const ownerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
  const owner = parseTronAddress(ownerBase58)
  const staked = BigInt(config.chainParameters.totalNetLimit) / 1_000_000n
  /** protobuf bytes a delegation of the whole stake is charged for */
  const estimate = 284n
  let node: TronNode
  let server: Server
  let baseUrl = ''

  beforeAll(async () => {
    node = await createNode(config, new Clock())
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    await nodeCore(node).freezeV2(owner, staked * BigInt(TRX), 'BANDWIDTH')
  })

  afterAll(() => {
    server.close()
  })

  const asked = async (type: number): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`${baseUrl}/wallet/getcandelegatedmaxsize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_address: ownerBase58, type, visible: true }),
      })
    ).json()) as Record<string, unknown>

  it('holds back the estimate, to the sun', async () => {
    assert.deepEqual(await asked(0), { max_size: Number(staked * BigInt(TRX) - estimate) })
    // nobody staked energy, so there is no grid for a share of it to come from
    assert.deepEqual(await asked(1), {})
  })
})

describe('zero global resource limits', () => {
  it.each([
    {
      parameter: 'totalNetLimit' as const,
      resource: 'BANDWIDTH' as const,
      type: 0,
      expected: {},
    },
    {
      parameter: 'totalEnergyCurrentLimit' as const,
      resource: 'ENERGY' as const,
      type: 1,
      expected: { max_size: 10n * BigInt(TRX) },
    },
  ])(
    'saturates the delegatable ceiling for $parameter',
    async ({ parameter, resource, type, expected }) => {
      const config = resolveConfig({ chainParameters: { [parameter]: 0 } })
      config.mnemonic.count = 1
      config.mnemonic.balance = 100n * BigInt(TRX)
      const node = await createNode(config, new Clock())
      const ownerBase58 = TronWeb.address.fromPrivateKey(
        accountsFromMnemonic(config.mnemonic)[0].privateKey,
      ) as string
      const owner = parseTronAddress(ownerBase58)
      await nodeCore(node).freezeV2(owner, 10n * BigInt(TRX), resource)

      const result = await new TronProvider(node).request({
        method: 'wallet/getcandelegatedmaxsize',
        params: { owner_address: ownerBase58, type },
      })
      assert.deepEqual(result, expected)
    },
  )

  it.each([
    {
      parameter: 'totalNetLimit' as const,
      resource: 'BANDWIDTH' as const,
      refusal: 'delegateBalance must be less than or equal to available FreezeBandwidthV2 balance',
    },
    {
      parameter: 'totalEnergyCurrentLimit' as const,
      resource: 'ENERGY' as const,
      refusal: undefined,
    },
  ])(
    'answers a delegation built under a zero $parameter',
    async ({ parameter, resource, refusal }) => {
      const config = resolveConfig({ chainParameters: { [parameter]: 0 } })
      config.mnemonic.count = 2
      config.mnemonic.balance = 100n * BigInt(TRX)
      const node = await createNode(config, new Clock())
      const [ownerBase58, peerBase58] = accountsFromMnemonic(config.mnemonic).map(
        (account) => TronWeb.address.fromPrivateKey(account.privateKey) as string,
      )
      await nodeCore(node).freezeV2(parseTronAddress(ownerBase58), 10n * BigInt(TRX), resource)
      const before = await probeState(node)

      const built = (await new TronProvider(node).request({
        method: 'wallet/delegateresource',
        params: {
          owner_address: ownerBase58,
          receiver_address: peerBase58,
          balance: TRX,
          resource,
        },
      })) as { txID?: string; Error?: string }
      if (refusal === undefined) {
        assert.isString(built.txID)
      } else {
        assert.strictEqual(built.Error, refusal)
      }
      assert.deepEqual(await probeState(node), before)
    },
  )
})
