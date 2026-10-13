import { rejects } from 'node:assert/strict'
import { bytesToHex, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, afterAll, beforeAll, describe, expectTypeOf, it, vi } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { currentCycleNumber } from '../../src/dialect/tron/wallet/nodeinfo.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'
import { probeState } from '../stateProbe.ts'

import type { Server } from 'node:http'
import type {
  BroadcastResult,
  ClientConfig,
  ContractCallResult,
  TransactionInfo,
  TronTransaction,
} from '../../src/index.ts'

const INC_RUNTIME = '6000546001018060005560005260206000f3'
const INC_INITCODE = `601280600b6000396000f3${INC_RUNTIME}`

const INC_ABI = [
  {
    inputs: [],
    name: 'inc',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
]

/** the encoding an internal transaction is hashed under, stated field by field */
const internalHash = (
  parentHex: string,
  receiverHex: string,
  data: Uint8Array,
  value: bigint,
  nonce: bigint,
): string => {
  const int64BE = (held: bigint): number[] => {
    const out: number[] = []
    let rest = held < 0n ? held + (1n << 64n) : held
    for (let i = 0; i < 8; i += 1) {
      out.unshift(Number(rest & 0xffn))
      rest >>= 8n
    }
    return out
  }
  const bytes = new Uint8Array([
    ...hexToBytes(`0x${parentHex}`),
    ...(receiverHex === '' ? [] : hexToBytes(`0x${receiverHex}`)),
    ...data,
    ...int64BE(value),
    ...int64BE(nonce),
  ])
  return utils.ethersUtils.keccak256(bytes).slice(2)
}

describe('program transaction submission', () => {
  it('builds, signs, broadcasts, queries and traces a transfer through the program API', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const accounts = await node.admin.accounts()
    const balance = async (address: string) =>
      (await provider.request({ method: 'wallet/getaccount', params: { address } })).balance ?? 0n
    const [owner, receiver] = accounts.privateKeys.map(
      (key) => TronWeb.address.fromPrivateKey(key) as string,
    )
    const before = await balance(receiver)
    const unsigned = await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: receiver, amount: 1234 },
    })
    if ('Error' in unsigned) throw new Error(unsigned.Error)
    const signed = utils.crypto.signTransaction(accounts.privateKeys[0], unsigned)
    const sent = await provider.request({ method: 'wallet/broadcasttransaction', params: signed })
    if (!sent.result) throw new Error('broadcast failed')
    expectTypeOf(sent.txid).toEqualTypeOf<string>()
    const tx = await provider.request({
      method: 'wallet/gettransactionbyid',
      params: { value: sent.txid },
    })
    assert.strictEqual(tx.txID, sent.txid)
    const info = await provider.request({
      method: 'wallet/gettransactioninfobyid',
      params: { value: sent.txid },
    })
    assert.strictEqual(info.id, sent.txid)
    assert.isNumber(info.blockNumber)
    assert.strictEqual(await balance(receiver), before + 1234n)
    const trace = await node.debug.traceTransaction(sent.txid)
    assert.isFalse(trace.failed)
    assert.deepEqual(await node.debug.traceTransaction(`0x${sent.txid}`), trace)
    assert.deepEqual(
      await provider.request({ method: 'debug_traceTransaction', params: [sent.txid] }),
      trace,
    )
  })
})

