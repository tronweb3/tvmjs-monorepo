import { assert, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { HTTP_METHOD } from '../../src/dialect/registry.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider, requestWire } from '../../src/provider.ts'

import type { HandlerParams } from '../../src/dialect/registry.ts'

const BASE58 = 'TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm'
const HEX41 = '4171b0af54e0a1182a5e0947d6a64f3b22740ef318'

let provider: TronProvider

const ask = async (
  method: string,
  fields: Record<string, unknown> = {},
  verb = 'POST',
): Promise<Record<string, unknown>> => {
  const params: HandlerParams = { ...fields, [HTTP_METHOD]: verb }
  return (await requestWire(provider, { method, params })) as Record<string, unknown>
}

beforeAll(async () => {
  provider = new TronProvider(await TronNode.create())
})

describe('reward and brokerage lookups', () => {
  it('answer the chain defaults for an address that parses', async () => {
    assert.deepEqual(await ask('wallet/getReward', { address: HEX41 }), { reward: 0n })
    assert.deepEqual(await ask('wallet/getBrokerage', { address: BASE58 }), { brokerage: 20 })
  })

  it('answer the defaults for no address at all', async () => {
    assert.deepEqual(await ask('wallet/getReward', {}), { reward: 0n })
  })

  it('name where a 41-prefixed value stopped decoding', async () => {
    // an odd digit count runs the decoder off the end of the string
    assert.deepEqual(await ask('wallet/getReward', { address: '41abc' }), {
      Error: 'INVALID address, exception decoding Hex string: String index out of range: 5',
    })
    assert.deepEqual(await ask('wallet/getReward', { address: '41zz' }), {
      Error:
        'INVALID address, exception decoding Hex string: invalid characters encountered in Hex string',
    })
  })

  it('read anything else as base58, and pass what the alphabet allows', async () => {
    // the base58 check only runs on a 34-character value, so a shorter one
    // reaches the lookup and answers the default
    assert.deepEqual(await ask('wallet/getReward', { address: 'not-an-address' }), { reward: 0n })
    const wrong = `${BASE58.slice(0, 33)}0`
    assert.include(
      String((await ask('wallet/getReward', { address: wrong })).Error ?? ''),
      'INVALID address',
    )
  })
})

describe('endpoints that answer an empty message', () => {
  const empty = [
    'wallet/getdelegatedresource',
    'wallet/getdelegatedresourcev2',
    'wallet/listproposals',
    'wallet/listexchanges',
    'wallet/getmarketpairlist',
    'wallet/gettransactionlistfrompending',
  ]

  it('answer {} whatever they are asked', async () => {
    for (const method of empty) {
      assert.deepEqual(await ask(method), {}, method)
    }
  })

  it('keep a handwritten zero on the wire', async () => {
    assert.deepEqual(await ask('wallet/getpendingsize'), { pendingSize: 0 })
    // an int64 travels as a bigint so its digits reach the wire exactly; the
    // printer states it as a JSON number either way
    assert.deepEqual(await ask('wallet/getburntrx'), { burnTrxAmount: 0n })
  })

  it('keeps totaltransaction empty after confirmed transactions', async () => {
    assert.deepEqual(await ask('wallet/totaltransaction'), {})
    const txid = '00'.repeat(32)
    nodeCore(provider.node).txs.set(txid, { txid, transaction: {}, info: {} })
    try {
      assert.deepEqual(await ask('wallet/totaltransaction'), {})
    } finally {
      nodeCore(provider.node).txs.delete(txid)
    }
  })

  it('distinguishes an empty proposal store from malformed proposal requests', async () => {
    assert.deepEqual(await ask('wallet/listproposals'), {})
    assert.deepEqual(await ask('wallet/getproposalbyid', { id: 1 }), {})
    assert.deepEqual(await ask('wallet/getpaginatedproposallist', { offset: 0, limit: 10 }), {})
  })

  it('keeps exchange lookups on their distinct empty-store branches', async () => {
    for (const method of ['wallet/listexchanges', 'walletsolidity/listexchanges']) {
      assert.deepEqual(await ask(method), {})
    }
    for (const method of ['wallet/getexchangebyid', 'walletsolidity/getexchangebyid']) {
      await ask(method, { id: 1 }).then(
        () => assert.fail('a missing exchange must not print a message'),
        (error: Error) => assert.strictEqual(error.message, 'null'),
      )
    }
    assert.deepEqual(await ask('wallet/getpaginatedexchangelist', { offset: 0, limit: 10 }), {})
  })

  it("validates market pairs before observing this chain's empty market stores", async () => {
    const pair = { sell_token_id: '5f', buy_token_id: '31303030303031' }
    const visiblePair = { sell_token_id: '_', buy_token_id: '1000001', visible: true }
    for (const prefix of ['wallet', 'walletsolidity']) {
      assert.deepEqual(await ask(`${prefix}/getmarketpairlist`), {})
      assert.deepEqual(await ask(`${prefix}/getmarketorderbyaccount`, { value: HEX41 }), {})
      assert.deepEqual(await ask(`${prefix}/getmarketorderbyid`, { value: '' }), {})
      await ask(`${prefix}/getmarketorderbyid`, { value: '00'.repeat(32) }).then(
        () => assert.fail('a nonempty absent order must propagate the store miss'),
        (error: Error) => assert.strictEqual(error.message, 'order not found in store'),
      )
      assert.deepEqual(await ask(`${prefix}/getmarketorderlistbypair`, pair), {})
      assert.deepEqual(await ask(`${prefix}/getmarketpricebypair`, pair), pair)
      assert.deepEqual(await ask(`${prefix}/getmarketpricebypair`, visiblePair), {
        sell_token_id: '_',
        buy_token_id: '1000001',
      })
      await ask(`${prefix}/getmarketorderlistbypair`, {
        sell_token_id: '3031',
        buy_token_id: '5f',
      }).then(
        () => assert.fail('a zero-prefixed asset id must fail before the empty-store reply'),
        (error: Error) => assert.strictEqual(error.message, 'sellTokenId is not a valid number'),
      )
    }
  })
})

describe('asset lookups on a chain with no assets', () => {
  it('answer an empty message for every shape of asset query', async () => {
    assert.deepEqual(await ask('wallet/getassetissuebyid', { value: '1000001' }), {})
    assert.deepEqual(await ask('wallet/getassetissuebyname', { value: '6e6f6e65' }), {})
    assert.deepEqual(await ask('wallet/getassetissuebyaccount', { address: HEX41 }), {})
    assert.deepEqual(await ask('wallet/getassetissuelist'), {})
    assert.deepEqual(await ask('wallet/getassetissuelistbyname', { value: '6e6f6e65' }), {})
  })
})

describe('chain parameters and node info', () => {
  const NODE_INFO_FIELDS = [
    'beginSyncNum',
    'block',
    'solidityBlock',
    'currentConnectCount',
    'activeConnectCount',
    'passiveConnectCount',
    'totalFlow',
    'peerList',
    'configNodeInfo',
    'machineInfo',
    'cheatWitnessInfoMap',
  ]
  const NODE_CONFIG_FIELDS = [
    'codeVersion',
    'versionNum',
    'p2pVersion',
    'listenPort',
    'discoverEnable',
    'activeNodeSize',
    'passiveNodeSize',
    'sendNodeSize',
    'maxConnectCount',
    'sameIpMaxConnectCount',
    'backupListenPort',
    'backupMemberSize',
    'backupPriority',
    'dbVersion',
    'minParticipationRate',
    'supportConstant',
    'minTimeRatio',
    'maxTimeRatio',
    'allowCreationOfContracts',
    'allowAdaptiveEnergy',
  ]
  const NODE_MACHINE_FIELDS = [
    'threadCount',
    'deadLockThreadCount',
    'cpuCount',
    'totalMemory',
    'freeMemory',
    'cpuRate',
    'javaVersion',
    'osName',
    'jvmTotalMemory',
    'jvmFreeMemory',
    'processCpuRate',
    'memoryDescInfoList',
    'deadLockThreadInfoList',
  ]

  it('report the whole committee table', async () => {
    const reply = await ask('wallet/getchainparameters', {}, 'GET')
    const parameters = reply.chainParameter as { key: string }[]
    assert.strictEqual(parameters.length, 79)
    assert.isTrue(parameters.every((entry) => typeof entry.key === 'string'))
  })

  it.each([
    { activatedProposals: [] },
    { activatedProposals: [65] },
    { activatedProposals: [96] },
    { activatedProposals: [65, 96] },
  ])(
    'reports Osaka from the selected execution proposals: $activatedProposals',
    async ({ activatedProposals }) => {
      const local = new TronProvider(
        await TronNode.create({ runtime: { common: { activatedProposals } } }),
      )
      const reply = await local.request({ method: 'wallet/getchainparameters' })
      const osaka = reply.chainParameter.find((entry) => entry.key === 'getAllowTvmOsaka')
      const higherMemoryCost = reply.chainParameter.find(
        (entry) => entry.key === 'getAllowHigherLimitForMaxCpuTimeOfOneTx',
      )
      assert.strictEqual(Number(osaka?.value ?? 0), activatedProposals.includes(96) ? 1 : 0)
      assert.strictEqual(
        Number(higherMemoryCost?.value ?? 0),
        activatedProposals.includes(65) ? 1 : 0,
      )
    },
  )

  it('report a node that is running but peerless', async () => {
    const reply = await ask('wallet/getnodeinfo', {}, 'GET')
    assert.deepEqual(Object.keys(reply), NODE_INFO_FIELDS)
    assert.strictEqual(reply.activeConnectCount, 0)
    assert.strictEqual(reply.currentConnectCount, 0)
    assert.deepEqual(
      Object.keys(reply.configNodeInfo as Record<string, unknown>),
      NODE_CONFIG_FIELDS,
    )
    const machine = reply.machineInfo as Record<string, unknown>
    assert.deepEqual(Object.keys(machine), NODE_MACHINE_FIELDS)
    const pools = machine.memoryDescInfoList as Record<string, unknown>[]
    assert.isAbove(pools.length, 0)
    assert.deepEqual(Object.keys(pools[0]), ['name', 'initSize', 'useSize', 'maxSize', 'useRate'])
    assert.deepEqual(await ask('wallet/listnodes', {}, 'GET'), { nodes: [] })
  })

  it('reports the genesis prices', async () => {
    assert.deepEqual(await ask('wallet/getbandwidthprices', {}, 'GET'), { prices: '0:1000' })
    assert.deepEqual(await ask('walletsolidity/getbandwidthprices', {}, 'GET'), {
      prices: '0:1000',
    })
    assert.deepEqual(await ask('wallet/getenergyprices', {}, 'GET'), { prices: '0:100' })
    assert.deepEqual(await ask('walletsolidity/getenergyprices', {}, 'GET'), { prices: '0:100' })
    assert.deepEqual(await ask('wallet/getmemofee', {}, 'GET'), { prices: '0:1000000' })
  })

  it('derives price replies from the chain parameters that charge the fees', async () => {
    const priced = new TronProvider(
      await TronNode.create({
        chainParameters: { energyFee: 7, transactionFee: 11, memoFee: 13 },
      }),
    )
    const get = async (method: string): Promise<Record<string, unknown>> =>
      (await priced.request({ method, params: { [HTTP_METHOD]: 'GET' } as never })) as Record<
        string,
        unknown
      >

    assert.deepEqual(await get('wallet/getenergyprices'), { prices: '0:7' })
    assert.deepEqual(await get('wallet/getbandwidthprices'), { prices: '0:11' })
    assert.deepEqual(await get('wallet/getmemofee'), { prices: '0:13' })
  })
})

describe('address validation', () => {
  it('accepts either form and says which one it read', async () => {
    assert.deepEqual(await ask('wallet/validateaddress', { address: BASE58 }), {
      result: true,
      message: 'Base58check format',
    })
    assert.deepEqual(await ask('wallet/validateaddress', { address: HEX41 }), {
      result: true,
      message: 'Hex string format',
    })
  })

  it('refuses anything else with the decoder its own words', async () => {
    const reply = await ask('wallet/validateaddress', { address: 'nonsense' })
    assert.strictEqual(reply.result, false)
    assert.isString(reply.message)
  })
})

describe('a field stated as JSON null', () => {
  // the servlets that decode hex for themselves read the value as text, and
  // there is no text in a null — it decodes to empty bytes like an absent field
  it('reads as no bytes wherever a servlet decodes hex itself', async () => {
    assert.deepEqual(await ask('wallet/getaccountresource', { address: null }), {})
    assert.deepEqual(await ask('wallet/getaccountnet', { address: null }), {})
    const built = await ask('wallet/deploycontract', { owner_address: null })
    assert.isUndefined(built.Error)
    assert.isString(built.txID)
  })

  it('still refuses text that is not hex', async () => {
    let message = ''
    try {
      await ask('wallet/getaccountresource', { address: 'zz' })
    } catch (err) {
      message = (err as Error).message
    }
    assert.include(message, 'exception decoding Hex string')
  })
})
