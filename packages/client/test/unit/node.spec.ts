import { rejects } from 'node:assert/strict'
import { AsyncResource } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { bytesToBigInt, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, describe, it, vi } from 'vitest'

import {
  CLIENT_NAME,
  CLIENT_VERSION,
  accountsFromMnemonic,
  resolveConfig,
} from '../../src/config.ts'
import type { InitialConfigInput } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { parseTronAddress, toBase58 } from '../../src/dialect/tron/address.ts'
import { currentCycleNumber, nextMaintenanceTime } from '../../src/dialect/tron/wallet/nodeinfo.ts'
import { derivePrivateKeys } from '../../src/hdWallet.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

// runtime bytecode of a minimal contract exposing `uint256 public total`
const RUNTIME_CODE =
  '0x6080604052348015600f57600080fd5b506004361060285760003560e01c80632ddbd13a14602d575b600080fd5b60336047565b604051603e9190604d565b60405180910390f35b60005481565b9081526020019056fea2646970667358221220c51fe6383da9d6d3eb400e2da0740e3bbcb4e1834682da9388000d75ec81741564736f6c63430008000033'
const TOTAL_SELECTOR = '0x2ddbd13a'

const SLOT0 = `0x${'00'.repeat(32)}` as const

function testConfig(initial: InitialConfigInput = {}) {
  return resolveConfig(initial)
}

describe('published identity', () => {
  it('reports the version the package actually publishes', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { name: string; version: string }
    // the constant is what admin/ and the server header report; a drift would
    // have the node claiming a version nobody can install
    assert.strictEqual(CLIENT_NAME, manifest.name)
    assert.strictEqual(CLIENT_VERSION, manifest.version)
  })
})

describe('account configuration', () => {
  it('takes private keys with or without an 0x prefix', () => {
    const bare = utils.accounts.generateAccount().privateKey.toLowerCase()
    for (const spelled of [bare, `0x${bare}`, `0X${bare}`]) {
      const config = resolveConfig({ accounts: [{ privateKey: spelled, balance: 1n }] })
      assert.deepEqual(config.accounts, [{ privateKey: bare, balance: 1n }])
    }
    const config = resolveConfig({ accounts: [{ privateKey: `0x${bare}`, balance: 1n }] })
    assert.strictEqual(config.accounts[0]?.privateKey, bare)
  })

  it('derives the roster from an overriding mnemonic', () => {
    const phrase = utils.accounts.generateRandom().mnemonic!.phrase
    const config = resolveConfig({ mnemonic: phrase })
    assert.strictEqual(config.mnemonic.phrase, phrase)
    assert.lengthOf(accountsFromMnemonic(config.mnemonic), 10)
    assert.strictEqual(
      accountsFromMnemonic(config.mnemonic)[0]?.privateKey,
      derivePrivateKeys(phrase, 1)[0],
    )
    assert.deepStrictEqual(config.accounts, [])
  })

  it('keeps directly configured accounts separate from the mnemonic settings', () => {
    const phrase = utils.accounts.generateRandom().mnemonic!.phrase
    const privateKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const config = resolveConfig({
      mnemonic: phrase,
      accounts: [{ privateKey, balance: 7n }],
    })
    assert.strictEqual(config.mnemonic.phrase, phrase)
    assert.deepStrictEqual(config.accounts, [{ privateKey, balance: 7n }])
  })

  it('takes process-local controls separately from the chain-birth input', () => {
    const config = resolveConfig({ runtime: { maxEnergyLimitForConstant: 1n } })
    assert.strictEqual(config.runtime.maxEnergyLimitForConstant, 1n)
    assert.throws(
      () => resolveConfig({ maxEnergyLimitForConstant: 1n } as never),
      /Unknown key "maxEnergyLimitForConstant"/,
    )
  })

  it('funds directly configured accounts at genesis through the account flow', async () => {
    const account = utils.accounts.generateAccount()
    const config = testConfig({ accounts: [{ privateKey: account.privateKey, balance: '7' }] })
    assert.strictEqual(config.accounts[0]?.balance, 7n)
    const node = await TronNode.create(config)
    const extra = parseTronAddress(account.address.base58)
    assert.strictEqual(await nodeCore(node).getBalance(extra), 7n)
  })

  it('refuses null where a balance is stated programmatically', () => {
    const { privateKey } = utils.accounts.generateAccount()
    assert.throws(
      () => resolveConfig({ accounts: [{ privateKey, balance: null as never }] }),
      /accounts\[0\]\.balance must be an integer in sun/,
    )
    assert.throws(
      () =>
        resolveConfig({
          mnemonic: {
            phrase: utils.accounts.generateRandom().mnemonic!.phrase,
            balance: null as never,
          },
        }),
      /mnemonic\.balance must be an integer in sun/,
    )
  })
})