describe.each(['provider', 'http'] as const)('transaction finalization through %s', (transport) => {
  async function fixture(seconds: number, config: ClientConfig = {}) {
    const node = await TronNode.create(config)
    const provider = new TronProvider(node)
    const started = transport === 'http' ? await startHttpServer(provider, { port: 0 }) : undefined
    const { privateKeys } = await node.admin.accounts()
    const [owner, beneficiary] = privateKeys.map((key) =>
      TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string),
    )
    async function request<T>(method: string, params: object = {}): Promise<T> {
      if (started === undefined) return (await provider.request({ method, params })) as T
      return (await (
        await fetch(`${started.url}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
        })
      ).json()) as T
    }
    const info = (txid: string) =>
      request<TransactionInfo>('wallet/gettransactioninfobyid', { value: txid })
    async function send(tx: TronTransaction, accountIndex = 0) {
      const signed = utils.crypto.signTransaction(privateKeys[accountIndex], tx)
      const sent = await request<BroadcastResult>('wallet/broadcasttransaction', signed)
      assert.isTrue(sent.result)
    }
    async function commit(tx: TronTransaction, accountIndex = 0) {
      await send(tx, accountIndex)
      if (seconds > 0) await node.tre.mine()
      return info(tx.txID)
    }
    let sequence = 0
    async function deploy(bytecode: string, extra: object = {}) {
      const tx = await request<TronTransaction>('wallet/deploycontract', {
        owner_address: owner,
        name: `Finalization${++sequence}`,
        bytecode,
        fee_limit: 100_000_000,
        consume_user_resource_percent: 100,
        origin_energy_limit: 1_000_000,
        ...extra,
      })
      assert.isString(tx.txID)
      return { tx, receipt: await commit(tx), address: tx.contract_address! }
    }
    const balance = async () =>
      BigInt(
        (
          await request<{ balance?: number | bigint }>('wallet/getaccount', {
            address: beneficiary,
          })
        ).balance ?? 0,
      )
    await node.tre.blockTime(seconds)
    return {
      node,
      request,
      send,
      commit,
      deploy,
      owner,
      beneficiary,
      balance,
      close: async () => {
        await node.tre.blockTime(0)
        if (started !== undefined)
          await new Promise<void>((resolve, reject) => {
            started.server.close((error) => (error ? reject(error) : resolve()))
          })
      },
    }
  }
  const init = (runtime: string, prefix = '') =>
    `${prefix}60${(runtime.length / 2).toString(16).padStart(2, '0')}8060${(prefix.length / 2 + 11).toString(16).padStart(2, '0')}6000396000f3${runtime}`

  it.each(['f1', 'f2', 'f4', 'fa'])(
    'records actual internal transfers for opcode %s',
    async (opcode) => {
      const f = await fixture(0)
      try {
        const child = await f.deploy(init('00'))
        const hasValue = opcode === 'f1' || opcode === 'f2'
        const code = `6000600060006000${hasValue ? '6000' : ''}73${child.address.slice(2)}61ffff${opcode}5000`
        const parent = await f.deploy(init(code))
        for (const callValue of [0, 7]) {
          const params = {
            owner_address: f.owner,
            contract_address: parent.address,
            call_value: callValue,
            fee_limit: 100_000_000,
          }
          const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', params)
          const constant = await f.request<ContractCallResult>(
            'wallet/triggerconstantcontract',
            params,
          )
          const info = await f.commit(built.transaction!)
          assert.strictEqual(info.receipt?.result, 'SUCCESS')
          const receiver = opcode === 'f2' || opcode === 'f4' ? parent.address : child.address
          for (const result of [constant, info]) {
            const calls = result.internal_transactions!
            assert.lengthOf(calls, 1)
            assert.strictEqual(calls[0].caller_address, parent.address)
            assert.strictEqual(calls[0].transferTo_address, receiver)
            assert.deepEqual(calls[0].callValueInfo, [{}])
            const root = result === constant ? '' : built.transaction!.txID
            assert.strictEqual(
              calls[0].hash,
              internalHash(root, receiver, new Uint8Array(), 0n, 1n),
            )
          }
        }
      } finally {
        await f.close()
      }
    },
  )

  it('keeps the execution context across nested delegate calls', async () => {
    const f = await fixture(0)
    try {
      const c = await f.deploy(init('00'))
      const delegate = (address: string) => `600060006000600073${address.slice(2)}61fffff45000`
      const b = await f.deploy(init(delegate(c.address)))
      const a = await f.deploy(init(delegate(b.address)))
      const params = {
        owner_address: f.owner,
        contract_address: a.address,
        call_value: 7,
        fee_limit: 100_000_000,
      }
      const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', params)
      const constant = await f.request<ContractCallResult>('wallet/triggerconstantcontract', params)
      const info = await f.commit(built.transaction!)
      assert.strictEqual(info.receipt?.result, 'SUCCESS')
      for (const result of [constant, info]) {
        const calls = result.internal_transactions!
        assert.lengthOf(calls, 2)
        let parent = result === constant ? '' : built.transaction!.txID
        for (const [index, call] of calls.entries()) {
          assert.strictEqual(call.caller_address, a.address)
          assert.strictEqual(call.transferTo_address, a.address)
          assert.deepEqual(call.callValueInfo, [{}])
          parent = internalHash(parent, a.address, new Uint8Array(), 0n, BigInt(index + 1))
          assert.strictEqual(call.hash, parent)
        }
      }
    } finally {
      await f.close()
    }
  })

  it.each([false, true])(
    'propagates a rejected ancestor in constant calls (ancestor reverts: %s)',
    async (revertParent) => {
      const f = await fixture(0)
      try {
        const c = await f.deploy(init(revertParent ? '600160005500' : '60006000fd'))
        const call = (address: string) => `6000600060006000600073${address.slice(2)}61fffff150`
        const b = await f.deploy(init(`${call(c.address)}${revertParent ? '60006000fd' : '00'}`))
        const a = await f.deploy(init(`${call(b.address)}00`))
        const params = {
          owner_address: f.owner,
          contract_address: a.address,
          fee_limit: 100_000_000,
        }
        const constant = await f.request<ContractCallResult>(
          'wallet/triggerconstantcontract',
          params,
        )
        const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', params)
        const info = await f.commit(built.transaction!)
        assert.strictEqual(info.receipt?.result, 'SUCCESS')
        const flags = (value: unknown) =>
          (value as { rejected?: boolean }[]).map((call) => call.rejected === true)
        assert.deepEqual(flags(constant.internal_transactions), [revertParent, true])
        assert.deepEqual(flags(info.internal_transactions), [revertParent, true])
        const storage = await f.node.debug.storageRangeAt('latest', 0, c.address, null, 10)
        assert.isTrue(
          Object.values(storage.storage).every((row) => BigInt(`0x${row.value}`) === 0n),
        )
      } finally {
        await f.close()
      }
    },
  )

  it.each([100, 250])(
    'caps ABI read-only execution by fee_limit at price %s',
    async (energyFee) => {
      const f = await fixture(0, {
        chainParameters: { energyFee },
        runtime: { maxEnergyLimitForConstant: 20 },
      })
      try {
        for (const stateMutability of ['view', 'pure']) {
          const deployed = await f.deploy(init('602a60005260206000f3'), {
            abi: [
              {
                type: 'function',
                name: 'read',
                inputs: [],
                outputs: [{ type: 'uint256' }],
                stateMutability,
              },
            ],
          })
          const params = {
            owner_address: f.owner,
            contract_address: deployed.address,
            function_selector: 'read()',
          }
          for (const budget of [0, 1, 17, 18, 19, 100]) {
            const result = await f.request<ContractCallResult>('wallet/triggersmartcontract', {
              ...params,
              fee_limit: budget * energyFee,
            })
            assert.strictEqual(result.result?.result === true, budget === 0 || budget >= 16)
            if (budget === 0 || budget >= 16) assert.strictEqual(result.energy_used, 16)
          }
          const constant = await f.request<ContractCallResult>('wallet/triggerconstantcontract', {
            ...params,
            fee_limit: energyFee,
          })
          assert.strictEqual(constant.energy_used, 16)
          // A large transaction budget still respects the process's read-call cap.
          await f.node.tre.setAccountCode(deployed.address, '600160005500')
          const capped = await f.request<ContractCallResult>('wallet/triggersmartcontract', {
            ...params,
            fee_limit: 100_000_000,
          })
          assert.isNotTrue(capped.result?.result)
        }
      } finally {
        await f.close()
      }
    },
  )

  it.each([0, 50, 100])(
    'updates both energy contributors at caller percentage %s',
    async (percent) => {
      const f = await fixture(0)
      try {
        await f.commit(
          await f.request<TronTransaction>('wallet/freezebalancev2', {
            owner_address: f.owner,
            frozen_balance: 1_000_000,
            resource: 'ENERGY',
          }),
        )
        const contract = await f.deploy(init('602a60005260206000f3'), {
          consume_user_resource_percent: percent,
          origin_energy_limit: 1000,
        })
        type Stamps = {
          latest_opration_time: number
          account_resource: { latest_consume_time_for_energy?: number }
        }
        const account = (address: string) => f.request<Stamps>('wallet/getaccount', { address })
        const before = await account(f.owner)
        await f.node.tre.increaseTime(6)
        const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', {
          owner_address: f.beneficiary,
          contract_address: contract.address,
          fee_limit: 100_000_000,
        })
        const info = await f.commit(built.transaction!, 1)
        assert.strictEqual(
          Number(info.receipt?.origin_energy_usage ?? 0),
          Math.floor((16 * (100 - percent)) / 100),
        )
        const origin = await account(f.owner)
        const caller = await account(f.beneficiary)
        assert.isAbove(origin.latest_opration_time, before.latest_opration_time)
        assert.isAbove(
          origin.account_resource.latest_consume_time_for_energy!,
          before.account_resource.latest_consume_time_for_energy!,
        )
        assert.strictEqual(
          caller.account_resource.latest_consume_time_for_energy,
          origin.account_resource.latest_consume_time_for_energy,
        )
        const stamp = caller.account_resource.latest_consume_time_for_energy
        await f.node.tre.setAccountCode(contract.address, '00')
        await f.node.tre.increaseTime(6)
        const empty = await f.request<ContractCallResult>('wallet/triggersmartcontract', {
          owner_address: f.beneficiary,
          contract_address: contract.address,
          fee_limit: 100_000_000,
        })
        const headTime = nodeCore(f.node).head().timestampMs
        const emptyInfo = await f.commit(empty.transaction!, 1)
        assert.strictEqual(Number(emptyInfo.receipt?.energy_usage_total ?? 0), 0)
        assert.strictEqual(Number(emptyInfo.receipt?.energy_fee ?? 0), 0)
        assert.isAbove(headTime, stamp!)
        assert.strictEqual(
          (await account(f.beneficiary)).account_resource.latest_consume_time_for_energy,
          headTime,
        )
        const idleOrigin = await account(f.owner)
        assert.strictEqual(idleOrigin.latest_opration_time, origin.latest_opration_time)
        assert.strictEqual(idleOrigin.account_resource.latest_consume_time_for_energy, headTime)
      } finally {
        await f.close()
      }
    },
  )

  it.each([
    { unfreezeDelayDays: 14, sameAccount: false, stakedCaller: false },
    { unfreezeDelayDays: 14, sameAccount: false, stakedCaller: true },
    { unfreezeDelayDays: 14, sameAccount: true, stakedCaller: false },
    { unfreezeDelayDays: 0, sameAccount: false, stakedCaller: false },
    { unfreezeDelayDays: 0, sameAccount: true, stakedCaller: false },
  ])('commits zero-energy preparation timestamps only in Stake V2: %j', async (scenario) => {
    const { unfreezeDelayDays, sameAccount, stakedCaller } = scenario
    const f = await fixture(60, { chainParameters: { unfreezeDelayDays } })
    try {
      const caller = sameAccount ? f.owner : f.beneficiary
      const callerIndex = sameAccount ? 0 : 1
      if (stakedCaller) {
        await f.commit(
          await f.request<TronTransaction>('wallet/freezebalancev2', {
            owner_address: caller,
            frozen_balance: 1_000_000,
            resource: 'ENERGY',
          }),
          callerIndex,
        )
      }
      const contract = await f.deploy(init('00'))
      await f.node.tre.increaseTime(6)
      await f.node.tre.mine()
      const core = nodeCore(f.node)
      const originAddress = parseTronAddress(f.owner)
      const callerAddress = parseTronAddress(caller)
      const before = await probeState(f.node)
      const originOperation = core.operationTime(originAddress)
      const originEnergyTime = core.energyUsedAt(originAddress)
      const callerEnergyTime = core.energyUsedAt(callerAddress)
      const headTime = core.head().timestampMs
      const params = {
        owner_address: caller,
        contract_address: contract.address,
        fee_limit: 100_000_000,
      }
      for (const method of ['wallet/triggerconstantcontract', 'wallet/estimateenergy']) {
        const result = await f.request<ContractCallResult>(method, params)
        assert.isTrue(result.result?.result)
        assert.deepEqual(await probeState(f.node), before, method)
      }
      const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', params)
      assert.deepEqual(await probeState(f.node), before, 'Building leaves canonical state intact')
      await f.send(built.transaction!, callerIndex)
      assert.deepEqual(await probeState(f.node), before, 'Pending execution is isolated')
      await f.node.tre.mine()
      const info = await f.request<TransactionInfo>('wallet/gettransactioninfobyid', {
        value: built.transaction!.txID,
      })
      assert.strictEqual(info.receipt?.result, 'SUCCESS')
      assert.strictEqual(Number(info.receipt?.energy_usage_total ?? 0), 0)
      assert.strictEqual(Number(info.receipt?.energy_fee ?? 0), 0)
      assert.strictEqual(Number(info.receipt?.origin_energy_usage ?? 0), 0)
      assert.strictEqual(Number(info.receipt?.energy_usage ?? 0), 0)
      assert.strictEqual(
        core.energyUsedAt(originAddress),
        unfreezeDelayDays > 0 ? headTime : originEnergyTime,
      )
      assert.strictEqual(
        core.energyUsedAt(callerAddress),
        unfreezeDelayDays > 0 ? headTime : callerEnergyTime,
      )
      assert.strictEqual(core.operationTime(callerAddress), headTime)
      if (!sameAccount) assert.strictEqual(core.operationTime(originAddress), originOperation)
    } finally {
      await f.close()
    }
  })

  it('rolls back zero-energy preparation on a block failure and commits it on retry', async () => {
    const f = await fixture(60)
    let restore = () => {}
    try {
      const contract = await f.deploy(init('00'))
      await f.node.tre.increaseTime(6)
      await f.node.tre.mine()
      const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', {
        owner_address: f.beneficiary,
        contract_address: contract.address,
        fee_limit: 100_000_000,
      })
      await f.send(built.transaction!, 1)
      const before = await probeState(f.node)
      const pending = await f.request('wallet/gettransactionlistfrompending')
      const core = nodeCore(f.node)
      const headTime = core.head().timestampMs
      const spy = vi.spyOn(core, 'sealBlock').mockRejectedValueOnce(new Error('block fault'))
      restore = () => spy.mockRestore()
      await rejects(f.node.tre.mine(), /block fault/)
      restore()
      assert.deepEqual(await probeState(f.node), before)
      assert.deepEqual(await f.request('wallet/gettransactionlistfrompending'), pending)
      assert.deepEqual(
        await f.request('wallet/gettransactioninfobyid', { value: built.transaction!.txID }),
        {},
      )
      await f.node.tre.mine()
      for (const address of [f.owner, f.beneficiary]) {
        assert.strictEqual(core.energyUsedAt(parseTronAddress(address)), headTime)
      }
      assert.deepEqual(await f.request('wallet/getpendingsize'), { pendingSize: 0 })
      assert.deepEqual(
        core.head().txs.map((tx) => tx.txid),
        [built.transaction!.txID],
      )
    } finally {
      restore()
      await f.close()
    }
  })

  it('discards preparation timestamps when zero-energy execution fails', async () => {
    const f = await fixture(0)
    try {
      const contract = await f.deploy(init('fe'))
      await f.node.tre.increaseTime(6)
      await f.node.tre.mine()
      const core = nodeCore(f.node)
      const addresses = [f.owner, f.beneficiary].map(parseTronAddress)
      const before = addresses.map((address) => core.energyUsedAt(address))
      const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', {
        owner_address: f.beneficiary,
        contract_address: contract.address,
        fee_limit: 1,
      })
      const info = await f.commit(built.transaction!, 1)
      assert.strictEqual(info.id, built.transaction!.txID)
      assert.strictEqual(info.result, 'FAILED')
      assert.notStrictEqual(info.receipt?.result, 'SUCCESS')
      assert.strictEqual(Number(info.receipt?.energy_usage_total ?? 0), 0)
      assert.deepEqual(
        addresses.map((address) => core.energyUsedAt(address)),
        before,
      )
    } finally {
      await f.close()
    }
  })

  it.each([0, 14])('handles zero-energy creation with unfreezeDelayDays=%s', async (delay) => {
    const f = await fixture(0, { chainParameters: { unfreezeDelayDays: delay } })
    try {
      await f.node.tre.increaseTime(6)
      await f.node.tre.mine()
      const core = nodeCore(f.node)
      const owner = parseTronAddress(f.owner)
      const before = core.energyUsedAt(owner)
      const headTime = core.head().timestampMs
      const contract = await f.deploy('00')
      assert.strictEqual(contract.receipt.receipt?.result, 'SUCCESS')
      assert.strictEqual(Number(contract.receipt.receipt?.energy_usage_total ?? 0), 0)
      assert.strictEqual(Number(contract.receipt.receipt?.energy_fee ?? 0), 0)
      assert.strictEqual(core.energyUsedAt(owner), delay > 0 ? headTime : before)
    } finally {
      await f.close()
    }
  })

  it('does not prepare energy for plain TRX transfers', async () => {
    const f = await fixture(0, { chainParameters: { forbidTransferToContract: 0 } })
    try {
      const contract = await f.deploy(init('00'))
      const core = nodeCore(f.node)
      const addresses = [f.owner, f.beneficiary, contract.address].map(parseTronAddress)
      const before = addresses.map((address) => core.energyUsedAt(address))
      for (const recipient of [f.owner, contract.address]) {
        await f.node.tre.increaseTime(6)
        await f.node.tre.mine()
        const tx = await f.request<TronTransaction>('wallet/createtransaction', {
          owner_address: f.beneficiary,
          to_address: recipient,
          amount: 1,
        })
        const info = await f.commit(tx, 1)
        assert.strictEqual(info.id, tx.txID)
        assert.isUndefined(info.result)
        assert.deepEqual(
          addresses.map((address) => core.energyUsedAt(address)),
          before,
        )
      }
    } finally {
      await f.close()
    }
  })

  it.each([0, 30])(
    'deletes same-transaction SELFDESTRUCT state with interval %s',
    async (seconds) => {
      const f = await fixture(seconds)
      try {
        const destroy = `73${f.beneficiary.slice(2)}ff`
        // Both constructor destruction and a CALL after successful child creation.
        for (const inConstructor of [true, false]) {
          const childInit = inConstructor ? destroy : init(`6001600055${destroy}`)
          const length = (childInit.length / 2).toString(16).padStart(2, '0')
          const call = inConstructor ? '' : '600060006000600060006000515af150'
          const template = `60${length}60OFFSET60003960${length}60006064f0600052${call}60206000f3`
          const prefix = template.replace(
            'OFFSET',
            ((template.length - 4) / 2).toString(16).padStart(2, '0'),
          )
          const factory = await f.deploy(init(prefix + childInit), { call_value: 100 })
          const before = await f.balance()
          const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', {
            owner_address: f.owner,
            contract_address: factory.address,
            fee_limit: 100_000_000,
          })
          const receipt = await f.commit(built.transaction!)
          assert.strictEqual(receipt.receipt?.result, 'SUCCESS')
          assert.strictEqual(await f.balance(), before + 100n)
          const child = `41${receipt.contractResult![0].slice(-40)}`
          assert.deepEqual(await f.request('wallet/getaccount', { address: child }), {})
          assert.isUndefined(
            (await f.request<{ contract_address?: string }>('wallet/getcontract', { value: child }))
              .contract_address,
          )
          assert.isNotOk(
            (await f.request<{ runtimecode?: string }>('wallet/getcontractinfo', { value: child }))
              .runtimecode,
          )
          assert.deepEqual(
            (await f.node.debug.storageRangeAt('latest', 0, child, null, 10)).storage,
            {},
          )
          assert.strictEqual(
            (await f.node.debug.traceTransaction(built.transaction!.txID)).returnValue,
            receipt.contractResult![0],
          )
          // Recreating the address starts with neither old storage nor old metadata.
          await f.node.tre.setAccountBalance(child, 1)
          assert.deepEqual(
            (await f.node.debug.storageRangeAt('latest', 0, child, null, 10)).storage,
            {},
          )
          assert.isUndefined(
            (await f.request<{ contract_address?: string }>('wallet/getcontract', { value: child }))
              .contract_address,
          )
        }
        const before = await f.balance()
        const top = await f.deploy(destroy, { call_value: 100 })
        assert.strictEqual(top.receipt.receipt?.result, 'SUCCESS')
        assert.strictEqual(await f.balance(), before + 100n)
        assert.deepEqual(await f.request('wallet/getaccount', { address: top.address }), {})
        assert.isUndefined(
          (
            await f.request<{ contract_address?: string }>('wallet/getcontract', {
              value: top.address,
            })
          ).contract_address,
        )
      } finally {
        await f.close()
      }
    },
  )

  it.each([0, 30])(
    'retains previously deployed contracts after SELFDESTRUCT with interval %s',
    async (seconds) => {
      const f = await fixture(seconds)
      try {
        const runtime = `73${f.beneficiary.slice(2)}ff`
        const deployed = await f.deploy(init(runtime, '6007600055'), { call_value: 100 })
        assert.strictEqual(deployed.receipt.receipt?.result, 'SUCCESS')
        const contractBefore = await f.request('wallet/getcontract', { value: deployed.address })
        const storageBefore = await f.node.debug.storageRangeAt(
          'latest',
          0,
          deployed.address,
          null,
          10,
        )
        assert.lengthOf(Object.keys(storageBefore.storage), 1)
        const before = await f.balance()
        const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', {
          owner_address: f.owner,
          contract_address: deployed.address,
          fee_limit: 100_000_000,
        })
        const receipt = await f.commit(built.transaction!)
        assert.strictEqual(receipt.receipt?.result, 'SUCCESS')
        assert.strictEqual(await f.balance(), before + 100n)
        const account = await f.request<{ address?: string; balance?: number | bigint }>(
          'wallet/getaccount',
          { address: deployed.address },
        )
        assert.strictEqual(account.address, deployed.address)
        assert.strictEqual(BigInt(account.balance ?? 0), 0n)
        assert.deepEqual(
          await f.request('wallet/getcontract', { value: deployed.address }),
          contractBefore,
        )
        assert.strictEqual(
          (
            await f.request<{ runtimecode?: string }>('wallet/getcontractinfo', {
              value: deployed.address,
            })
          ).runtimecode,
          runtime,
        )
        assert.deepEqual(
          (await f.node.debug.storageRangeAt('latest', 0, deployed.address, null, 10)).storage,
          storageBefore.storage,
        )
        assert.isFalse((await f.node.debug.traceTransaction(built.transaction!.txID)).failed)
      } finally {
        await f.close()
      }
    },
  )

  it.each([0, 30])(
    'rolls back child destruction when its parent reverts with interval %s',
    async (seconds) => {
      const f = await fixture(seconds)
      try {
        const childInit = `73${f.beneficiary.slice(2)}ff`
        const factory = await f.deploy(
          init(`60166016600039601660006064f060005260006000fd${childInit}`),
          { call_value: 100 },
        )
        const before = await f.balance()
        const built = await f.request<ContractCallResult>('wallet/triggersmartcontract', {
          owner_address: f.owner,
          contract_address: factory.address,
          fee_limit: 100_000_000,
        })
        const receipt = await f.commit(built.transaction!)
        assert.strictEqual(receipt.receipt?.result, 'REVERT')
        assert.strictEqual(await f.balance(), before)
        const internals = receipt.internal_transactions as {
          transferTo_address: string
          rejected?: boolean
        }[]
        assert.isTrue(internals[0].rejected)
        assert.isTrue(internals[1].rejected)
        assert.deepEqual(
          await f.request('wallet/getaccount', { address: internals[0].transferTo_address }),
          {},
        )
        assert.isTrue((await f.node.debug.traceTransaction(built.transaction!.txID)).failed)
      } finally {
        await f.close()
      }
    },
  )

  it.each([0, 30])(
    'discards constructor effects when code deposit fails with interval %s',
    async (seconds) => {
      const f = await fixture(seconds)
      try {
        // Create a child, emit LOG1 and return one byte of code.
        const bytecode = init('00', '600060006000f0506001600052600260206000a1')
        const good = await f.deploy(bytecode)
        assert.strictEqual(good.receipt.receipt?.result, 'SUCCESS')
        assert.lengthOf(good.receipt.log as unknown[], 1)
        const energy = Number(good.receipt.receipt!.energy_usage_total)
        const failed = await f.deploy(bytecode, {
          fee_limit: (energy - 1) * f.node.config.chainParameters.energyFee,
        })
        assert.strictEqual(failed.receipt.receipt?.result, 'OUT_OF_ENERGY')
        assert.lengthOf((failed.receipt.log ?? []) as unknown[], 0)
        assert.deepEqual(await f.request('wallet/getaccount', { address: failed.address }), {})
        const internals = failed.receipt.internal_transactions as {
          transferTo_address: string
          rejected?: boolean
        }[]
        assert.isTrue(internals[0].rejected)
        assert.deepEqual(
          await f.request('wallet/getaccount', { address: internals[0].transferTo_address }),
          {},
        )
        const trace = await f.node.debug.traceTransaction(failed.tx.txID)
        assert.isTrue(trace.failed)
        assert.strictEqual(trace.returnValue, '')
      } finally {
        await f.close()
      }
    },
  )
})

describe('TronWeb write path against @tvmjs/client over HTTP', () => {
  const config = resolveConfig()
  const ownerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
  let node: TronNode
  let provider: TronProvider
  let server: Server
  let tronWeb: TronWeb
  let baseUrl = ''
  let deployedAddress = ''

  beforeAll(async () => {
    node = await TronNode.create(config)
    provider = new TronProvider(node)
    const started = await startHttpServer(provider, { port: 0 })
    server = started.server
    baseUrl = started.url
    tronWeb = new TronWeb({
      fullHost: started.url,
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    })
  })

  afterAll(() => {
    server.close()
  })

  it('sendTransaction moves TRX (local build → sign → broadcasttransaction)', async () => {
    const receiver = utils.accounts.generateAccount().address.base58
    const amount = 1_000_000 // 1 TRX

    const response = await tronWeb.trx.sendTransaction(receiver, amount)
    assert.isTrue(response.result)

    assert.strictEqual(await tronWeb.trx.getBalance(receiver), amount)
    // the transfer creates the recipient account: create-account fee (0.1 TRX,
    // bandwidth side) + system-contract fee (1 TRX) burned from the sender
    const createFees =
      config.chainParameters.createAccountFee +
      config.chainParameters.createNewAccountFeeInSystemContract
    assert.strictEqual(
      await tronWeb.trx.getBalance(ownerBase58),
      Number(accountsFromMnemonic(config.mnemonic)[0].balance) - amount - createFees,
    )

    const txid = (response as { txid: string }).txid
    const tx = (await tronWeb.trx.getTransaction(txid)) as { ret?: { contractRet?: string }[] }
    assert.strictEqual(tx.ret?.[0]?.contractRet, 'SUCCESS')
    const info = await tronWeb.trx.getTransactionInfo(txid)
    assert.isAbove(info.blockNumber as number, 0)
    assert.strictEqual(info.fee, createFees)
    assert.strictEqual(info.receipt.net_fee, config.chainParameters.createAccountFee)

    // a second transfer to the now-existing account bills free bandwidth
    const again = await tronWeb.trx.sendTransaction(receiver, amount)
    const againInfo = await tronWeb.trx.getTransactionInfo((again as { txid: string }).txid)
    assert.isUndefined(againInfo.fee)
    assert.isAbove(againInfo.receipt.net_usage as number, 0)

    // txTrieRoot: sha256 merkle over the contained tx (single leaf) — must be
    // neither the ETH empty-trie constant nor the empty-block zero root
    const block = await tronWeb.trx.getBlockByNumber(info.blockNumber as number)
    const txTrieRoot = block.block_header.raw_data.txTrieRoot as string
    assert.match(txTrieRoot, /^[0-9a-f]{64}$/)
    assert.notStrictEqual(txTrieRoot, '0'.repeat(64))
    assert.notStrictEqual(
      txTrieRoot,
      '56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    )

    // empty blocks report the zero root
    const empty = await node.tre.mine(1)
    const emptyBlock = await tronWeb.trx.getBlockByNumber(Number(empty.number))
    assert.strictEqual(emptyBlock.block_header.raw_data.txTrieRoot, '0'.repeat(64))
  })

  it('createSmartContract deploy: node derives the same contract_address as TronWeb', async () => {
    const unsigned = await tronWeb.transactionBuilder.createSmartContract(
      {
        abi: INC_ABI,
        bytecode: INC_INITCODE,
        feeLimit: 1_000_000_000,
        callValue: 0,
        name: 'Inc',
      },
      ownerBase58,
    )
    // the client pre-computes the deploy address locally from the txID
    const expectedAddress = unsigned.contract_address
    assert.isString(expectedAddress)

    const signed = await tronWeb.trx.sign(unsigned)
    const broadcast = await tronWeb.trx.sendRawTransaction(signed)
    assert.isTrue(broadcast.result)

    const info = await tronWeb.trx.getTransactionInfo(signed.txID)
    assert.strictEqual(info.contract_address, expectedAddress)
    assert.strictEqual(info.receipt.result, 'SUCCESS')
    assert.isAbove(info.receipt.energy_usage_total as number, 0)

    // runtime code landed at the derived address
    const contractInfo = (await tronWeb.trx.getContractInfo(expectedAddress)) as {
      runtimecode?: string
    }
    assert.strictEqual(contractInfo.runtimecode, INC_RUNTIME)

    // ABI registered → contract.at() works
    const instance = await tronWeb.contract().at(expectedAddress)
    assert.isDefined(instance.inc)

    deployedAddress = expectedAddress
  })

  it('contract .send() goes through triggersmartcontract + broadcast and mutates state', async () => {
    const instance = tronWeb.contract(INC_ABI, deployedAddress)

    const first = await instance.inc().send({ feeLimit: 100_000_000, shouldPollResponse: true })
    assert.strictEqual(first, 1n)

    const second = await instance.inc().send({ feeLimit: 100_000_000, shouldPollResponse: true })
    assert.strictEqual(second, 2n)
  })

  it('trigger .send() charges the energy fee to the sender', async () => {
    const before = await tronWeb.trx.getBalance(ownerBase58)
    const instance = tronWeb.contract(INC_ABI, deployedAddress)
    const txid = (await instance.inc().send({ feeLimit: 100_000_000 })) as string

    const info = await tronWeb.trx.getTransactionInfo(txid)
    const fee = info.fee as number
    assert.isAbove(fee, 0)
    assert.strictEqual(await tronWeb.trx.getBalance(ownerBase58), before - fee)
    // total fee = energy fee + burned bandwidth fee (free quota exhausted here)
    assert.strictEqual(
      fee,
      (info.receipt.energy_usage_total as number) * config.chainParameters.energyFee +
        ((info.receipt.net_fee as number | undefined) ?? 0),
    )
  })

  it('an internal call prints its calldata as data, the way the console.log tooling reads it', async () => {
    const receiverHex = '55'.repeat(20)
    // runtime: MSTORE selector, CALL(to 0x55…55, in 0..4), overwrite memory 0..32, STOP
    const callerRuntime =
      `63deadbeef60e01b60005260006000600460006000 73${receiverHex}61fffff1 7f${'ee'.repeat(32)}60005200`.replace(
        / /g,
        '',
      )
    const contractHex = `41${'66'.repeat(20)}`
    const { hexToBytes } = await import('@tvmjs/util')
    await nodeCore(node).setCode(parseTronAddress(contractHex), hexToBytes(`0x${callerRuntime}`))

    const instance = tronWeb.contract(INC_ABI, TronWeb.address.fromHex(contractHex))
    const txid = (await instance.inc().send({ feeLimit: 100_000_000 })) as string
    const info = await tronWeb.trx.getTransactionInfo(txid)
    const internals = info.internal_transactions as Record<string, unknown>[]
    assert.lengthOf(internals, 1)
    assert.strictEqual(internals[0].transferTo_address, `41${receiverHex}`)
    assert.strictEqual(internals[0].data, 'deadbeef')
    assert.deepEqual(internals[0].callValueInfo, [{}])
  })

  it('states a destroying contract as a frame of its own', async () => {
    const heirHex = 'ab'.repeat(20)
    // runtime: PUSH1 0, PUSH20 heir, SELFDESTRUCT — the leading push leaves
    // something under the beneficiary, so the wrong end of the stack shows
    const dying = parseTronAddress(`41${'cd'.repeat(20)}`)
    await nodeCore(node).setCode(dying, hexToBytes(`0x600073${heirHex}ff`))
    await nodeCore(node).setBalance(dying, 4_242n)

    const instance = tronWeb.contract(INC_ABI, TronWeb.address.fromHex(`41${'cd'.repeat(20)}`))
    const txid = (await instance.inc().send({ feeLimit: 100_000_000 })) as string
    const info = await tronWeb.trx.getTransactionInfo(txid)
    const internals = info.internal_transactions as Record<string, unknown>[]

    assert.lengthOf(internals, 1)
    assert.strictEqual(internals[0].note, TronWeb.fromUtf8('suicide').replace(/^0x/, ''))
    assert.strictEqual(internals[0].caller_address, `41${'cd'.repeat(20)}`)
    assert.strictEqual(internals[0].transferTo_address, `41${heirHex}`)
    assert.deepEqual(internals[0].callValueInfo, [{ callValue: 4_242 }])
    // the frame spends a nonce like any other, and hashes over the balance it moved
    assert.strictEqual(
      internals[0].hash,
      internalHash(txid, `41${heirHex}`, new Uint8Array(), 4_242n, 1n),
    )
    // the heir actually received it
    assert.strictEqual(await tronWeb.trx.getBalance(TronWeb.address.fromHex(`41${heirHex}`)), 4_242)
  })

  it('chains a nested frame onto the hash of the frame that opened it', async () => {
    // A calls B, B calls C: two frames, the second opened from inside the first
    const middleHex = '77'.repeat(20)
    const innerHex = '88'.repeat(20)
    const callTo = (target: string): string => `6000600060006000600073${target}61fffff100`
    const outer = parseTronAddress(`41${'99'.repeat(20)}`)
    await nodeCore(node).setCode(outer, hexToBytes(`0x${callTo(middleHex)}`))
    await nodeCore(node).setCode(
      parseTronAddress(`41${middleHex}`),
      hexToBytes(`0x${callTo(innerHex)}`),
    )

    const instance = tronWeb.contract(INC_ABI, TronWeb.address.fromHex(`41${'99'.repeat(20)}`))
    const txid = (await instance.inc().send({ feeLimit: 100_000_000 })) as string
    const info = await tronWeb.trx.getTransactionInfo(txid)
    const internals = info.internal_transactions as Record<string, unknown>[]
    assert.lengthOf(internals, 2)

    // the outer frame hangs off the transaction and spends the first nonce
    const first = internalHash(txid, `41${middleHex}`, new Uint8Array(), 0n, 1n)
    assert.strictEqual(internals[0].hash, first)
    // the inner one hangs off the outer frame's hash, not off the transaction
    assert.strictEqual(
      internals[1].hash,
      internalHash(first, `41${innerHex}`, new Uint8Array(), 0n, 2n),
    )
    assert.notStrictEqual(
      internals[1].hash,
      internalHash(txid, `41${innerHex}`, new Uint8Array(), 0n, 2n),
    )
  })

  it('receipts expose internal_transactions and bandwidth billing', async () => {
    // handcrafted runtime: CALL(gas 0xffff, to 0x22…22, value 100) then STOP
    const receiverHex = '22'.repeat(20)
    const callerRuntime = `6000600060006000606473${receiverHex}61fffff100`
    const contractHex = `41${'33'.repeat(20)}`
    const { hexToBytes } = await import('@tvmjs/util')
    const contract = parseTronAddress(contractHex)
    await nodeCore(node).setCode(contract, hexToBytes(`0x${callerRuntime}`))
    await nodeCore(node).setBalance(contract, 1_000n)

    const instance = tronWeb.contract(INC_ABI, TronWeb.address.fromHex(contractHex))
    const txid = (await instance.inc().send({ feeLimit: 100_000_000 })) as string
    const info = await tronWeb.trx.getTransactionInfo(txid)

    const internals = info.internal_transactions as Record<string, unknown>[]
    assert.lengthOf(internals, 1)
    assert.strictEqual(internals[0].caller_address, contractHex)
    assert.strictEqual(internals[0].transferTo_address, `41${receiverHex}`)
    assert.deepEqual(internals[0].callValueInfo, [{ callValue: 100 }])
    assert.strictEqual(internals[0].note, TronWeb.fromUtf8('call').replace(/^0x/, ''))
    assert.isUndefined(internals[0].rejected)
    assert.isUndefined(internals[0].data)
    // the hash commits to the frame: this transaction, the callee, no calldata,
    // 100 sun, and the first nonce the execution spent
    assert.strictEqual(
      internals[0].hash,
      internalHash(txid, `41${receiverHex}`, new Uint8Array(), 100n, 1n),
    )
    // the internal transfer actually moved value
    assert.strictEqual(
      await tronWeb.trx.getBalance(TronWeb.address.fromHex(`41${receiverHex}`)),
      100,
    )

    // bandwidth billing: the receipt reports free usage or a burned fee, never both
    const receipt = info.receipt as Record<string, unknown>
    assert.isTrue((receipt.net_usage !== undefined) !== (receipt.net_fee !== undefined))

    // account resources report the decayed free-bandwidth usage
    const resources = (await tronWeb.trx.getAccountResources(ownerBase58)) as unknown as Record<
      string,
      unknown
    >
    assert.isAbove(resources.freeNetUsed as number, 0)
  })

  it('visible=true: base58 echo, strict input, constant calls carry the full tx', async () => {
    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}/${path}`, { method: 'POST', body: JSON.stringify(body) })
      return (await res.json()) as Record<string, unknown>
    }
    const receiverBase58 = utils.accounts.generateAccount().address.base58

    // visible=true request: base58 in, base58 echoed, visible flagged
    const built = await post('wallet/createtransaction', {
      owner_address: ownerBase58,
      to_address: receiverBase58,
      amount: 1,
      visible: true,
    })
    assert.strictEqual(built.visible, true)
    assert.match(built.txID as string, /^[0-9a-f]{64}$/)
    const value = (
      built.raw_data as { contract: { parameter: { value: Record<string, unknown> } }[] }
    ).contract[0].parameter.value
    assert.strictEqual(value.owner_address, ownerBase58)
    assert.strictEqual(value.to_address, receiverBase58)

    // strict pairing: hex address with visible=true is a parse error
    const mismatch = await post('wallet/createtransaction', {
      owner_address: TronWeb.address.toHex(ownerBase58),
      to_address: receiverBase58,
      amount: 1,
      visible: true,
    })
    assert.property(mismatch, 'Error')

    // constant calls embed the full would-be transaction, not a stub
    const constant = await post('wallet/triggerconstantcontract', {
      owner_address: TronWeb.address.toHex(ownerBase58),
      contract_address: TronWeb.address.toHex(deployedAddress),
      function_selector: 'inc()',
    })
    const embedded = constant.transaction as {
      txID: string
      raw_data: { ref_block_hash?: string; expiration?: number }
    }
    assert.match(embedded.txID, /^[0-9a-f]{64}$/)
    assert.isString(embedded.raw_data.ref_block_hash)
    assert.isAbove(embedded.raw_data.expiration as number, 0)
  })

  it('rejects a broadcast with a tampered signature', async () => {
    const receiver = utils.accounts.generateAccount().address.base58
    const unsigned = await tronWeb.transactionBuilder.sendTrx(receiver, 1_000_000, ownerBase58)
    const signed = await tronWeb.trx.sign(unsigned)
    // flip signature bytes: recovery yields a different (or no) signer
    const sig = signed.signature![0]
    const tampered = {
      ...signed,
      signature: [`${sig.slice(0, -8)}${sig.slice(-8) === '00000000' ? '11111111' : '00000000'}`],
    }

    const response = await tronWeb.trx.sendRawTransaction(tampered as never)
    assert.strictEqual((response as unknown as { code?: string }).code, 'SIGERROR')
  })

  it('rejects wrong ref blocks (Tapos) and expired transactions', async () => {
    const { txJsonToPb, txPbToTxID, txPbToRawDataHex } = utils.transaction
    const receiver = utils.accounts.generateAccount().address.base58
    // unlocked owner: broadcasts need only txID integrity, so a hand-tampered
    // raw_data stays broadcastable after recomputing the txID
    nodeCore(node).unlockedAccounts.add(ownerBase58)

    const broadcastTampered = async (mutate: (raw: Record<string, unknown>) => void) => {
      const unsigned = await tronWeb.transactionBuilder.sendTrx(receiver, 1_000_000, ownerBase58)
      mutate(unsigned.raw_data as unknown as Record<string, unknown>)
      const pb = txJsonToPb(unsigned as never)
      const txID = (txPbToTxID(pb) as string).replace(/^0x/, '')
      const rawDataHex = (txPbToRawDataHex(pb) as string).toLowerCase()
      const res = await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
        method: 'POST',
        body: JSON.stringify({ ...unsigned, txID, raw_data_hex: rawDataHex }),
      })
      return (await res.json()) as Record<string, unknown>
    }

    const tapos = await broadcastTampered((raw) => {
      raw.ref_block_hash = 'deadbeefdeadbeef'
    })
    assert.strictEqual(tapos.code, 'TAPOS_ERROR')

    const expired = await broadcastTampered((raw) => {
      raw.expiration = Date.now() - 60_000
    })
    assert.strictEqual(expired.code, 'TRANSACTION_EXPIRATION_ERROR')

    nodeCore(node).unlockedAccounts.delete(ownerBase58)
  })

  it('rejects duplicate broadcasts', async () => {
    const receiver = utils.accounts.generateAccount().address.base58
    const unsigned = await tronWeb.transactionBuilder.sendTrx(receiver, 1_000_000, ownerBase58)
    const signed = await tronWeb.trx.sign(unsigned)

    const ok = await tronWeb.trx.sendRawTransaction(signed)
    assert.isTrue(ok.result)
    const dup = await tronWeb.trx.sendRawTransaction(signed)
    assert.strictEqual((dup as unknown as { code?: string }).code, 'DUP_TRANSACTION_ERROR')
  })

  it('concurrent broadcasts of one transaction execute it exactly once', async () => {
    const receiver = utils.accounts.generateAccount().address.base58
    const signed = await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.sendTrx(receiver, 1_000_000, ownerBase58),
    )
    const height = nodeCore(node).blocks.height()

    // in-process: no HTTP body read to serialise the callers, so the duplicate
    // guard has to hold on its own
    const provider = new TronProvider(node)
    const replies = (await Promise.all(
      Array.from({ length: 10 }, () =>
        provider.request({
          method: 'wallet/broadcasttransaction',
          params: signed as never,
        }),
      ),
    )) as { result?: boolean; code?: string }[]

    assert.strictEqual(replies.filter((reply) => reply.result === true).length, 1)
    assert.strictEqual(replies.filter((reply) => reply.code === 'DUP_TRANSACTION_ERROR').length, 9)
    assert.strictEqual(await tronWeb.trx.getBalance(receiver), 1_000_000)
    assert.strictEqual(nodeCore(node).blocks.height(), height + 1n)
  })

  it('a transfer that cannot cover amount plus fees is rejected and costs nothing', async () => {
    const thin = utils.accounts.generateAccount().address.base58
    const fresh = utils.accounts.generateAccount().address.base58
    // the 0.1 TRX creation fee comes off first, leaving 1.9 TRX for a 2 TRX send
    await nodeCore(node).setBalance(parseTronAddress(thin), 2_000_000n)
    nodeCore(node).unlockedAccounts.add(thin)

    const unsigned = (await tronWeb.transactionBuilder.sendTrx(
      fresh,
      2_000_000,
      thin,
    )) as unknown as Record<string, unknown>
    const reply = (await tronWeb.trx.sendRawTransaction({
      ...unsigned,
      signature: ['00'.repeat(65)],
    } as never)) as unknown as { result?: boolean; code?: string }

    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(await tronWeb.trx.getBalance(thin), 2_000_000)
    assert.strictEqual(await tronWeb.trx.getBalance(fresh), 0)
  })

  it('sendHexTransaction moves TRX through the protobuf envelope', async () => {
    const receiver = utils.accounts.generateAccount().address.base58
    const signed = await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.sendTrx(receiver, 1_000_000, ownerBase58),
    )
    const pb = utils.transaction.txJsonToPb(signed as never) as unknown as {
      addSignature(bytes: Uint8Array): void
      serializeBinary(): Uint8Array
    }
    for (const entry of signed.signature) {
      pb.addSignature(hexToBytes(`0x${entry}`))
    }
    const hex = bytesToHex(pb.serializeBinary()).slice(2)

    const response = (await tronWeb.trx.sendHexTransaction(hex)) as unknown as {
      result: boolean
      code: string
      txid: string
      transaction: { raw_data: { contract: { type: string; parameter: { value: string } }[] } }
    }
    assert.isTrue(response.result)
    assert.strictEqual(response.code, 'SUCCESS')
    assert.strictEqual(response.txid, signed.txID)
    // this echo comes from the protobuf printer rather than the transaction
    // printer, so the contract stays packed as the bytes it travels as
    const echoed = response.transaction.raw_data.contract[0]
    assert.strictEqual(echoed.type, 'TransferContract')
    assert.match(echoed.parameter.value, /^[0-9a-f]+$/)
    assert.include(echoed.parameter.value, TronWeb.address.toHex(ownerBase58).toLowerCase())
    assert.strictEqual(await tronWeb.trx.getBalance(receiver), 1_000_000)

    // handwritten JSON reply: result:false survives instead of being omitted
    const dup = (await tronWeb.trx.sendHexTransaction(hex)) as unknown as {
      result: boolean
      code: string
      message: string
    }
    assert.isFalse(dup.result)
    assert.strictEqual(dup.code, 'DUP_TRANSACTION_ERROR')
    assert.strictEqual(dup.message, 'Dup transaction.')
  })

  it('builds an int64 whole up to what it signs for, and refuses past it', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    // the widest a double states, and the first integer past it
    const fits = '9007199254740991'
    const brim = '9007199254740993'
    const raw = async (path: string, body: string): Promise<string> =>
      (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).text()
    const held = (text: string, key: string): string | undefined =>
      new RegExp(`"${key}":(\\d+)`).exec(text)?.[1]
    const deploy = (amount: string): Promise<string> =>
      raw(
        'wallet/deploycontract',
        `{"owner_address":"${TronWeb.address.toHex(owner)}","abi":"[]",` +
          `"bytecode":"600180600b6000396000f300","consume_user_resource_percent":100,` +
          `"call_value":${amount},"origin_energy_limit":${amount},"fee_limit":${amount},` +
          `"token_id":${amount},"call_token_value":${amount}}`,
      )

    const built = await deploy(fits)
    for (const key of [
      'call_value',
      'origin_energy_limit',
      'fee_limit',
      'token_id',
      'call_token_value',
    ]) {
      assert.strictEqual(held(built, key), fits, `deploy ${key}`)
    }

    // the id a caller signs is hashed through the bundled encoder, which
    // states an int64 as a double
    const refused = JSON.parse(await deploy(brim)) as { Error?: string }
    assert.include(refused.Error ?? '', 'the widest this node signs for')

    // the builder refuses a target holding no code, so give it one
    const target = utils.accounts.generateAccount().address.base58
    await nodeCore(node).setCode(parseTronAddress(target), hexToBytes('0x600180600b6000396000f300'))
    const triggered = await raw(
      'wallet/triggersmartcontract',
      `{"owner_address":"${TronWeb.address.toHex(owner)}",` +
        `"contract_address":"${TronWeb.address.toHex(target)}","function_selector":"x()",` +
        `"call_value":${fits},"token_id":${fits},"call_token_value":${fits},"fee_limit":${fits}}`,
    )
    for (const key of ['call_value', 'token_id', 'call_token_value', 'fee_limit']) {
      assert.strictEqual(held(triggered, key), fits, `trigger ${key}`)
    }
  })

  it('a deploy built without an ABI is still signable', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const built = (await (
      await fetch(`${baseUrl}/wallet/deploycontract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_address: TronWeb.address.toHex(owner),
          bytecode: '600180600b6000396000f300',
          fee_limit: 100_000_000,
          consume_user_resource_percent: 100,
          origin_energy_limit: 10_000_000,
        }),
      })
    ).json()) as Record<string, unknown>
    assert.isUndefined(built.Error, JSON.stringify(built))

    // the reply must hash to the txID it carries, or no client can sign it
    const signed = await tronWeb.trx.sign(built as never)
    assert.isDefined((signed as unknown as { signature?: string[] }).signature)
    assert.strictEqual(built.visible, false)
  })

  it('names the contract account after its deployment and takes plain transfers without running code', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const built = (await (
      await fetch(`${baseUrl}/wallet/deploycontract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_address: TronWeb.address.toHex(owner),
          name: 'D',
          // runtime code is a single STOP; a transfer must not even reach it
          bytecode: '600180600b6000396000f300',
          fee_limit: 100_000_000,
          consume_user_resource_percent: 100,
          origin_energy_limit: 10_000_000,
        }),
      })
    ).json()) as { contract_address: string; txID: string }
    await tronWeb.trx.sendRawTransaction(await tronWeb.trx.sign(built as never))
    const contract = TronWeb.address.fromHex(built.contract_address)

    const account = (await tronWeb.trx.getAccount(contract)) as unknown as {
      account_name?: string
      type?: string
    }
    assert.strictEqual(account.type, 'Contract')
    // the client queries by hex address without `visible`, so the name is the bytes' hex
    assert.strictEqual(account.account_name, TronWeb.fromUtf8('D').replace(/^0x/, ''))

    const sent = (await tronWeb.trx.sendTransaction(contract, 1_000_000, {
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    })) as unknown as {
      result: boolean
      transaction: { txID: string }
    }
    assert.isTrue(sent.result)
    const info = (await tronWeb.trx.getTransactionInfo(sent.transaction.txID)) as unknown as {
      result?: string
      receipt: { energy_usage_total?: number }
    }
    assert.isUndefined(info.result, JSON.stringify(info))
    assert.isUndefined(info.receipt.energy_usage_total)
    assert.strictEqual(await tronWeb.trx.getBalance(contract), 1_000_000)
  })

  it('re-derives the echoed id when a client edits the transaction it sends back', async () => {
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      utils.accounts.generateAccount().address.base58,
      10,
      ownerBase58,
    )) as unknown as { txID: string; raw_data: { expiration: number }; raw_data_hex: string }
    const before = tx.txID
    tx.raw_data.expiration += 3600

    const echoed = (await (
      await fetch(`${baseUrl}/wallet/getsignweight`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tx),
      })
    ).json()) as { transaction: { txid: string; transaction: { txID: string } } }
    // the id follows the raw_data that arrived, not the one the client sent
    assert.notStrictEqual(echoed.transaction.transaction.txID, before)
    assert.strictEqual(echoed.transaction.transaction.txID, echoed.transaction.txid)
    // which is exactly what lets a client extend an expiration and sign again
    const extended = (await tronWeb.transactionBuilder.extendExpiration(
      tx as never,
      3600,
    )) as unknown as { txID: string }
    assert.strictEqual(extended.txID.length, 64)
  })

  it('states nothing a deployment would have stated on a planted record', async () => {
    const planted = utils.accounts.generateAccount().address.base58
    await nodeCore(node).setCode(parseTronAddress(planted), hexToBytes(`0x${INC_RUNTIME}`))
    const contract = (await (
      await fetch(`${baseUrl}/wallet/getcontract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: TronWeb.address.toHex(planted) }),
      })
    ).json()) as Record<string, unknown>
    // the record a planting makes carries the address and the percentage; the
    // abi, the deployer and the energy limit belong to a deployment
    assert.deepEqual(Object.keys(contract), [
      'contract_address',
      'consume_user_resource_percent',
      'code_hash',
    ])
    assert.strictEqual(contract.consume_user_resource_percent, 100)
  })

  it('getcontractinfo carries a contract_state fresh at the current cycle', async () => {
    const stateOf = async (value: string): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/getcontractinfo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value }),
        })
      ).json()) as Record<string, unknown>
    const info = await stateOf(deployedAddress)
    // a set message field prints even when everything in it is at default
    assert.isDefined(info.contract_state)
    assert.isDefined(info.smart_contract)
    // dynamic energy is off, so no record ever accrues usage: the reply is a
    // fresh state naming only the cycle it would start counting from
    const expected = currentCycleNumber(nodeCore(node)) > 0 ? ['update_cycle'] : []
    assert.deepEqual(Object.keys(info.contract_state as Record<string, unknown>), expected)

    // a planted contract reads the same fresh shape
    const planted = utils.accounts.generateAccount().address.base58
    await nodeCore(node).setCode(parseTronAddress(planted), hexToBytes(`0x${INC_RUNTIME}`))
    const quiet = await stateOf(TronWeb.address.toHex(planted) as string)
    assert.deepEqual(Object.keys(quiet.contract_state as Record<string, unknown>), expected)
  })

  it('the deploy builder judges the resource terms it is handed', async () => {
    const owner = TronWeb.address.toHex(ownerBase58) as string
    const build = async (extra: Record<string, unknown>): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/deploycontract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner_address: owner,
            bytecode: '600180600b6000396000f300',
            fee_limit: 100_000_000,
            ...extra,
          }),
        })
      ).json()) as Record<string, unknown>

    assert.deepEqual(await build({ consume_user_resource_percent: 101 }), {
      Error: 'percent must be >= 0 and <= 100',
    })
    // the ceiling is enforced at broadcast, and it is the chain parameter
    const overLimit = await build({ fee_limit: 20_000_000_000 })
    assert.isUndefined(overLimit.Error)
    const overSigned = utils.crypto.signTransaction(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
      overLimit as never,
    )
    const cast = (await (
      await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(overSigned),
      })
    ).json()) as { code?: string; message?: string }
    assert.strictEqual(cast.code, 'CONTRACT_VALIDATE_ERROR')
    assert.include(
      TronWeb.toUtf8(String(cast.message)),
      `feeLimit must be >= 0 and <= ${config.chainParameters.maxFeeLimit}`,
    )
    // an omitted share is zero, not a hundred: the builder states what it was given
    const defaulted = (await build({})).raw_data as {
      contract: { parameter: { value: { new_contract: Record<string, unknown> } } }[]
    }
    const newContract = defaulted.contract[0].parameter.value.new_contract
    assert.strictEqual(newContract.consume_user_resource_percent, undefined)
    assert.strictEqual(newContract.origin_energy_limit, undefined)
  })

  it('a read-only call reaches the VM through triggersmartcontract', async () => {
    const trigger = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>

    const contractBase58 = TronWeb.address.fromHex(deployedAddress) as string
    // `inc` is nonpayable, so the call comes back as a transaction to sign
    const write = await trigger('wallet/triggersmartcontract', {
      owner_address: ownerBase58,
      contract_address: contractBase58,
      function_selector: 'inc()',
      fee_limit: 100_000_000,
      visible: true,
    })
    assert.isDefined(write.transaction, JSON.stringify(write))
    assert.isUndefined(write.constant_result)

    // a contract that was never deployed is named as such
    assert.deepEqual(
      await trigger('wallet/triggersmartcontract', {
        owner_address: ownerBase58,
        contract_address: utils.accounts.generateAccount().address.base58,
        function_selector: 'inc()',
        visible: true,
      }),
      {
        result: {
          code: 'CONTRACT_VALIDATE_ERROR',
          message: 'No contract or not a valid smart contract',
        },
      },
    )

    // the parameter screen runs before anything is parsed
    const missing = (await trigger('wallet/triggersmartcontract', {
      contract_address: deployedAddress,
      visible: true,
    })) as { result: { code: string; message: string } }
    assert.strictEqual(missing.result.code, 'OTHER_ERROR')
    assert.strictEqual(missing.result.message, "owner_address isn't set.")
  })

  it('serves a call the ABI marks read-only instead of handing back a transaction', async () => {
    const viewAbi = [
      {
        inputs: [],
        name: 'total',
        outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
      },
    ]
    const unsigned = await tronWeb.transactionBuilder.createSmartContract(
      { abi: viewAbi, bytecode: INC_INITCODE, feeLimit: 100_000_000 },
      ownerBase58,
    )
    const signed = await tronWeb.trx.sign(unsigned)
    assert.isTrue((await tronWeb.trx.sendRawTransaction(signed)).result)
    const info = (await tronWeb.trx.getTransactionInfo(signed.txID)) as {
      contract_address: string
    }

    const served = (await (
      await fetch(`${baseUrl}/wallet/triggersmartcontract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_address: TronWeb.address.toHex(ownerBase58),
          contract_address: info.contract_address,
          function_selector: 'total()',
        }),
      })
    ).json()) as { constant_result?: string[]; energy_used?: number }
    assert.isDefined(served.constant_result, JSON.stringify(served))
    assert.strictEqual(served.energy_used, 20_078)
  })

  it('an empty contract_address simulates the deployment instead', async () => {
    const simulated = (await (
      await fetch(`${baseUrl}/wallet/triggerconstantcontract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_address: ownerBase58,
          visible: true,
          data: INC_INITCODE,
        }),
      })
    ).json()) as {
      constant_result?: string[]
      transaction?: { raw_data: { contract: { type: string }[] } }
      result?: { result: boolean }
    }
    assert.strictEqual(simulated.result?.result, true)
    // the returned data is the runtime code the constructor would install
    assert.strictEqual(simulated.constant_result?.[0], INC_RUNTIME)
    assert.strictEqual(simulated.transaction?.raw_data.contract[0].type, 'CreateSmartContract')

    // without either an address or init code there is nothing to run
    const empty = (await (
      await fetch(`${baseUrl}/wallet/triggerconstantcontract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_address: ownerBase58, visible: true }),
      })
    ).json()) as { result: { code: string; message: string } }
    // `Return.message` is a name field, so under visible it arrives as text
    assert.strictEqual(
      empty.result.message,
      'At least one of contract_address and' + ' data must be set.',
    )
  })

  it('keys a broadcast on the id it derives, not the one the request states', async () => {
    const to = utils.accounts.generateAccount().address.base58
    const send = async (body: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>
    const lookUp = async (value: string): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/gettransactionbyid`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value }),
        })
      ).json()) as Record<string, unknown>

    const signed = (await tronWeb.trx.sign(
      (await tronWeb.transactionBuilder.sendTrx(to, 12_345, ownerBase58)) as never,
    )) as unknown as Record<string, unknown>
    const derived = String(signed.txID)

    assert.isTrue((await send(signed)).result)
    assert.strictEqual(await tronWeb.trx.getBalance(to), 12_345)

    // the top-level id is not part of what was signed, so stating a different
    // one names the same transaction — it must not buy a second execution
    assert.strictEqual(
      (await send({ ...signed, txID: 'f'.repeat(64) })).code,
      'DUP_TRANSACTION_ERROR',
    )
    assert.strictEqual(await tronWeb.trx.getBalance(to), 12_345)

    assert.isString((await lookUp(derived)).txID)
    assert.deepEqual(await lookUp('f'.repeat(64)), {})
  })

  it('counts every fee it takes into the chain-wide burned total', async () => {
    // two independent chains burn different totals, so the figure itself is not
    // comparable — what has to hold is that the counter moves by the fee the
    // receipt reports, whichever resource paid it
    const burned = async (): Promise<number> =>
      Number(
        (
          (await (await fetch(`${baseUrl}/wallet/getburntrx`)).json()) as {
            burnTrxAmount?: number
          }
        ).burnTrxAmount ?? 0,
      )
    const to = utils.accounts.generateAccount().address.base58

    const feeOf = async (built: unknown): Promise<number> => {
      const sent = (await tronWeb.trx.sendRawTransaction(
        await tronWeb.trx.sign(built as never),
      )) as { txid?: string }
      const info = (await (
        await fetch(`${baseUrl}/wallet/gettransactioninfobyid`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: sent.txid }),
        })
      ).json()) as { fee?: number }
      return info.fee ?? 0
    }

    // bandwidth pays for this one
    const beforeTransfer = await burned()
    const transferFee = await feeOf(
      await tronWeb.transactionBuilder.sendTrx(to, 1_000, ownerBase58),
    )
    assert.strictEqual((await burned()) - beforeTransfer, transferFee)

    // and energy for this one — a different resource down a different path
    const beforeDeploy = await burned()
    const deployFee = await feeOf(
      await tronWeb.transactionBuilder.createSmartContract(
        {
          abi: INC_ABI as never,
          bytecode: INC_INITCODE,
          feeLimit: 1_000_000_000,
          callValue: 0,
          userFeePercentage: 100,
          originEnergyLimit: 10_000_000,
          name: 'Burned',
        },
        ownerBase58,
      ),
    )
    assert.isAbove(deployFee, 0)
    assert.strictEqual((await burned()) - beforeDeploy, deployFee)
  })

  it('leaves no trace when the work after execution faults', async () => {
    // Execution, billing, the block, the receipt and every index are one write.
    // Whatever faults in there, the chain must read exactly as it did before —
    // and the transaction, never having reached a block, must still be sendable.
    const send = async (signed: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(signed),
        })
      ).json()) as Record<string, unknown>

    const faults: [string, () => () => void][] = [
      [
        'sealBlock',
        () => {
          const original = nodeCore(node).sealBlock.bind(nodeCore(node))
          nodeCore(node).sealBlock = async () => {
            throw new Error('seal store is down')
          }
          return () => {
            nodeCore(node).sealBlock = original
          }
        },
      ],
      [
        'blocks.put',
        () => {
          const original = nodeCore(node).blocks.put.bind(nodeCore(node).blocks)
          nodeCore(node).blocks.put = () => {
            throw new Error('block store is down')
          }
          return () => {
            nodeCore(node).blocks.put = original
          }
        },
      ],
      [
        'blocks.put after writing',
        () => {
          const original = nodeCore(node).blocks.put.bind(nodeCore(node).blocks)
          nodeCore(node).blocks.put = (block, txs, timestampMs) => {
            original(block, txs, timestampMs)
            throw new Error('block store faulted after writing')
          }
          return () => {
            nodeCore(node).blocks.put = original
          }
        },
      ],
      [
        'registerContract',
        () => {
          const original = nodeCore(node).registerContract.bind(nodeCore(node))
          nodeCore(node).registerContract = () => {
            throw new Error('contract registry is down')
          }
          return () => {
            nodeCore(node).registerContract = original
          }
        },
      ],
    ]

    for (const [label, inject] of faults) {
      // the contract registry is only reached by a deploy
      const built =
        label === 'registerContract'
          ? await tronWeb.transactionBuilder.createSmartContract(
              {
                abi: INC_ABI as never,
                bytecode: INC_INITCODE,
                feeLimit: 1_000_000_000,
                callValue: 0,
                name: `Atomic${label.length}`,
              },
              ownerBase58,
            )
          : await tronWeb.transactionBuilder.sendTrx(
              utils.accounts.generateAccount().address.base58,
              12_345,
              ownerBase58,
            )
      const signed = (await tronWeb.trx.sign(built as never)) as unknown as Record<string, unknown>

      const before = await probeState(node)
      const restore = inject()
      const failed = await send(signed)
      restore()

      assert.isString(failed.Error, label)
      assert.deepEqual(await probeState(node), before, label)

      // the same signed transaction still buys exactly one execution
      const retried = await send(signed)
      assert.isTrue(retried.result, `${label}: ${JSON.stringify(retried)}`)
      assert.notDeepEqual(await probeState(node), before, label)
      const again = await send(signed)
      assert.strictEqual(again.code, 'DUP_TRANSACTION_ERROR', label)
    }
  })

  it('takes a contract setting back when the work after the actuator faults', async () => {
    // the three metadata actuators write into the contract registry rather than
    // the trie, so the whole-state probe is what proves the write unwound
    const send = async (signed: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(signed),
        })
      ).json()) as Record<string, unknown>

    const builds: [string, () => Promise<unknown>][] = [
      [
        'updatesetting',
        () => tronWeb.transactionBuilder.updateSetting(deployedAddress, 7, ownerBase58),
      ],
      [
        'updateenergylimit',
        () => tronWeb.transactionBuilder.updateEnergyLimit(deployedAddress, 12_345, ownerBase58),
      ],
      ['clearabi', () => tronWeb.transactionBuilder.clearABI(deployedAddress, ownerBase58)],
    ]

    for (const [label, build] of builds) {
      const signed = await tronWeb.trx.sign((await build()) as never)
      const before = await probeState(node)
      const original = nodeCore(node).sealBlock.bind(nodeCore(node))
      nodeCore(node).sealBlock = async () => {
        throw new Error('seal store is down')
      }
      const failed = await send(signed as unknown as Record<string, unknown>)
      nodeCore(node).sealBlock = original

      assert.isString(failed.Error, label)
      assert.deepEqual(await probeState(node), before, label)
    }
  })

  it('a read issued against a write in flight answers from one whole chain', async () => {
    const recipient = utils.accounts.generateAccount().address.base58
    const signed = await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.sendTrx(recipient, 54_321, ownerBase58),
    )
    const heightBefore = nodeCore(node).blocks.height()

    // stall the write between execution and the seal — the point where the
    // moved balance and the claimed txid exist but the block does not
    const originalSeal = nodeCore(node).sealBlock.bind(nodeCore(node))
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached = () => {}
    const reachedSeal = new Promise<void>((resolve) => {
      reached = resolve
    })
    nodeCore(node).sealBlock = async (txs) => {
      reached()
      await gate
      return originalSeal(txs)
    }

    // provider.request enqueues synchronously, so these are issued while the
    // write still sits between execution and its seal
    const request = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      provider.request({ method, params: params as never })

    try {
      const write = request('wallet/broadcasttransaction', signed as never)
      await reachedSeal
      // issued mid-write: balance, head block and tx index must answer as one
      // chain — all from before the write or all from after it
      const reads = Promise.all([
        request('wallet/getaccount', { address: TronWeb.address.toHex(recipient) }),
        request('wallet/getnowblock', {}),
        request('wallet/gettransactionbyid', { value: (signed as { txID: string }).txID }),
      ])
      release()
      const [account, head, txById] = (await reads) as Record<string, unknown>[]
      assert.isTrue(((await write) as { result?: boolean }).result)
      assert.strictEqual(Number(account.balance), 54_321)
      const headNumber = (head as { block_header?: { raw_data?: { number?: unknown } } })
        .block_header?.raw_data?.number
      assert.strictEqual(BigInt(String(headNumber ?? 0)), heightBefore + 1n)
      assert.strictEqual((txById as { txID?: string }).txID, (signed as { txID: string }).txID)
    } finally {
      nodeCore(node).sealBlock = originalSeal
      release()
    }
  })

  it('a repeated call prices its slots like an independent replay', async () => {
    const callInc = async (): Promise<number> => {
      const built = (await tronWeb.transactionBuilder.triggerSmartContract(
        deployedAddress,
        'inc()',
        { feeLimit: 100_000_000 },
        [],
        TronWeb.address.toHex(ownerBase58),
      )) as unknown as { transaction: Record<string, unknown> }
      const signed = await tronWeb.trx.sign(built.transaction as never)
      await tronWeb.trx.sendRawTransaction(signed)
      const info = (await tronWeb.trx.getTransactionInfo((signed as { txID: string }).txID)) as {
        receipt?: { energy_usage_total?: number }
      }
      return info.receipt?.energy_usage_total ?? 0
    }
    // identical transactions touching the same slot: access warmth must not
    // leak from one execution into the next
    const first = await callInc()
    const second = await callInc()
    assert.isAbove(first, 0)
    assert.strictEqual(second, first)
  })

  it("the origin's stake subsidises callers by the contract's split", async () => {
    // the origin stakes for energy, then publishes a contract whose callers
    // pay nothing (percent 0) up to a stated per-call allowance
    await tronWeb.trx.sendRawTransaction(
      await tronWeb.trx.sign(
        await tronWeb.transactionBuilder.freezeBalanceV2(2_000_000_000, 'ENERGY', ownerBase58),
      ),
    )
    const deploy = await tronWeb.transactionBuilder.createSmartContract(
      {
        abi: INC_ABI,
        bytecode: INC_INITCODE,
        feeLimit: 1_000_000_000,
        callValue: 0,
        name: 'IncSubsidised',
        userFeePercentage: 0,
        originEnergyLimit: 1_000_000,
      },
      ownerBase58,
    )
    await tronWeb.trx.sendRawTransaction(await tronWeb.trx.sign(deploy))
    const subsidised = (deploy as { contract_address?: string }).contract_address as string

    const callerKey = accountsFromMnemonic(config.mnemonic)[1].privateKey
    const callerBase58 = TronWeb.address.fromPrivateKey(callerKey) as string
    const callerWeb = new TronWeb({ fullHost: baseUrl, privateKey: callerKey })
    const built = (await callerWeb.transactionBuilder.triggerSmartContract(
      subsidised,
      'inc()',
      { feeLimit: 100_000_000 },
      [],
      TronWeb.address.toHex(callerBase58),
    )) as unknown as { transaction: Record<string, unknown> }
    const signed = await callerWeb.trx.sign(built.transaction as never)
    await callerWeb.trx.sendRawTransaction(signed)
    const info = (await callerWeb.trx.getTransactionInfo((signed as { txID: string }).txID)) as {
      receipt?: {
        energy_usage?: number
        energy_fee?: number
        origin_energy_usage?: number
        energy_usage_total?: number
      }
    }
    // percent 0: the origin's stake carries the whole bill, and the caller
    // neither draws stake nor burns TRX
    assert.isAbove(info.receipt?.origin_energy_usage ?? 0, 0)
    assert.strictEqual(info.receipt?.origin_energy_usage, info.receipt?.energy_usage_total)
    assert.isUndefined(info.receipt?.energy_usage)
    assert.isUndefined(info.receipt?.energy_fee)
  })

  it('contracts born inside a call carry their own record', async () => {
    const factoryCreate = utils.accounts.generateAccount().address.base58
    const factoryCreate2 = utils.accounts.generateAccount().address.base58
    // runtime bytes: push value/offset/size (and a salt for the second) and
    // create an empty-code child
    await nodeCore(node).setCode(parseTronAddress(factoryCreate), hexToBytes('0x600060006000f000'))
    await nodeCore(node).setCode(
      parseTronAddress(factoryCreate2),
      hexToBytes('0x6007600060006000f500'),
    )

    const run = async (target: string): Promise<{ txID: string; child: string }> => {
      const built = (await (
        await fetch(`${baseUrl}/wallet/triggersmartcontract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner_address: ownerBase58,
            contract_address: target,
            fee_limit: 100_000_000,
            visible: true,
          }),
        })
      ).json()) as { transaction?: Record<string, unknown> }
      const signed = utils.crypto.signTransaction(
        accountsFromMnemonic(config.mnemonic)[0].privateKey,
        built.transaction as never,
      ) as unknown as { txID: string }
      const reply = (await (
        await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(signed),
        })
      ).json()) as { result?: boolean }
      assert.isTrue(reply.result)
      const info = (await (
        await fetch(`${baseUrl}/wallet/gettransactioninfobyid`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: signed.txID }),
        })
      ).json()) as { internal_transactions?: { transferTo_address?: string }[] }
      const child = info.internal_transactions?.[0]?.transferTo_address as string
      assert.isString(child)
      return { txID: signed.txID, child }
    }

    const getContract = async (address: string): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/getcontract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: address }),
        })
      ).json()) as Record<string, unknown>

    const born = await run(factoryCreate)
    assert.strictEqual(
      born.child,
      `41${utils.ethersUtils.keccak256(`0x${born.txID}${'00'.repeat(8)}`).slice(-40)}`,
    )
    const child = await getContract(born.child)
    // the record names the creating contract as origin and bills the caller
    assert.strictEqual(child.origin_address, TronWeb.address.toHex(factoryCreate))
    assert.strictEqual(child.consume_user_resource_percent, 100)
    assert.isUndefined(child.trx_hash)

    const born2 = await run(factoryCreate2)
    const create2Hash = utils.ethersUtils.keccak256(
      `0x${TronWeb.address.toHex(factoryCreate2)}${'7'.padStart(64, '0')}${utils.ethersUtils.keccak256('0x').slice(2)}`,
    )
    assert.strictEqual(born2.child, `41${create2Hash.slice(-40)}`)
    const child2 = await getContract(born2.child)
    // a salted create additionally carries the root transaction id
    assert.strictEqual(child2.trx_hash, born2.txID)
  })
})
