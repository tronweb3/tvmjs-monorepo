import { rejects } from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { TronWeb, utils } from 'tronweb'
import { assert, describe, it, vi } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { TronNode, TronProvider, startHttpServer } from '../../src/index.ts'
import type {
  BroadcastResult,
  ClientConfig,
  ContractCallResult,
  StorageRange,
  TransactionInfo,
  TransactionTrace,
  TronAccount,
  TronBlock,
  TronTransaction,
} from '../../src/index.ts'
import { probeState } from '../stateProbe.ts'

const COUNTER = '6000546001018060005560005260206000f3'
const CONDITIONAL = `3615600f57606360005560006000fd5b${COUNTER}`
const init = (runtime: string) =>
  `60${(runtime.length / 2).toString(16).padStart(2, '0')}80600b6000396000f3${runtime}`
type Transport = 'provider' | 'http'
type Mode = 'instant' | 'manual' | 'interval' | 'drain'

async function fixture(transport: Transport, config: ClientConfig = {}) {
  const node = await TronNode.create(config)
  const provider = new TronProvider(node)
  const core = nodeCore(node)
  const started = transport === 'http' ? await startHttpServer(provider, { port: 0 }) : undefined
  const keys = (await node.admin.accounts()).privateKeys
  const addresses = keys.map((key) =>
    TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string),
  )
  async function request<T>(method: string, params: object = {}): Promise<T> {
    if (started === undefined) return (await provider.request({ method, params })) as T
    const rpc = /^(tre_|debug_)/.test(method)
    const response = await fetch(`${started.url}/${rpc ? 'tre' : method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpc ? { jsonrpc: '2.0', id: 1, method, params } : params),
      signal: AbortSignal.timeout(10_000),
    })
    assert.isTrue(response.ok)
    const body = await response.json()
    if (rpc && body.error !== undefined) throw new Error(body.error.message)
    return (rpc ? body.result : body) as T
  }
  const mode = (seconds: number) => request('tre_blockTime', [seconds])
  const mine = () => request('tre_mine', [])
  const info = (tx: TronTransaction) =>
    request<TransactionInfo>('wallet/gettransactioninfobyid', { value: tx.txID })
  const balance = async (index: number) =>
    BigInt(
      (await request<TronAccount>('wallet/getaccount', { address: addresses[index] })).balance ?? 0,
    )
  const sign = (tx: TronTransaction, index = 0) => {
    const pb = utils.transaction.txJsonToPb(tx)
    tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '')
    tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).replace(/^0x/, '')
    const contract = tx.raw_data.contract[0]
    if (contract.type === 'CreateSmartContract') {
      tx.contract_address = `41${utils.ethersUtils.keccak256(`0x${tx.txID}${contract.parameter.value.owner_address}`).slice(-40)}`
    }
    tx.signature = []
    return { ...tx, signature: utils.crypto.signTransaction(keys[index], tx).signature }
  }
  let sequence = 0
  const build = async (method: string, params: object, index = 0) => {
    const reply = await request<TronTransaction & { transaction?: TronTransaction }>(method, {
      owner_address: addresses[index],
      ...params,
    })
    const tx = reply.transaction ?? reply
    assert.isString(tx.txID, `Builder ${method} must succeed`)
    tx.raw_data.timestamp += ++sequence
    return sign(tx, index)
  }
  const deploy = (runtime = COUNTER, extra: object = {}) =>
    build('wallet/deploycontract', {
      bytecode: init(runtime),
      consume_user_resource_percent: 100,
      origin_energy_limit: 1_000_000,
      fee_limit: 100_000_000,
      ...extra,
    })
  const call = (address: string, data = '', extra: object = {}) =>
    build('wallet/triggersmartcontract', {
      contract_address: address,
      data,
      fee_limit: 100_000_000,
      ...extra,
    })
  const transfer = (amount: number, index = 0, recipient = 1) =>
    build('wallet/createtransaction', { to_address: addresses[recipient], amount }, index)
  const send = async (tx: TronTransaction) => {
    const reply = await request<BroadcastResult>('wallet/broadcasttransaction', tx)
    assert.isTrue(reply.result, 'Valid transaction must be admitted')
  }
  const trace = (tx: TronTransaction) =>
    request<TransactionTrace>('debug_traceTransaction', [`0x${tx.txID}`])
  const storage = (address: string) =>
    request<StorageRange>('debug_storageRangeAt', ['latest', 0, address, null, 100])
  async function settle(selected: Mode, txs: TronTransaction[]) {
    if (selected === 'manual') await mine()
    if (selected === 'drain') await mode(0)
    if (selected === 'interval') {
      await mode(1)
      const deadline = Date.now() + 10_000
      while ((await info(txs[txs.length - 1])).id === undefined && Date.now() < deadline)
        await delay(25)
      assert.isString((await info(txs[txs.length - 1])).id, 'Real timer must commit the queue')
      await mode(60)
    }
    const receipts = await Promise.all(txs.map(info))
    assert.deepEqual(
      receipts.map((receipt) => receipt.id),
      txs.map((tx) => tx.txID),
    )
    const heights = receipts.map((receipt) => receipt.blockNumber!)
    if (selected === 'manual' || selected === 'interval')
      assert.strictEqual(new Set(heights).size, 1)
    else
      assert.deepEqual(
        heights,
        heights.map((_, index) => heights[0] + index),
      )
    for (const height of new Set(heights)) {
      const block = await request<TronBlock>('wallet/getblockbynum', { num: height })
      assert.deepEqual(
        block.transactions.map((tx) => tx.txID),
        txs.filter((_, index) => heights[index] === height).map((tx) => tx.txID),
      )
      const solid = await request<TransactionInfo[]>(
        'walletsolidity/gettransactioninfobyblocknum',
        { num: height },
      )
      assert.deepEqual(
        solid.map((receipt) => receipt.id),
        block.transactions.map((tx) => tx.txID),
      )
    }
    assert.deepEqual(await request('wallet/getpendingsize'), { pendingSize: 0 })
    return receipts
  }
  async function close() {
    try {
      await node.tre.blockTime(0)
    } finally {
      if (started !== undefined)
        await new Promise<void>((resolve, reject) =>
          started.server.close((error) => (error ? reject(error) : resolve())),
        )
    }
  }
  return {
    node,
    core,
    provider,
    addresses,
    request,
    mode,
    mine,
    info,
    balance,
    sign,
    build,
    deploy,
    call,
    transfer,
    send,
    trace,
    storage,
    settle,
    close,
  }
}

for (const transport of ['provider', 'http'] as const) {
  describe(`host rollback acceptance via ${transport}`, () => {
    for (const stage of ['vm-before', 'vm-after', 'storage-after', 'deploy-code-after'] as const) {
      it(`${stage}: restores state, preserves pending, and retries exactly once`, async () => {
        const f = await fixture(transport)
        let restore = () => {}
        try {
          const deployed = await f.deploy()
          await f.send(deployed)
          await f.mode(60)
          const tx =
            stage === 'deploy-code-after'
              ? await f.deploy('6000')
              : await f.call(deployed.contract_address!)
          await f.send(tx)
          const before = await probeState(f.node)
          const balanceBefore = await f.balance(0)
          const storageBefore = await f.storage(deployed.contract_address!)
          const pendingBefore = await f.request('wallet/gettransactionlistfrompending')
          let triggered = false
          const fail = () => {
            triggered = true
            throw new Error(`host fault ${stage}`)
          }
          if (stage === 'vm-before' || stage === 'vm-after') {
            const original = f.core.vm.tvm.runCall
            const spy = vi
              .spyOn(f.core.vm.tvm, 'runCall')
              .mockImplementationOnce(async (...args) => {
                if (stage === 'vm-after') await original.apply(f.core.vm.tvm, args)
                return fail()
              })
            restore = () => spy.mockRestore()
          } else if (stage === 'storage-after') {
            const original = f.core.stateManager.putStorage
            const spy = vi
              .spyOn(f.core.stateManager, 'putStorage')
              .mockImplementationOnce(async (...args) => {
                await original.apply(f.core.stateManager, args)
                fail()
              })
            restore = () => spy.mockRestore()
          } else {
            const original = f.core.vm.shallowCopy
            const spy = vi.spyOn(f.core.vm, 'shallowCopy').mockImplementation(async (...args) => {
              const copy = await original.apply(f.core.vm, args)
              const putCode = copy.stateManager.putCode
              copy.stateManager.putCode = async (...values) => {
                await putCode.apply(copy.stateManager, values)
                if (!triggered) fail()
              }
              return copy
            })
            restore = () => spy.mockRestore()
          }
          await rejects(f.mine(), /host fault/)
          restore()
          assert.isTrue(triggered)
          assert.deepEqual(await probeState(f.node), before)
          assert.deepEqual(await f.storage(deployed.contract_address!), storageBefore)
          assert.deepEqual(await f.request('wallet/gettransactionlistfrompending'), pendingBefore)
          assert.deepEqual(await f.info(tx), {})
          assert.deepEqual(await f.request('wallet/gettransactionbyid', { value: tx.txID }), {})
          await rejects(f.trace(tx), /not found/)
          const receipts = await f.settle('manual', [tx])
          assert.strictEqual(receipts[0].receipt?.result, 'SUCCESS')
          assert.strictEqual(await f.balance(0), balanceBefore - BigInt(receipts[0].fee ?? 0))
          assert.isFalse((await f.trace(tx)).failed)
          assert.strictEqual(
            f.core.blocks
              .range(0n, f.core.head().number + 1n)
              .flatMap((block) => block.txs)
              .filter((record) => record.txid === tx.txID).length,
            1,
          )
          assert.strictEqual(
            (await f.request<{ code?: string }>('wallet/broadcasttransaction', tx)).code,
            'DUP_TRANSACTION_ERROR',
          )
        } finally {
          restore()
          await f.close()
        }
      })
    }
  })
  for (const selected of ['instant', 'manual', 'interval', 'drain'] as const) {
    describe(`business sequences via ${transport}, ${selected}`, () => {
      for (const scene of [
        'fund-spend',
        'deploy-call',
        'stake-use',
        'success-revert-success',
      ] as const) {
        it(scene, async () => {
          const f = await fixture(transport)
          try {
            let contract: TronTransaction | undefined
            if (scene === 'stake-use' || scene === 'success-revert-success') {
              contract = await f.deploy(scene === 'success-revert-success' ? CONDITIONAL : COUNTER)
              await f.send(contract)
            }
            if (scene === 'fund-spend')
              await f.request('tre_setAccountBalance', [f.addresses[1], 0])
            if (selected !== 'instant') await f.mode(60)
            const before = await Promise.all([0, 1, 2].map(f.balance))
            const canonical = await probeState(f.node)
            const txs: TronTransaction[] = []
            if (scene === 'fund-spend') {
              const first = await f.transfer(10_000_000)
              await f.send(first)
              txs.push(first)
              const second = await f.transfer(9_000_000, 0, 2)
              const payload = second.raw_data.contract[0]
              if (payload.type !== 'TransferContract') throw new Error('Expected transfer')
              payload.parameter.value.owner_address = f.addresses[1]
              const signed = f.sign(second, 1)
              await f.send(signed)
              txs.push(signed)
            } else if (scene === 'deploy-call') {
              contract = await f.deploy()
              await f.send(contract)
              txs.push(contract)
              // Build a valid envelope, then sign a call depending on the pending deployment.
              const template = await f.transfer(1)
              template.raw_data.fee_limit = 100_000_000
              template.raw_data.contract = [
                {
                  type: 'TriggerSmartContract',
                  parameter: {
                    type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
                    value: {
                      owner_address: f.addresses[0],
                      contract_address: contract.contract_address,
                    },
                  },
                },
              ]
              const signed = f.sign(template)
              await f.send(signed)
              txs.push(signed)
            } else if (scene === 'stake-use') {
              const stake = await f.build('wallet/freezebalancev2', {
                frozen_balance: 1_000_000_000,
                resource: 'ENERGY',
              })
              await f.send(stake)
              txs.push(stake)
              const call = await f.call(contract!.contract_address!)
              await f.send(call)
              txs.push(call)
            } else {
              for (const data of ['', '01', '']) {
                const call = await f.call(contract!.contract_address!, data)
                await f.send(call)
                txs.push(call)
              }
            }
            if (selected !== 'instant') {
              assert.deepEqual(
                await probeState(f.node),
                canonical,
                'Pending admission cannot change canonical ledger',
              )
              for (const tx of txs) assert.deepEqual(await f.info(tx), {})
              assert.deepEqual(await f.request('wallet/getpendingsize'), {
                pendingSize: txs.length,
              })
            }
            const receipts = await f.settle(selected, txs)
            if (scene === 'stake-use') await rejects(f.trace(txs[0]), /did not execute in the VM/)
            const traced = scene === 'stake-use' ? txs.slice(1) : txs
            const traces = await Promise.all(traced.map(f.trace))
            assert.deepEqual(
              traces.map((trace) => trace.failed),
              scene === 'success-revert-success' ? [false, true, false] : traced.map(() => false),
            )
            if (scene === 'fund-spend') {
              assert.strictEqual(
                await f.balance(0),
                before[0] - 10_000_000n - BigInt(receipts[0].fee ?? 0),
              )
              assert.strictEqual(await f.balance(1), 1_000_000n - BigInt(receipts[1].fee ?? 0))
              assert.strictEqual(await f.balance(2), before[2] + 9_000_000n)
            } else {
              const principal = scene === 'stake-use' ? 1_000_000_000n : 0n
              assert.strictEqual(
                await f.balance(0),
                before[0] -
                  principal -
                  receipts.reduce((sum, row) => sum + BigInt(row.fee ?? 0), 0n),
              )
              const last = receipts[receipts.length - 1]
              const count = scene === 'success-revert-success' ? 2n : 1n
              assert.strictEqual(BigInt(`0x${last.contractResult![0]}`), count)
              assert.strictEqual(BigInt(`0x${traces[traces.length - 1].returnValue}`), count)
              assert.strictEqual(
                Object.keys((await f.storage(contract!.contract_address!)).storage).length,
                1,
              )
              const snapshot = await probeState(f.node)
              const constant = await f.request<ContractCallResult>(
                'wallet/triggerconstantcontract',
                { owner_address: f.addresses[0], contract_address: contract!.contract_address },
              )
              assert.strictEqual(BigInt(`0x${constant.constant_result![0]}`), count + 1n)
              assert.deepEqual(await probeState(f.node), snapshot)
              if (scene === 'stake-use') {
                assert.isAbove(Number(last.receipt?.energy_usage), 0)
                assert.strictEqual(BigInt(last.receipt?.energy_fee ?? 0), 0n)
              }
              if (scene === 'success-revert-success')
                assert.deepEqual(
                  receipts.map((row) => row.receipt?.result),
                  ['SUCCESS', 'REVERT', 'SUCCESS'],
                )
            }
          } finally {
            await f.close()
          }
        }, 20_000)
      }
    })
  }
}

for (const transport of ['provider', 'http'] as const) {
  describe(`creation rules through public APIs via ${transport}`, () => {
    for (const kind of ['valid', 'invalid-prefix', 'deposit-out-of-energy'] as const) {
      it(`${kind}: broadcast, constant, estimate and historical trace agree`, async () => {
        const low = kind === 'deposit-out-of-energy'
        const f = await fixture(
          transport,
          low
            ? {
                runtime: { maxEnergyLimitForConstant: 100n },
                chainParameters: { maxFeeLimit: 10_000 },
              }
            : {},
        )
        try {
          const bytecode =
            kind === 'invalid-prefix' ? '60ef60005360016000f3' : '600060005360016000f3'
          const before = await probeState(f.node)
          for (const prefix of ['wallet', 'walletsolidity']) {
            for (const route of ['triggerconstantcontract', 'estimateenergy']) {
              const reply = await f.request<ContractCallResult>(`${prefix}/${route}`, {
                owner_address: f.addresses[0],
                data: bytecode,
              })
              assert.strictEqual(reply.result?.result === true, kind === 'valid')
              if (kind === 'valid') {
                if (route === 'triggerconstantcontract')
                  assert.deepEqual(reply.constant_result, ['00'])
                else assert.isAbove(reply.energy_required!, 0)
              } else {
                const message = TronWeb.toUtf8(reply.result!.message!)
                assert.match(message, kind === 'invalid-prefix' ? /invalid bytecode/ : /out of gas/)
              }
              assert.deepEqual(
                await probeState(f.node),
                before,
                'Simulation must not publish any state',
              )
            }
          }
          const ownerBefore = await f.balance(0)
          const tx = await f.deploy('00', { bytecode, fee_limit: low ? 10_000 : 100_000_000 })
          await f.send(tx)
          const receipt = await f.info(tx)
          const trace = await f.trace(tx)
          assert.strictEqual(
            receipt.receipt?.result,
            kind === 'valid' ? 'SUCCESS' : low ? 'OUT_OF_ENERGY' : 'INVALID_CODE',
          )
          assert.strictEqual(trace.failed, kind !== 'valid')
          assert.strictEqual(BigInt(trace.gas), BigInt(receipt.receipt!.energy_usage_total!))
          assert.strictEqual(await f.balance(0), ownerBefore - BigInt(receipt.fee ?? 0))
          const code = await f.request<{ runtimecode?: string }>('wallet/getcontractinfo', {
            value: tx.contract_address,
          })
          if (kind === 'valid') assert.strictEqual(code.runtimecode, '00')
          else {
            assert.isUndefined(code.runtimecode)
            assert.deepEqual(
              await f.request('wallet/getaccount', { address: tx.contract_address }),
              {},
            )
            assert.isUndefined(receipt.log)
            assert.strictEqual(receipt.result, 'FAILED')
          }
        } finally {
          await f.close()
        }
      })
    }
    for (const invalid of [false, true]) {
      it(`internal CREATE ${invalid ? 'rejects 0xef' : 'stores valid code'} across simulation and execution`, async () => {
        const f = await fixture(transport)
        try {
          const child = invalid ? '60ef60005360016000f3' : '600060005360016000f3'
          const size = (child.length / 2).toString(16).padStart(2, '0')
          const factory = `60${size}601660003960${size}60006000f060005260206000f3${child}`
          const deployed = await f.deploy(factory)
          await f.send(deployed)
          const before = await probeState(f.node)
          for (const prefix of ['wallet', 'walletsolidity']) {
            for (const route of ['triggerconstantcontract', 'estimateenergy']) {
              const reply = await f.request<ContractCallResult>(`${prefix}/${route}`, {
                owner_address: f.addresses[0],
                contract_address: deployed.contract_address,
              })
              assert.strictEqual(reply.result?.result === true, !invalid)
              if (!invalid && route === 'triggerconstantcontract')
                assert.notStrictEqual(BigInt(`0x${reply.constant_result![0]}`), 0n)
              assert.deepEqual(await probeState(f.node), before)
            }
          }
          const tx = await f.call(deployed.contract_address!)
          await f.send(tx)
          const receipt = await f.info(tx)
          const trace = await f.trace(tx)
          assert.strictEqual(receipt.receipt?.result, invalid ? 'OUT_OF_ENERGY' : 'SUCCESS')
          assert.strictEqual(trace.failed, invalid)
          assert.strictEqual(trace.returnValue, receipt.contractResult![0])
          if (!invalid) {
            const address = `41${trace.returnValue.slice(-40)}`
            const stored = await f.request<{ runtimecode?: string }>('wallet/getcontractinfo', {
              value: address,
            })
            assert.strictEqual(stored.runtimecode, '00')
          } else {
            assert.lengthOf(receipt.internal_transactions!, 1)
            const child = receipt.internal_transactions![0]
            assert.isTrue(child.rejected)
            assert.deepEqual(
              await f.request('wallet/getcontractinfo', { value: child.transferTo_address }),
              {},
            )
            assert.deepEqual(
              await f.request('wallet/getaccount', { address: child.transferTo_address }),
              {},
            )
          }
        } finally {
          await f.close()
        }
      })
    }
  })
}