describe('TronNode core', () => {
  it('queues callbacks inherited from an expired lock owner', async () => {
    const core = nodeCore(await TronNode.create())
    const order: string[] = []
    const later = await core.withWriteLock(async () =>
      AsyncResource.bind(() =>
        core.withWriteLock(async () => {
          order.push('later')
        }),
      ),
    )
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const active = core.withWriteLock(async () => {
      order.push('active')
      entered()
      await gate
      order.push('released')
    })
    await started
    const queued = later()
    try {
      assert.deepEqual(order, ['active'])
    } finally {
      release()
      await Promise.all([active, queued])
    }
    assert.deepEqual(order, ['active', 'released', 'later'])
  })

  it('pins copied VM history to the committed head and returns independent hash bytes', async () => {
    const node = await TronNode.create()
    const core = nodeCore(node)
    const height = Number(core.head().number)
    const snapshot = core.vm.blockchain.shallowCopy()
    const block = await snapshot.getBlock(height)
    const hash = block.hash()
    assert.strictEqual(Buffer.from(hash).toString('hex'), core.head().blockID)
    hash.fill(0)
    assert.strictEqual(Buffer.from(block.hash()).toString('hex'), core.head().blockID)
    await node.tre.mine()
    await rejects(snapshot.getBlock(height + 1), /not in the committed history/)
    assert.strictEqual(
      Buffer.from((await core.vm.blockchain.getBlock(height + 1)).hash()).toString('hex'),
      core.head().blockID,
    )
  })

  it('seals genesis + an initial block with prefunded accounts', async () => {
    const config = testConfig()
    const node = await TronNode.create(config)

    // chain starts at height 1 (block 0 exists but is never the served head)
    const head = nodeCore(node).head()
    assert.strictEqual(head.number, 1n)
    assert.strictEqual(head.blockID.length, 64)
    // TRON blockID prefix carries the height
    assert.strictEqual(head.blockID.slice(0, 16), '0000000000000001')
    assert.strictEqual(nodeCore(node).blocks.getByNumber(0n)?.number, 0n)

    // CHAINID is the tail of the genesis block ID, not an Ethereum chain number
    const genesisID = nodeCore(node).blocks.getByNumber(0n)!.blockID
    assert.strictEqual(nodeCore(node).common.chainId(), BigInt(`0x${genesisID.slice(-8)}`))
    assert.strictEqual(nodeCore(node).common.hardfork(), 'tron')
    assert.strictEqual(nodeCore(node).vm.tvm.common.hardfork(), 'tron')

    for (const account of accountsFromMnemonic(config.mnemonic)) {
      const base58 = TronWeb.address.fromPrivateKey(account.privateKey) as string
      const balance = await nodeCore(node).getBalance(parseTronAddress(base58))
      assert.strictEqual(balance, account.balance)
    }
  })

  it('owns an independent copy of its startup configuration', async () => {
    const account = utils.accounts.generateAccount()
    const replacement = utils.accounts.generateAccount()
    const config = resolveConfig({
      accounts: [{ privateKey: account.privateKey, balance: 1n }],
      runtime: { common: { params: { '7939': { clzGas: 7 } } } },
    })
    const first = { ...accountsFromMnemonic(config.mnemonic)[0]! }
    const direct = { ...config.accounts[0]! }
    const mnemonic = { ...config.mnemonic }
    const transactionFee = config.chainParameters.transactionFee
    const accounts = config.accounts
    const chainParameters = config.chainParameters
    const runtime = config.runtime
    const maxEnergyLimitForConstant = runtime.maxEnergyLimitForConstant
    const clzGas = runtime.common.params['7939']?.clzGas
    const pending = TronNode.create(config)
    config.mnemonic.count = 1
    config.mnemonic.phrase = 'invalid phrase'
    config.accounts[0]!.privateKey = replacement.privateKey
    config.accounts[0]!.balance = 2n
    config.accounts.splice(0)
    config.chainParameters.transactionFee = 0
    config.runtime.maxEnergyLimitForConstant = 1n
    config.runtime.common.params['7939']!.clzGas = 1
    const node = await pending

    assert.notStrictEqual(node.config, config)
    assert.notStrictEqual(node.config.mnemonic, mnemonic)
    assert.notStrictEqual(node.config.accounts, accounts)
    assert.notStrictEqual(node.config.chainParameters, chainParameters)
    assert.notStrictEqual(node.runtime, runtime)
    assert.strictEqual(node.config.mnemonic.count, mnemonic.count)
    assert.strictEqual(node.config.mnemonic.phrase, mnemonic.phrase)
    assert.deepEqual(node.config.accounts, [direct])
    assert.strictEqual(node.config.chainParameters.transactionFee, transactionFee)
    assert.strictEqual(node.runtime.maxEnergyLimitForConstant, maxEnergyLimitForConstant)
    assert.strictEqual(node.runtime.common.params['7939']?.clzGas, clzGas)

    const snapshot = node.config
    snapshot.mnemonic.balance = 1n
    snapshot.accounts.splice(0)
    snapshot.chainParameters.transactionFee = 0
    const runtimeSnapshot = node.runtime
    runtimeSnapshot.maxEnergyLimitForConstant = 1n
    runtimeSnapshot.common.params['7939']!.clzGas = 2
    assert.strictEqual(node.config.mnemonic.balance, mnemonic.balance)
    assert.deepEqual(node.config.accounts, [direct])
    assert.strictEqual(node.config.chainParameters.transactionFee, transactionFee)
    assert.strictEqual(node.runtime.maxEnergyLimitForConstant, maxEnergyLimitForConstant)
    assert.strictEqual(node.runtime.common.params['7939']?.clzGas, clzGas)

    const listed = (await new TronProvider(node).request({
      method: 'admin/accounts-json',
    })) as { privateKeys: string[]; more: unknown[] }
    assert.lengthOf(listed.privateKeys, 10)
    assert.lengthOf(listed.more, 1)
    const owner = parseTronAddress(TronWeb.address.fromPrivateKey(first.privateKey) as string)
    assert.strictEqual(await nodeCore(node).getBalance(owner), first.balance)
  })

  it('mines empty blocks and keeps blockID/height consistent', async () => {
    const node = await TronNode.create(testConfig())
    await node.tre.mine(3)

    const head = nodeCore(node).head()
    assert.strictEqual(head.number, 4n)
    assert.strictEqual(nodeCore(node).blocks.getByNumber(3n)?.number, 3n)
    assert.strictEqual(nodeCore(node).blocks.getById(head.blockID)?.number, 4n)
    assert.strictEqual(head.parentBlockID, nodeCore(node).blocks.getByNumber(3n)?.blockID)
  })

  it.each([
    { label: 'Error', failure: new Error('state root unavailable') },
    { label: 'non-Error rejection', failure: 'state root unavailable' },
  ])(
    'reports interval mining failures and resumes after recovery ($label)',
    async ({ failure }) => {
      const node = await TronNode.create(testConfig())
      const head = nodeCore(node).head()
      const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const stateRoot = vi
        .spyOn(nodeCore(node).stateManager, 'getStateRoot')
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure)
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        await node.tre.blockTime(1)
        for (let tick = 1; tick <= 2; tick++) {
          await vi.advanceTimersByTimeAsync(1000)
          assert.strictEqual(nodeCore(node).head().number, head.number)
          assert.lengthOf(reported.mock.calls, tick)
          assert.lengthOf(reported.mock.calls[tick - 1], 1)
          assert.match(reported.mock.calls[tick - 1][0], / ERROR Interval mining failed$/)
          assert.notInclude(reported.mock.calls[tick - 1][0], 'state root unavailable')
        }

        await vi.advanceTimersByTimeAsync(1000)
        assert.strictEqual(nodeCore(node).head().number, head.number + 1n)
        assert.strictEqual(nodeCore(node).head().parentBlockID, head.blockID)
        assert.lengthOf(reported.mock.calls, 2)

        await node.tre.blockTime(0)
        await vi.advanceTimersByTimeAsync(2000)
        assert.strictEqual(nodeCore(node).head().number, head.number + 1n)
        assert.lengthOf(reported.mock.calls, 2)
      } finally {
        await node.tre.blockTime(0)
        vi.useRealTimers()
        stateRoot.mockRestore()
        reported.mockRestore()
      }
    },
  )

  it('cheat-set code and storage are visible to call()', async () => {
    const node = await TronNode.create(testConfig())
    const contract = parseTronAddress(utils.accounts.generateAccount().address.base58)
    const caller = parseTronAddress(utils.accounts.generateAccount().address.base58)

    await nodeCore(node).setCode(contract, hexToBytes(RUNTIME_CODE))
    assert.deepEqual(await nodeCore(node).getCode(contract), hexToBytes(RUNTIME_CODE))

    const before = await nodeCore(node).call({
      caller,
      to: contract,
      data: hexToBytes(TOTAL_SELECTOR),
    })
    assert.strictEqual(before.reverted, false)
    assert.strictEqual(bytesToBigInt(before.returnValue), 0n)
    assert.isAbove(Number(before.energyUsed), 0)

    await nodeCore(node).setStorage(contract, hexToBytes(SLOT0), hexToBytes('0x01'))
    const after = await nodeCore(node).call({
      caller,
      to: contract,
      data: hexToBytes(TOTAL_SELECTOR),
    })
    assert.strictEqual(bytesToBigInt(after.returnValue), 1n)
  })

  it('address helpers roundtrip through tronweb', async () => {
    const base58 = utils.accounts.generateAccount().address.base58
    const address = parseTronAddress(base58)
    assert.strictEqual(toBase58(address), base58)
    // 41-hex input parses to the same address
    assert.isTrue(parseTronAddress(TronWeb.address.toHex(base58)).equals(address))
  })

  it('bandwidth: free quota with 24h linear recovery, then burn, then reject', async () => {
    const config = testConfig({ chainParameters: { freeNetLimit: 600 } })
    const clock = new Clock(() => 1_000_000_000)
    const node = await createNode(config, clock)
    const owner = parseTronAddress(
      TronWeb.address.fromPrivateKey(
        accountsFromMnemonic(config.mnemonic)[0]!.privateKey,
      ) as string,
    )
    const price = BigInt(config.chainParameters.transactionFee)

    // free quota is all or nothing: 400 fits, 400+300 does not
    assert.strictEqual((await nodeCore(node).consumeBandwidth(owner, 400)).source, 'free')
    assert.strictEqual(nodeCore(node).getFreeBandwidthUsed(owner), 400)
    const burn = await nodeCore(node).consumeBandwidth(owner, 300)
    assert.strictEqual(burn.source, 'burn')
    assert.strictEqual((burn as { feeSun: bigint }).feeSun, 300n * price)
    // burning does not consume the free quota
    assert.strictEqual(nodeCore(node).getFreeBandwidthUsed(owner), 400)

    // half a window later half the usage has recovered, freeing the quota again
    clock.advanceMs(12 * 3600 * 1000)
    assert.strictEqual(nodeCore(node).getFreeBandwidthUsed(owner), 200)
    assert.strictEqual((await nodeCore(node).consumeBandwidth(owner, 300)).source, 'free')

    // a full window later everything has recovered
    clock.advanceMs(24 * 3600 * 1000)
    assert.strictEqual(nodeCore(node).getFreeBandwidthUsed(owner), 0)

    // an unfunded account past the quota cannot burn either
    const broke = parseTronAddress(utils.accounts.generateAccount().address.base58)
    const rejected = await nodeCore(node).consumeBandwidth(broke, 700)
    assert.strictEqual(rejected.source, 'insufficient')
  })
})

