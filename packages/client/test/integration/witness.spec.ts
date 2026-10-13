import { createHash } from 'node:crypto'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { ecrecover, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, beforeEach, describe, it } from 'vitest'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import {
  WITNESS_ADDRESS,
  WITNESS_PRIVATE_KEY,
  WITNESS_URL,
  WITNESS_VOTE_COUNT,
} from '../../src/core/witness.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'

/** the producer's cut of one block at the default chain parameters, in sun */
const PER_BLOCK_SUN = 27_200_000n

let node: TronNode
let provider: TronProvider
let ownerKey = ''
let ownerHex = ''

const ask = async (method: string, params: Record<string, unknown>): Promise<any> =>
  provider.request({ method, params: params as never })

beforeEach(async () => {
  const config = resolveConfig()
  node = await TronNode.create(config)
  provider = new TronProvider(node)
  ownerKey = accountsFromMnemonic(config.mnemonic)[0].privateKey
  ownerHex = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(ownerKey) as string)
})

describe('the witness on the roll', () => {
  it('is listed with its genesis record and live production stats', async () => {
    await node.tre.mine(2)
    const { witnesses } = await ask('wallet/listwitnesses', {})
    assert.lengthOf(witnesses, 1)
    assert.deepEqual(witnesses[0], {
      address: WITNESS_ADDRESS,
      voteCount: WITNESS_VOTE_COUNT,
      url: WITNESS_URL,
      totalProduced: Number(nodeCore(node).head().number),
      latestBlockNum: Number(nodeCore(node).head().number),
      latestSlotNum: Math.floor(nodeCore(node).head().timestampMs / 3000),
      isJobs: true,
    })
  })

  it('reads the same sealed witness store through the solidity route', async () => {
    await node.tre.mine(2)
    assert.deepEqual(
      await ask('walletsolidity/listwitnesses', {}),
      await ask('wallet/listwitnesses', {}),
    )
  })

  it('exists from genesis as a funded normal account', async () => {
    const account = await ask('wallet/getaccount', { address: WITNESS_ADDRESS })
    assert.notProperty(account, 'type')
    assert.strictEqual(account.is_witness, true)
    assert.strictEqual(account.balance, 99_000_000_000_000_000n)
    assert.strictEqual(account.account_name, '5a696f6e')
    assert.strictEqual(account.allowance, PER_BLOCK_SUN)
    // genesis accounts carry no creation stamp, and none of the permissions a
    // transaction-created account is written with
    assert.notProperty(account, 'create_time')
    assert.notProperty(account, 'owner_permission')
    assert.notProperty(account, 'active_permission')
    const roster = await ask('wallet/getaccount', { address: ownerHex })
    assert.property(roster, 'owner_permission')
  })

  it.each([0n, 123_456_789n])('honors an explicit witness balance of %s sun', async (balance) => {
    const configured = await TronNode.create({
      accounts: [{ privateKey: WITNESS_PRIVATE_KEY, balance }],
    })
    const account = await new TronProvider(configured).request({
      method: 'wallet/getaccount',
      params: { address: WITNESS_ADDRESS },
    })
    assert.strictEqual(account.balance, balance)
    assert.strictEqual(account.account_name, '5a696f6e')
    assert.notProperty(account, 'type')
    assert.isTrue(account.is_witness)
  })

  it('deploys using private key 01 without admin funding or account discovery', async () => {
    const built = await provider.request({
      method: 'wallet/deploycontract',
      params: {
        owner_address: WITNESS_ADDRESS,
        name: 'FixedKeyDeployment',
        bytecode: '6001600c60003960016000f300',
        fee_limit: 100_000_000,
        consume_user_resource_percent: 100,
        origin_energy_limit: 1_000_000,
      },
    })
    if ('Error' in built) throw new Error(built.Error)
    const sent = await provider.request({
      method: 'wallet/broadcasttransaction',
      params: utils.crypto.signTransaction(WITNESS_PRIVATE_KEY, built),
    })
    assert.isTrue(sent.result)
    const receipt = await provider.request({
      method: 'wallet/gettransactioninfobyid',
      params: { value: built.txID },
    })
    assert.strictEqual(receipt.receipt?.result, 'SUCCESS')
    const contract = await provider.request({
      method: 'wallet/getcontractinfo',
      params: { value: built.contract_address! },
    })
    assert.strictEqual(contract.runtimecode, '00')
  })

  it('names every sealed header, while genesis carries the founding text', async () => {
    const sealed = await ask('wallet/getblockbynum', { num: 1 })
    assert.strictEqual(sealed.block_header.raw_data.witness_address, WITNESS_ADDRESS)
    const genesis = await ask('wallet/getblockbynum', { num: 0 })
    const text = TronWeb.toUtf8(genesis.block_header.raw_data.witness_address)
    assert.include(text, 'A new system must allow existing systems')
  })
})

