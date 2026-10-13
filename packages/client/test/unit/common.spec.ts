import { getActivePrecompiles } from '@tvmjs/tvm'
import { TronWeb, utils } from 'tronweb'
import { assert, describe, it } from 'vitest'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

import type { ClientConfig, ParamsDict } from '../../src/config.ts'
import type { TronTransaction } from '../../src/rpc.ts'

/** PUSH1 00 SLOAD PUSH1 00 MSTORE PUSH1 20 PUSH1 00 RETURN */
const ONE_SLOAD = '0x60005460005260206000f3'
// CallP256Verify conformance vector: hash, r, s, public-key x and y.
const P256_INPUT =
  '4cee90eb86eaa050036147a12d49004b6b9c72bd725d39d4785011fe190f0b4d' +
  'a73bd4903f0ce3b639bbbf6e8e80d16931ff4bcf5993d58468e8fb19086e8cac' +
  '36dbcd03009df8c59286b162af3bd7fcc0450c9aa81be5d10d312af6c66b1d60' +
  '4aebd3099c618202fcfe16ae7770b0c49ab5eadf74b754204a3bb6060e44eff37' +
  '618b065f9832de4ca6ca971a7a1adc826d0f7c00181a5fb2ddf79ae00b4e10e'
// Forward calldata to P256VERIFY with 6,900 energy and return its output.
const P256_CALL = '36600060003760006000366000610100611af4fa503d600060003e3d6000f3'

const energyOf = async (params?: ParamsDict): Promise<number> => {
  const config = resolveConfig({ runtime: { common: { params } } })
  const provider = new TronProvider(await TronNode.create(config))
  const owner = TronWeb.address.toHex(
    TronWeb.address.fromPrivateKey(accountsFromMnemonic(config.mnemonic)[0].privateKey) as string,
  )
  const target = utils.accounts.generateAccount().address.base58
  await provider.request({
    method: 'tre_setAccountCode',
    params: [target, ONE_SLOAD],
  })
  const reply = await provider.request({
    method: 'wallet/triggerconstantcontract',
    params: {
      owner_address: owner,
      contract_address: TronWeb.address.toHex(target),
      function_selector: '',
      parameter: '',
    },
  })
  return reply.energy_used ?? -1
}

describe('the VM energy schedule', () => {
  it('accepts equivalent integer forms for the constant-call energy limit', async () => {
    for (const value of [100_000_000n, 100_000_000, '100000000', '0x5f5e100']) {
      const node = await TronNode.create({ runtime: { maxEnergyLimitForConstant: value } })
      const provider = new TronProvider(node)
      const accounts = await node.admin.accounts()
      assert.strictEqual(node.runtime.maxEnergyLimitForConstant, 100_000_000n)
      const [owner, contract] = accounts.privateKeys.map(
        (key) => TronWeb.address.fromPrivateKey(key) as string,
      )
      await node.tre.setAccountCode(contract, '60005460005260206000f3')
      const reply = await provider.request({
        method: 'wallet/triggerconstantcontract',
        params: { owner_address: owner, contract_address: contract },
      })
      assert.isTrue(reply.result?.result)
      assert.strictEqual(reply.energy_used, 66)
    }
  })

  it('uses the fixed TRON SLOAD price without a cold-access surcharge', async () => {
    assert.strictEqual(await energyOf(), 66)
  })

  it('replaces only the entries named, leaving the rest of the bucket alone', async () => {
    const withCustomSload = await energyOf({ tron: { sloadGas: 75 } })
    assert.strictEqual(withCustomSload - (await energyOf()), 25)
  })

  it('leaves the schedule alone when nothing is supplied', async () => {
    assert.strictEqual(await energyOf(), await energyOf({}))
  })

  it('accepts decimal and hexadecimal parameter values', async () => {
    const numeric = await energyOf({ tron: { sloadGas: 17 } })
    for (const value of ['17', '0x11']) {
      assert.strictEqual(await energyOf({ tron: { sloadGas: value } }), numeric)
    }
  })

  it('applies the tron parameter group', async () => {
    const stock = await energyOf()
    assert.strictEqual(await energyOf({ tron: { memoryGas: 10 } }), stock + 7)
  })
})