describe('the maintenance cycle counter', () => {
  it('counts the boundaries the chain crossed, starting at zero', async () => {
    const node = await TronNode.create()
    const interval = node.config.chainParameters.maintenanceTimeIntervalMs
    await node.tre.mine(1)
    // the chain keeps this as a counter stepped once per maintenance, so a
    // chain that has just started has been through none
    assert.strictEqual(currentCycleNumber(nodeCore(node)), 0)
    await node.tre.increaseTime(interval / 1000)
    assert.strictEqual(currentCycleNumber(nodeCore(node)), 1)
    await node.tre.increaseTime((interval / 1000) * 3)
    assert.strictEqual(currentCycleNumber(nodeCore(node)), 4)
  })

  it('keeps the next maintenance time strictly after the head block', async () => {
    const node = await TronNode.create()
    await node.tre.mine(1)
    assert.isAbove(nextMaintenanceTime(nodeCore(node)), nodeCore(node).head().timestampMs)
  })
})

describe('configuration faults', () => {
  const fault = async (privateKey: string): Promise<string> => {
    const config = resolveConfig()
    config.accounts = [{ privateKey, balance: 1n }]
    try {
      await TronNode.create(config)
    } catch (err) {
      return (err as Error).message
    }
    return 'no failure'
  }

  it('says what is wrong with a dev key, and where it sits', async () => {
    const { privateKey, address } = utils.accounts.generateAccount()
    assert.strictEqual(await fault(''), 'accounts[0].privateKey is empty')
    assert.strictEqual(await fault(`0x${privateKey}`), 'no failure')
    // a base58 address pasted into the key field
    assert.include(await fault(address.base58), 'characters that are not hex digits')
  })

  it('says what is wrong with a dev balance, and where it sits', async () => {
    const brim = 9_223_372_036_854_775_807n
    const { privateKey } = utils.accounts.generateAccount()
    const withBalance = async (balance: bigint): Promise<string> => {
      const config = resolveConfig()
      config.accounts = [{ privateKey, balance }]
      try {
        await TronNode.create(config)
      } catch (err) {
        return (err as Error).message
      }
      return 'no failure'
    }
    assert.strictEqual(await withBalance(-1n), 'accounts[0].balance must be at least 0, got -1')
    assert.strictEqual(
      await withBalance(brim + 1n),
      `accounts[0].balance must be at most ${brim}, got ${brim + 1n}`,
    )
    assert.strictEqual(await withBalance(brim), 'no failure')
  })

  it('refuses a chain parameter that would break arithmetic downstream', async () => {
    const fails = async (chainParameters: Record<string, number>): Promise<string> => {
      try {
        await TronNode.create({ chainParameters } as never)
      } catch (err) {
        return (err as Error).message
      }
      return 'no failure'
    }
    // a zero divisor makes an energy budget infinite
    assert.include(
      await fails({ energyFee: 0 }),
      'chainParameters.energyFee must be an integer of at least 1',
    )
    assert.include(
      await fails({ maintenanceTimeIntervalMs: 0 }),
      'chainParameters.maintenanceTimeIntervalMs must be an integer between 81000 and 86400000',
    )
    // a negative fee turns a charge into a credit
    assert.include(await fails({ transactionFee: -1 }), 'between 0 and 100000000000000000')
    // beyond the range a proposal could ever set
    assert.include(await fails({ freeNetLimit: 200_000 }), 'between 0 and 100000')
    assert.include(await fails({ unfreezeDelayDays: 366 }), 'between 0 and 365')
    // and a fractional one would round somewhere nobody chose
    assert.include(await fails({ transactionFee: 1.5 }), 'between 0 and 100000000000000000')
    // a chain can be born mid-activation: gates at 0 and day-zero unfreezing are real
    assert.strictEqual(await fails({ unfreezeDelayDays: 0, allowMultiSign: 0 }), 'no failure')
  })

  it('takes the parameters it was built with', async () => {
    const node = await TronNode.create({ chainParameters: { transactionFee: 0 } })
    assert.strictEqual(node.config.chainParameters.transactionFee, 0)
  })

  it('never carries the key into the failure', async () => {
    // a configuration failure travels into logs and bug reports; a key that
    // reaches one of those is spent
    const secret = `${'dead'.repeat(15)}zzzz`
    assert.notInclude(await fault(secret), secret)
    assert.notInclude(await fault(secret), 'dead')
  })
})