describe('block reward accrual', () => {
  it('pays the brokerage share of block plus standby rewards per sealed block', async () => {
    assert.deepEqual(await ask('wallet/getReward', { address: WITNESS_ADDRESS }), {
      reward: PER_BLOCK_SUN,
    })
    await node.tre.mine(3)
    assert.deepEqual(await ask('wallet/getReward', { address: WITNESS_ADDRESS }), {
      reward: 4n * PER_BLOCK_SUN,
    })
    // the allowance is the account's own field, and only the producer has one
    const account = await ask('wallet/getaccount', { address: WITNESS_ADDRESS })
    assert.strictEqual(account.allowance, 4n * PER_BLOCK_SUN)
    assert.deepEqual(await ask('wallet/getReward', { address: ownerHex }), { reward: 0n })
  })

  it('accrues for the block a broadcast seals, and not for a rejected one', async () => {
    const before = (await ask('wallet/getReward', { address: WITNESS_ADDRESS })).reward
    const built = await ask('wallet/createtransaction', {
      owner_address: ownerHex,
      to_address: TronWeb.address.toHex(utils.accounts.generateAccount().address.base58),
      amount: 1_000,
    })
    const wire = JSON.parse(
      JSON.stringify(built, (_key, held) => (typeof held === 'bigint' ? Number(held) : held)),
    )
    const rejected = await ask('wallet/broadcasttransaction', wire)
    assert.strictEqual(rejected.code, 'SIGERROR')
    assert.strictEqual((await ask('wallet/getReward', { address: WITNESS_ADDRESS })).reward, before)

    const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey: ownerKey })
    const signed = await tronWeb.trx.sign(wire, ownerKey)
    const sent = await ask('wallet/broadcasttransaction', signed)
    assert.strictEqual(sent.result, true)
    assert.strictEqual(
      (await ask('wallet/getReward', { address: WITNESS_ADDRESS })).reward,
      before + PER_BLOCK_SUN,
    )
  })

  it('scales with the pay parameters, and zero pay accrues nothing', async () => {
    const config = resolveConfig()
    config.chainParameters = {
      ...config.chainParameters,
      witnessPayPerBlock: 0,
      witness127PayPerBlock: 0,
    }
    const silent = await TronNode.create(config)
    const still = new TronProvider(silent)
    const reply = await still.request({
      method: 'wallet/getReward',
      params: { address: WITNESS_ADDRESS } as never,
    })
    assert.deepEqual(reply, { reward: 0n })
  })

  it('keeps legacy allowance out of getReward when delegation is disabled', async () => {
    const config = resolveConfig()
    config.chainParameters = { ...config.chainParameters, allowChangeDelegation: 0 }
    const legacy = new TronProvider(await TronNode.create(config))

    // Block pay is still credited under the legacy reward model, but Java
    // MortgageService.queryReward returns before exposing that allowance.
    const account = (await legacy.request({
      method: 'wallet/getaccount',
      params: { address: WITNESS_ADDRESS } as never,
    })) as { allowance?: bigint }
    assert.strictEqual(account.allowance, BigInt(config.chainParameters.witnessPayPerBlock))
    for (const method of ['wallet/getReward', 'walletsolidity/getReward']) {
      assert.deepEqual(
        await legacy.request({ method, params: { address: WITNESS_ADDRESS } as never }),
        { reward: 0n },
      )
    }
  })

  it('refuses out-of-range pay parameters like any other chain parameter', async () => {
    const config = resolveConfig()
    config.chainParameters = { ...config.chainParameters, witnessPayPerBlock: -1 }
    await TronNode.create(config).then(
      () => assert.fail('a negative block pay must not pass'),
      (err: Error) => assert.include(err.message, 'witnessPayPerBlock'),
    )
  })
})