describe('Common execution rules', () => {
  async function configuredContract(config: ClientConfig, code: string) {
    const node = await TronNode.create(config)
    const provider = new TronProvider(node)
    const accounts = await node.admin.accounts()
    const [owner, target] = accounts.privateKeys.map((key) =>
      TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string),
    )
    await node.tre.setAccountCode(target, code)
    return {
      node,
      provider,
      key: accounts.privateKeys[0],
      params: {
        owner_address: owner,
        contract_address: target,
        data: '00',
        fee_limit: 100_000_000,
      },
    }
  }

  it.each([0, 30])(
    'keeps TRON deployment working with default or empty selections (interval=%s)',
    async (seconds) => {
      for (const common of [undefined, { eips: [], activatedProposals: [] }]) {
        const node = await TronNode.create({ runtime: { common } })
        const provider = new TronProvider(node)
        const { privateKeys } = await node.admin.accounts()
        const owner = TronWeb.address.toHex(
          TronWeb.address.fromPrivateKey(privateKeys[0]) as string,
        )
        await node.tre.blockTime(seconds)
        try {
          const tx = (await provider.request({
            method: 'wallet/deploycontract',
            params: {
              owner_address: owner,
              bytecode: '6001600c60003960016000f300',
              abi: [],
              fee_limit: 100_000_000,
              consume_user_resource_percent: 100,
              origin_energy_limit: 10_000_000,
            },
          })) as TronTransaction
          assert.isString(tx.contract_address)
          const sent = await provider.request({
            method: 'wallet/broadcasttransaction',
            params: utils.crypto.signTransaction(privateKeys[0], tx as never),
          })
          assert.isTrue(sent.result)
          if (seconds > 0) await node.tre.mine()
          const info = await provider.request({
            method: 'wallet/gettransactioninfobyid',
            params: { value: tx.txID },
          })
          assert.strictEqual(info.contract_address, tx.contract_address)
          assert.strictEqual(info.receipt?.result, 'SUCCESS')
          const contract = await provider.request({
            method: 'wallet/getcontractinfo',
            params: { value: tx.contract_address! },
          })
          assert.strictEqual(contract.runtimecode, '00')
          const constant = await provider.request({
            method: 'wallet/triggerconstantcontract',
            params: { owner_address: owner, contract_address: tx.contract_address! },
          })
          assert.isTrue(constant.result?.result)
          const trace = await node.debug.traceTransaction(tx.txID)
          assert.isFalse(trace.failed)
          assert.strictEqual(trace.returnValue, '00')
        } finally {
          await node.tre.blockTime(0)
        }
      }
    },
  )

  it('enables CLZ by default with its five-energy opcode price', async () => {
    const { provider, params } = await configuredContract({}, '6000351e60005260206000f3')
    for (const [input, expected] of [
      [0n, 256n],
      [1n, 255n],
      [8n, 252n],
      [1n << 255n, 0n],
      [(1n << 256n) - 1n, 0n],
    ]) {
      const result = await provider.request({
        method: 'wallet/triggerconstantcontract',
        params: { ...params, data: input.toString(16).padStart(64, '0') },
      })
      assert.isTrue(result.result?.result)
      assert.deepEqual(result.constant_result, [expected.toString(16).padStart(64, '0')])
      assert.strictEqual(result.energy_used, 24)
    }
  })

  it('keeps the unsupported P256 precompile unavailable', async () => {
    const { node, provider, params } = await configuredContract({}, P256_CALL)
    const address = '0000000000000000000000000000000000000100'
    assert.isFalse(getActivePrecompiles(nodeCore(node).common).has(address))
    const result = await provider.request({
      method: 'wallet/triggerconstantcontract',
      params: { ...params, data: P256_INPUT },
    })
    assert.isTrue(result.result?.result)
    assert.deepEqual(result.constant_result, [''])
  })

  it.each([false, true])(
    'selects CLZ independently of its energy price (enabled=%s)',
    async (enabled) => {
      const { provider, params } = await configuredContract(
        {
          runtime: {
            common: {
              eips: enabled ? [7939] : [],
              params: { 7939: { clzGas: 17 } },
            },
          },
        },
        '60011e60005260206000f3',
      )
      const result = await provider.request({ method: 'wallet/triggerconstantcontract', params })
      if (enabled) {
        assert.isTrue(result.result?.result)
        assert.deepEqual(result.constant_result, ['ff'.padStart(64, '0')])
        assert.strictEqual(result.energy_used, 33)
      } else {
        assert.strictEqual(result.result?.code, 'OTHER_ERROR')
        assert.isUndefined(result.constant_result)
      }
    },
  )

  it.each([false, true])(
    'applies proposal 96 to signature precompiles (enabled=%s)',
    async (enabled) => {
      // STATICCALL 0x09 with 96 zero bytes, then return its success flag.
      const { provider, params } = await configuredContract(
        { runtime: { common: { activatedProposals: enabled ? [96] : [] } } },
        '60206000606060006009612710fa60005260206000f3',
      )
      const result = await provider.request({ method: 'wallet/triggerconstantcontract', params })
      assert.isTrue(result.result?.result)
      assert.deepEqual(result.constant_result, [(enabled ? '0' : '1').padStart(64, '0')])
    },
  )

  it.each([0, 30])(
    'retains Common parameters in constant calls, estimation, mining and replay (interval=%s)',
    async (seconds) => {
      const { node, provider, key, params } = await configuredContract(
        { runtime: { common: { params: { 7939: { clzGas: 17 } } } } },
        '60011e60005260206000f3',
      )
      await node.tre.blockTime(seconds)
      try {
        const constant = await provider.request({
          method: 'wallet/triggerconstantcontract',
          params,
        })
        assert.isTrue(constant.result?.result)
        assert.strictEqual(constant.energy_used, 33)
        const estimate = await provider.request({ method: 'wallet/estimateenergy', params })
        assert.isTrue(estimate.result?.result)
        // Estimation returns a sufficient budget, not the exact execution cost.
        assert.strictEqual(estimate.energy_required, 66)
        const built = await provider.request({ method: 'wallet/triggersmartcontract', params })
        assert.isDefined(built.transaction)
        const signed = utils.crypto.signTransaction(key, built.transaction as never)
        const sent = await provider.request({
          method: 'wallet/broadcasttransaction',
          params: signed,
        })
        assert.isTrue(sent.result)
        if (seconds > 0) {
          assert.deepEqual(
            await provider.request({ method: 'wallet/getpendingsize', params: {} }),
            {
              pendingSize: 1,
            },
          )
          await node.tre.mine()
        }
        const info = await provider.request({
          method: 'wallet/gettransactioninfobyid',
          params: { value: built.transaction!.txID },
        })
        const expected = 'ff'.padStart(64, '0')
        assert.deepEqual(info.contractResult, [expected])
        assert.strictEqual(info.receipt?.energy_usage_total, 33n)
        await node.tre.mine(2)
        const trace = await node.debug.traceTransaction(built.transaction!.txID)
        assert.strictEqual(trace.returnValue, expected)
        assert.strictEqual(BigInt(trace.gas), 33n)
        const clz = trace.structLogs.findIndex((step) => step.op === 'CLZ')
        assert.isAtLeast(clz, 0)
        assert.strictEqual(trace.structLogs[clz].gasCost, 17)
        assert.strictEqual(
          BigInt(trace.structLogs[clz].gas) - BigInt(trace.structLogs[clz + 1].gas),
          17n,
        )
      } finally {
        await node.tre.blockTime(0)
      }
    },
  )

  it.each([
    undefined,
    { eips: [7939], activatedProposals: [96] },
    { params: { 7939: { clzGas: 17 } } },
  ])(
    'uses the same Common execution rules through program HTTP and no HTTP (%j)',
    async (common) => {
      const { node, provider, params } = await configuredContract(
        { runtime: { common } },
        '60011e60005260206000f3',
      )
      const started = await startHttpServer(provider, { port: 0 })
      try {
        for (const [code, data, expected] of [
          ['60011e60005260206000f3', '00', 'ff'.padStart(64, '0')],
          ['60206000606060006009612710fa60005260206000f3', '00', '0'.repeat(64)],
          ['6020600060606000600a612710fa60005260206000f3', '00', '0'.repeat(64)],
          [P256_CALL, P256_INPUT, ''],
        ]) {
          await node.tre.setAccountCode(params.contract_address, code)
          const input = { ...params, data }
          const local = await provider.request({
            method: 'wallet/triggerconstantcontract',
            params: input,
          })
          assert.deepEqual(local.constant_result, [expected])
          const response = await fetch(`${started.url}/wallet/triggerconstantcontract`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          })
          assert.strictEqual(response.status, 200)
          const remote = await response.json()
          assert.deepEqual(remote.constant_result, [expected])
          assert.strictEqual(remote.energy_used, local.energy_used)
          if (code === '60011e60005260206000f3') {
            const proposal65 = common?.activatedProposals?.includes(65) ?? true
            assert.strictEqual(local.energy_used, (common?.params ? 32 : 20) + Number(proposal65))
          }
        }
      } finally {
        started.server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          started.server.close((error) => (error === undefined ? resolve() : reject(error))),
        )
      }
    },
  )
})