describe('int64 on the wire', () => {
  it('carries every digit past the range a double can hold', async () => {
    const config = resolveConfig()
    // 2^53 + 1: the first integer a double cannot state
    const exact = 9_007_199_254_740_993n
    config.accounts = [
      { privateKey: accountsFromMnemonic(config.mnemonic)[0]!.privateKey, balance: exact },
    ]
    const node = await TronNode.create(config)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    try {
      const address = TronWeb.address.toHex(
        TronWeb.address.fromPrivateKey(config.accounts[0]!.privateKey) as string,
      )
      const text = await (await fetch(`${started.url}/wallet/getaccount?address=${address}`)).text()
      // read the raw text: parsing it here would round it the same way
      assert.include(text, `"balance":${exact}`)
      const quoted = await (
        await fetch(`${started.url}/wallet/getaccount?address=${address}&int64_as_string=true`)
      ).text()
      assert.include(quoted, `"balance":"${exact}"`)
    } finally {
      started.server.close()
    }
  })
})

describe('a call that only simulates', () => {
  it('leaves no storage slot behind on the node it ran against', async () => {
    const node = await TronNode.create()
    const address = parseTronAddress(`41${'ab'.repeat(20)}`)
    // PUSH1 0 CALLDATALOAD → base; 1000 rounds of SSTORE at base + n
    await nodeCore(node).setCode(
      address,
      hexToBytes('0x6000356103e85b8082018055600190038060065700'),
    )
    const slots = (): number =>
      [...nodeCore(node).storageSlots.values()].reduce((total, held) => total + held.size, 0)
    assert.strictEqual(slots(), 0)

    const root = await nodeCore(node).stateManager.getStateRoot()
    await nodeCore(node).call({ caller: address, to: address, data: new Uint8Array(32) })

    assert.strictEqual(slots(), 0)
    assert.deepEqual(await nodeCore(node).stateManager.getStateRoot(), root)
    // and a write through the same opcode does register
    await nodeCore(node).setStorage(address, new Uint8Array(32), new Uint8Array([1]))
    assert.strictEqual(slots(), 1)
  })
})

describe('a request that fails outside any handler', () => {
  it('states the message as JSON, whatever characters it holds', async () => {
    const node = await TronNode.create(testConfig())
    const provider = new TronProvider(node)
    const nasty = 'he said "no", then\na newline'
    const started = await startHttpServer(provider, { port: 0 })
    // Fail while reading the incoming request, outside the handler's boundary.
    started.server.prependOnceListener('request', (req) => {
      Object.defineProperty(req, 'url', {
        get: () => {
          throw new Error(nasty)
        },
      })
    })
    try {
      const res = await fetch(`${started.url}/wallet/getnowblock`)
      assert.strictEqual(res.status, 500)
      assert.deepEqual(await res.json(), { Error: nasty })
    } finally {
      started.server.close()
    }
  })
})