describe('block identity is verifiable', () => {
  // an independent re-implementation of the raw-header encoding: the test
  // deriving the id from the printed JSON must not share code with the node
  const varint = (raw: bigint): number[] => {
    let held = raw
    const out: number[] = []
    for (;;) {
      const low = Number(held & 0x7fn)
      held >>= 7n
      if (held === 0n) {
        out.push(low)
        return out
      }
      out.push(low | 0x80)
    }
  }
  const field = (id: number, wire: number): number[] => varint(BigInt(id * 8 + wire))
  const bytes = (hex: string): number[] => [...hexToBytes(`0x${hex}`)]
  const lenDelim = (id: number, value: number[]): number[] => [
    ...field(id, 2),
    ...varint(BigInt(value.length)),
    ...value,
  ]
  const sha256 = (data: Uint8Array): Uint8Array => createHash('sha256').update(data).digest()

  interface PrintedHeader {
    timestamp?: number
    txTrieRoot: string
    parentHash: string
    number?: number
    witness_address: string
    version?: number
    accountStateRoot?: string
  }

  const derive = (raw: PrintedHeader): Uint8Array => {
    const out: number[] = []
    if (raw.timestamp) out.push(...field(1, 0), ...varint(BigInt(raw.timestamp)))
    out.push(...lenDelim(2, bytes(raw.txTrieRoot)))
    out.push(...lenDelim(3, bytes(raw.parentHash)))
    if (raw.number) out.push(...field(7, 0), ...varint(BigInt(raw.number)))
    out.push(...lenDelim(9, bytes(raw.witness_address)))
    if (raw.version) out.push(...field(10, 0), ...varint(BigInt(raw.version)))
    if (raw.accountStateRoot) out.push(...lenDelim(11, bytes(raw.accountStateRoot)))
    return sha256(new Uint8Array(out))
  }

  const idOf = (number: number, rawHash: Uint8Array): string =>
    number.toString(16).padStart(16, '0') +
    [...rawHash.subarray(8)].map((b) => b.toString(16).padStart(2, '0')).join('')

  const recoverWitness = (rawHash: Uint8Array, signature: string): string => {
    const r = hexToBytes(`0x${signature.slice(0, 64)}`)
    const s = hexToBytes(`0x${signature.slice(64, 128)}`)
    const v = BigInt(Number.parseInt(signature.slice(128, 130), 16) + 27)
    const pub = ecrecover(rawHash, v, r, s)
    return `41${utils.ethersUtils.keccak256(pub).slice(-40)}`
  }

  const printedBlock = async (num: number) =>
    (await ask('wallet/getblockbynum', { num })) as {
      blockID: string
      block_header: { raw_data: PrintedHeader; witness_signature?: string }
    }

  it('derives every sealed blockID from its own printed header, and recovers the signer', async () => {
    await node.tre.mine(1)
    const sealed = await printedBlock(Number(nodeCore(node).head().number))
    const rawHash = derive(sealed.block_header.raw_data)
    assert.strictEqual(idOf(sealed.block_header.raw_data.number ?? 0, rawHash), sealed.blockID)
    const signature = sealed.block_header.witness_signature ?? ''
    assert.lengthOf(signature, 130)
    assert.strictEqual(recoverWitness(rawHash, signature), WITNESS_ADDRESS)
  })

  it('commits the id to the transaction root a broadcast fills', async () => {
    const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey: ownerKey })
    const built = await ask('wallet/createtransaction', {
      owner_address: ownerHex,
      to_address: TronWeb.address.toHex(utils.accounts.generateAccount().address.base58),
      amount: 5_000,
    })
    const wire = JSON.parse(
      JSON.stringify(built, (_key, held) => (typeof held === 'bigint' ? Number(held) : held)),
    )
    const sent = await ask('wallet/broadcasttransaction', await tronWeb.trx.sign(wire, ownerKey))
    assert.strictEqual(sent.result, true)
    const sealed = await printedBlock(Number(nodeCore(node).head().number))
    assert.notStrictEqual(sealed.block_header.raw_data.txTrieRoot, '0'.repeat(64))
    const rawHash = derive(sealed.block_header.raw_data)
    assert.strictEqual(idOf(sealed.block_header.raw_data.number ?? 0, rawHash), sealed.blockID)
  })

  it('gives genesis a verifiable id that covers the account state', async () => {
    const genesis = await printedBlock(0)
    assert.isUndefined(genesis.block_header.witness_signature)
    assert.include(
      TronWeb.toUtf8(genesis.block_header.raw_data.witness_address),
      'A new system must allow',
    )
    assert.isString(genesis.block_header.raw_data.accountStateRoot)
    const rawHash = derive(genesis.block_header.raw_data)
    assert.strictEqual(idOf(0, rawHash), genesis.blockID)
    // the chain id is the tail of this id, so it is a property of the account set
    assert.strictEqual(nodeCore(node).common.chainId(), BigInt(`0x${genesis.blockID.slice(-8)}`))
    const other = await TronNode.create({
      accounts: [{ privateKey: utils.accounts.generateAccount().privateKey, balance: 1n }],
    })
    assert.notStrictEqual(nodeCore(other).blocks.getByNumber(0n)?.blockID, genesis.blockID)
  })
})
