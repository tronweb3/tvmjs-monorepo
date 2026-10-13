import { rejects } from 'node:assert/strict'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { TronWeb, utils } from 'tronweb'
import { assert, describe, it } from 'vitest'

import { DEFAULT_BALANCE_SUN, MAX_ACCOUNT_COUNT } from '../../src/config.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'

import type { ClientConfig, ParamsDict } from '../../src/config.ts'

const phrase = utils.accounts.generateRandom().mnemonic!.phrase
const privateKey = utils.accounts.generateAccount().privateKey.toLowerCase()

describe('startup configuration validation', () => {
  it('starts the same default chain from omitted or empty settings', async () => {
    const omitted = await TronNode.create()
    const empty = await TronNode.create({})
    assert.deepEqual(omitted.config, empty.config)
    assert.deepEqual(omitted.runtime, empty.runtime)
    assert.deepEqual(await omitted.admin.accounts(), await empty.admin.accounts())
  })

  it.each(['mnemonic', 'accounts', 'chainParameters', 'runtime'] as const)(
    'treats an undefined optional %s as omitted',
    async (field) => {
      const config = { [field]: undefined }
      const node = await TronNode.create(config)
      const fromJSON = await TronNode.create(JSON.parse(JSON.stringify(config)))
      assert.deepEqual(node.config, fromJSON.config)
      assert.deepEqual(node.runtime, fromJSON.runtime)
      assert.deepEqual(await node.admin.accounts(), await fromJSON.admin.accounts())
    },
  )

  it('treats undefined optional chain parameters as omitted', async () => {
    const config = { chainParameters: { energyFee: undefined } }
    const node = await TronNode.create(config)
    const fromJSON = await TronNode.create(JSON.parse(JSON.stringify(config)))
    assert.deepEqual(node.config, fromJSON.config)
    assert.deepEqual(node.runtime, fromJSON.runtime)
  })

  it('rejects an unsafe chain parameter rounded while parsing JSON', async () => {
    const config = JSON.parse('{"chainParameters":{"transactionFee":9007199254740993}}')
    assert.strictEqual(config.chainParameters.transactionFee, 9_007_199_254_740_992)
    await rejects(TronNode.create(config), {
      name: 'RangeError',
      message: 'chainParameters.transactionFee must be a safe integer, got 9007199254740992',
    })
  })

  it.each([
    'transactionFee',
    'energyFee',
    'maxFeeLimit',
    'totalEnergyCurrentLimit',
    'totalSignNum',
  ] as const)('rejects unsafe chain parameter %s in programmatic configuration', async (name) => {
    await rejects(TronNode.create({ chainParameters: { [name]: Number.MAX_SAFE_INTEGER + 1 } }), {
      name: 'RangeError',
      message: `chainParameters.${name} must be a safe integer, got 9007199254740992`,
    })
  })

  it.each(['transactionFee', 'energyFee'] as const)(
    'preserves the maximum safe integer for chain parameter %s',
    async (name) => {
      const node = await TronNode.create({
        chainParameters: { [name]: Number.MAX_SAFE_INTEGER },
      })
      assert.strictEqual(node.config.chainParameters[name], Number.MAX_SAFE_INTEGER)
      assert.strictEqual(BigInt(node.config.chainParameters[name]), 9_007_199_254_740_991n)
    },
  )

  it('accepts optional variables together while retaining configured values', async () => {
    const node = await TronNode.create({
      mnemonic: undefined,
      accounts: undefined,
      chainParameters: undefined,
      runtime: { maxEnergyLimitForConstant: 123 },
    })
    assert.deepEqual(node.config, (await TronNode.create()).config)
    assert.strictEqual(node.runtime.maxEnergyLimitForConstant, 123n)
  })

  it('passes Common options to genesis and execution and owns the supplied arrays', async () => {
    const common = { eips: [7939], activatedProposals: [96] }
    const creating = TronNode.create({ runtime: { common } })
    common.eips.length = 0
    common.activatedProposals.length = 0
    const node = await creating
    assert.deepEqual(node.runtime.common, {
      eips: [7939],
      activatedProposals: [96],
      params: {},
    })
    const snapshot = node.runtime.common
    snapshot.eips.length = 0
    snapshot.activatedProposals.length = 0
    const core = nodeCore(node)
    for (const configured of [
      core.common,
      core.vm.common,
      core.blocks.getByNumber(0n)!.block.common,
      core.head().block.common,
    ]) {
      assert.strictEqual(configured.hardfork(), 'tron')
      assert.isTrue(configured.isActivatedEIP(7939))
      assert.isTrue(configured.isActivatedProposal(96))
    }
    assert.deepEqual(node.runtime.common.eips, [7939])
    assert.deepEqual(node.runtime.common.activatedProposals, [96])
  })

  it('keeps TRON execution and the derived chain ID when extra rules are cleared', async () => {
    const node = await TronNode.create({
      runtime: { common: { eips: [], activatedProposals: [] } },
    })
    const core = nodeCore(node)
    for (const common of [
      core.common,
      core.vm.tvm.common,
      core.blocks.getByNumber(0n)!.block.common,
      core.head().block.common,
    ]) {
      assert.strictEqual(common.hardfork(), 'tron')
      assert.isTrue(common.isTron())
    }
    assert.strictEqual(core.common.chainId(), nodeCore(await TronNode.create()).common.chainId())
  })

  it('uses the supported mainnet execution defaults for omitted Common options', async () => {
    const stock = await TronNode.create()
    const empty = await TronNode.create({ runtime: { common: {} } })
    const omitted = await TronNode.create({
      runtime: {
        common: { eips: undefined, activatedProposals: undefined, params: undefined },
      },
    })
    const undefinedCommon = await TronNode.create({ runtime: { common: undefined } })
    assert.deepEqual(stock.runtime, undefinedCommon.runtime)
    assert.deepEqual(stock.runtime.common, {
      eips: [7939],
      activatedProposals: [65, 96],
      params: {},
    })
    for (const node of [stock, empty, omitted, undefinedCommon]) {
      assert.deepEqual(node.config, stock.config)
      assert.deepEqual(node.runtime, stock.runtime)
      assert.strictEqual(nodeCore(node).common.hardfork(), 'tron')
      assert.isTrue(nodeCore(node).common.isActivatedEIP(7939))
      assert.isFalse(nodeCore(node).common.isActivatedEIP(7951))
      assert.isTrue(nodeCore(node).common.isActivatedProposal(65))
      assert.isTrue(nodeCore(node).common.isActivatedProposal(96))
      assert.isFalse(nodeCore(node).common.isActivatedProposal(95))
    }
  })

  it('replaces default selections with supplied lists and isolates nodes', async () => {
    const node = await TronNode.create({
      runtime: { common: { eips: [], activatedProposals: [] } },
    })
    assert.deepEqual(node.runtime.common, { eips: [], activatedProposals: [], params: {} })
    assert.isFalse(nodeCore(node).common.isActivatedEIP(7939))
    assert.isFalse(nodeCore(node).common.isActivatedEIP(7951))
    assert.isFalse(nodeCore(node).common.isActivatedProposal(96))
    const stock = await TronNode.create()
    assert.deepEqual(stock.runtime.common.eips, [7939])
    assert.deepEqual(stock.runtime.common.activatedProposals, [65, 96])
  })

  it.each([
    { common: { eips: [7823] }, error: /EIP 7823 is not supported/ },
    { common: { eips: [7883] }, error: /EIP 7883 is not supported/ },
    { common: { eips: [7951] }, error: /EIP 7951 is not supported/ },
    { common: { activatedProposals: [999] }, error: /Proposal with ID 999 not supported/ },
  ])('preserves execution-library validation for $common', async ({ common, error }) => {
    await rejects(TronNode.create({ runtime: { common } }), error)
  })

  it('rejects malformed Common options before initializing the chain', async () => {
    for (const common of [
      null,
      [],
      'tron',
      { hardfork: 'tron' },
      { hardfork: 'london' },
      { hardfork: 'cancun' },
      { hardfork: undefined },
      { hardfork: null },
      { hardfork: 1 },
      { eip: [7939] },
      { chainId: 1 },
      ...['eips', 'activatedProposals'].flatMap((key) =>
        [
          null,
          96,
          {},
          [null],
          ['96'],
          [0],
          [-1],
          [1.5],
          [Number.MAX_SAFE_INTEGER + 1],
          new Array(1),
        ].map((value) => ({ [key]: value })),
      ),
    ]) {
      await rejects(TronNode.create({ runtime: { common } } as ClientConfig), /runtime\.common/)
    }
  })

  it('rejects non-object startup settings', async () => {
    for (const config of [null, false, 1, '', []]) {
      await rejects(
        Reflect.apply(TronNode.create, TronNode, [config]),
        /configuration must be an object/,
      )
    }
  })

  it('normalizes Common parameters and preserves them across library initialization', async () => {
    const node = await TronNode.create({
      runtime: {
        common: {
          params: {
            1: { maxExtraDataSize: 64, addGas: '9007199254740993' },
            7939: { clzGas: '0x11' },
            3529: { maxRefundQuotient: 7 },
            tron: { memoryGas: null },
          },
        },
      },
    })
    assert.deepEqual(node.runtime.common.params, {
      1: { maxExtraDataSize: 64, addGas: '9007199254740993' },
      7939: { clzGas: '17' },
      3529: { maxRefundQuotient: 7 },
      tron: { memoryGas: null },
    })
    await node.tre.mine()
    const core = nodeCore(node)
    for (const common of [
      core.common,
      core.vm.common,
      core.vm.tvm.common,
      core.blocks.getByNumber(0n)!.block.common,
      core.head().block.common,
    ]) {
      assert.strictEqual(common.param('maxExtraDataSize'), 64n)
      assert.strictEqual(common.param('addGas'), 9007199254740993n)
      assert.strictEqual(common.param('clzGas'), 17n)
      assert.isFalse(common.isActivatedEIP(3529))
      assert.strictEqual(common.param('memoryGas'), 0n)
    }
  })

  it.each([
    '',
    'sload',
    'Tron',
    'prague',
    '0',
    '02929',
    '-1',
    '1.5',
    '1e3',
    '0xb71',
    '__proto__',
    'constructor',
    'toString',
  ])('rejects an invalid Common parameter group "%s" before producing a block', async (group) => {
    const lines: string[] = []
    await rejects(
      TronNode.create({
        runtime: {
          logger: { log: (line: string) => lines.push(line) },
          common: { params: JSON.parse(JSON.stringify({ [group]: { coldsloadGas: 0 } })) },
        },
      }),
      {
        name: 'TypeError',
        message: `Unknown parameter group "${group}" in runtime.common.params`,
      },
    )
    assert.isEmpty(lines)
  })

  it('preserves parameters for a supported rule without activating it', async () => {
    const node = await TronNode.create({
      runtime: { common: { eips: [], params: { 7939: { clzGas: 17 } } } },
    })
    assert.deepEqual(node.runtime.common.params, { 7939: { clzGas: 17 } })
    assert.isFalse(nodeCore(node).common.isActivatedEIP(7939))
  })

  it('rejects malformed Common parameters with the configuration path', async () => {
    for (const params of [null, [], false, 1, 'params']) {
      await rejects(
        Reflect.apply(TronNode.create, TronNode, [{ runtime: { common: { params } } }]),
        /runtime\.common\.params must be an object/,
      )
    }
    for (const group of [null, [], false, 1, 'params']) {
      await rejects(
        Reflect.apply(TronNode.create, TronNode, [
          { runtime: { common: { params: { 7939: group } } } },
        ]),
        /runtime\.common\.params\.7939 must be a parameter object/,
      )
    }
    for (const value of [undefined, '', 'bad', false, {}, [], -1, 1.5, NaN, Infinity, 2 ** 53]) {
      await rejects(
        Reflect.apply(TronNode.create, TronNode, [
          { runtime: { common: { params: { 7939: { clzGas: value } } } } },
        ]),
        /runtime\.common\.params\.7939\.clzGas/,
      )
    }
  })

  it('validates logger objects before initialization', async () => {
    for (const logger of [null, false, () => {}, [], {}, { log: null }, { log: 'console' }]) {
      await rejects(
        Reflect.apply(TronNode.create, TronNode, [{ runtime: { logger } }]),
        /runtime.logger/,
      )
    }
    const node = await TronNode.create({ runtime: { logger: undefined } })
    assert.isUndefined(node.runtime.logger)
  })

  it('captures configuration before awaiting initialization and binds logger methods', async () => {
    const lines: string[] = []
    class Output {
      #lines = lines
      log(message: string) {
        this.#lines.push(message)
      }
    }
    const logger = new Output()
    const config = {
      mnemonic: { phrase, count: 1, balance: 1111 },
      accounts: [{ privateKey, balance: '250000000' }],
      chainParameters: { freeNetLimit: 5000 },
      runtime: { logger, common: { params: { 7939: { clzGas: 3 } } } },
    }
    const creating = TronNode.create(config)
    config.mnemonic.balance = 0
    config.accounts[0].balance = '0'
    config.chainParameters.freeNetLimit = 0
    config.runtime.common.params[7939].clzGas = 0
    logger.log = () => {
      throw new Error('changed output')
    }
    const node = await creating
    assert.strictEqual(node.config.mnemonic.balance, 1111n)
    assert.strictEqual(node.config.accounts[0].balance, 250000000n)
    assert.strictEqual(node.config.chainParameters.freeNetLimit, 5000)
    assert.strictEqual(node.runtime.common.params[7939].clzGas, 3)
    node.runtime.logger!.log = () => {
      throw new Error('changed snapshot')
    }
    await node.tre.mine()
    assert.lengthOf(lines, 3)
    assert.match(lines[0], /Produced block number=1 txs=0$/)
    assert.match(lines[2], /Produced block number=2 txs=0$/)
  })

  const invalid: { name: string; initial: Record<string, unknown>; message: string }[] = [
    ...[0, -1, 1.5, NaN, Infinity, null, '1'].map((count) => ({
      name: `mnemonic.count = ${String(count)}`,
      initial: { mnemonic: { phrase, count } },
      message: `mnemonic.count must be an integer of at least 1, got ${String(count)}`,
    })),
    {
      name: 'mnemonic.count over the derivation limit',
      initial: { mnemonic: { phrase, count: MAX_ACCOUNT_COUNT + 1 } },
      message: `mnemonic.count must be at most ${MAX_ACCOUNT_COUNT}, got ${MAX_ACCOUNT_COUNT + 1}`,
    },
    {
      name: 'null mnemonic',
      initial: { mnemonic: null },
      message: 'mnemonic must be a string or an object',
    },
    {
      name: 'missing phrase',
      initial: { mnemonic: { count: 1 } },
      message: 'mnemonic.phrase must be a string',
    },
    {
      name: 'invalid phrase',
      initial: { mnemonic: { phrase: 'invalid phrase' } },
      message: 'mnemonic.phrase is not a valid BIP-39 phrase',
    },
    {
      name: 'unknown mnemonic field',
      initial: { mnemonic: { phrase, counts: 1 } },
      message: 'Unknown key "counts" in mnemonic',
    },
    ...[
      { balance: null, fault: 'must be an integer in sun' },
      { balance: '', fault: 'must be an integer in sun' },
      { balance: '  ', fault: 'must be an integer in sun' },
      { balance: '\t\n', fault: 'must be an integer in sun' },
      { balance: -1n, fault: 'must be at least 0, got -1' },
      {
        balance: '9223372036854775808',
        fault: 'must be at most 9223372036854775807, got 9223372036854775808',
      },
      {
        balance: Number.MAX_SAFE_INTEGER + 1,
        fault: 'is past what a JSON number states exactly; write it as a string',
      },
    ].flatMap(({ balance, fault }) => [
      {
        name: `mnemonic balance ${String(balance)}`,
        initial: { mnemonic: { phrase, balance } },
        message: `mnemonic.balance ${fault}`,
      },
      {
        name: `account balance ${String(balance)}`,
        initial: { accounts: [{ privateKey, balance }] },
        message: `accounts[0].balance ${fault}`,
      },
    ]),
    { name: 'null accounts', initial: { accounts: null }, message: 'accounts must be an array' },
    {
      name: 'null account entry',
      initial: { accounts: [null] },
      message: 'accounts[0] must be an object',
    },
    {
      name: 'unknown account field',
      initial: { accounts: [{ privateKey, balnce: 1 }] },
      message: 'Unknown key "balnce" in accounts[0]',
    },
    ...[
      { name: 'null private key', key: null, fault: 'must be a string' },
      { name: 'empty private key', key: '', fault: 'is empty' },
      {
        name: 'non-hex private key',
        key: 'not-hex',
        fault: 'holds characters that are not hex digits',
      },
      { name: 'zero private key', key: '00'.repeat(32), fault: 'is not a key this wallet accepts' },
      {
        name: 'out-of-range private key',
        key: 'ff'.repeat(32),
        fault: 'is not a key this wallet accepts',
      },
    ].map(({ name, key, fault }) => ({
      name,
      initial: { accounts: [{ privateKey: key }] },
      message: `accounts[0].privateKey ${fault}`,
    })),
    {
      name: 'null chain parameters',
      initial: { chainParameters: null },
      message: 'chainParameters must be an object',
    },
    {
      name: 'unknown chain parameter',
      initial: { chainParameters: { energyFees: 1 } },
      message: 'Unknown chain parameter "energyFees"',
    },
    ...['allowTvmCompatibleEvm', 'allowTvmConstantinople', 'allowTvmSolidity059'].map((name) => ({
      name: `fixed protocol capability ${name}`,
      initial: { chainParameters: { [name]: 1 } },
      message: `Unknown chain parameter "${name}"`,
    })),
    {
      name: 'null chain parameter',
      initial: { chainParameters: { energyFee: null } },
      message: 'chainParameters.energyFee must be a number',
    },
    {
      name: 'zero energy fee',
      initial: { chainParameters: { energyFee: 0 } },
      message: 'chainParameters.energyFee must be an integer of at least 1, got 0',
    },
    { name: 'unknown top-level field', initial: { account: [] }, message: 'Unknown key "account"' },
    {
      name: 'undefined unknown field',
      initial: { account: undefined },
      message: 'Unknown key "account"',
    },
  ]

  it.each(invalid)('rejects $name at creation', async ({ initial, message }) => {
    await rejects(TronNode.create(initial as ClientConfig), { message })
  })

  it.each([
    { balance: undefined, expected: DEFAULT_BALANCE_SUN },
    { balance: 0, expected: 0n },
    { balance: 0n, expected: 0n },
    { balance: '0', expected: 0n },
    { balance: '0x0', expected: 0n },
    { balance: '250000000', expected: 250_000_000n },
    { balance: '0x250000000', expected: 9_932_111_872n },
    { balance: 9_223_372_036_854_775_807n, expected: 9_223_372_036_854_775_807n },
  ])('normalizes balances before funding accounts ($balance)', async ({ balance, expected }) => {
    const initial = {
      mnemonic: { phrase, count: 1, ...(balance === undefined ? {} : { balance }) },
      accounts: [{ privateKey: `0x${privateKey}`, ...(balance === undefined ? {} : { balance }) }],
      chainParameters: { transactionFee: 0 },
    }
    const parsedNode = await TronNode.create(initial)
    const editedNode = await TronNode.create(parsedNode.config)
    assert.deepEqual(editedNode.config, parsedNode.config)
    assert.strictEqual(
      nodeCore(editedNode).blocks.getByNumber(0n)?.blockID,
      nodeCore(parsedNode).blocks.getByNumber(0n)?.blockID,
    )
    assert.strictEqual(editedNode.config.mnemonic.count, 1)
    assert.strictEqual(editedNode.config.mnemonic.balance, expected)
    assert.deepEqual(editedNode.config.accounts, [{ privateKey, balance: expected }])
    const listed = (await new TronProvider(editedNode).request({
      method: 'admin/accounts-json',
    })) as { privateKeys: string[] }
    assert.lengthOf(listed.privateKeys, 1)
    for (const key of [listed.privateKeys[0], privateKey]) {
      const address = parseTronAddress(TronWeb.address.fromPrivateKey(key) as string)
      assert.strictEqual(await nodeCore(editedNode).getBalance(address), expected)
    }
  })

  it('validates runtime and fills omitted settings at creation', async () => {
    const defaults = (await TronNode.create()).runtime
    for (const field of [
      'maxEnergyLimitForConstant',
      'energyLimitActivationBlock',
      'assetFrozenSupplyOverflowActivationBlock',
    ]) {
      for (const value of [
        null,
        -1n,
        '',
        ' ',
        'bad',
        false,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        {},
        [],
      ]) {
        const runtime = { [field]: value }
        await rejects(TronNode.create({ runtime }), new RegExp(field))
      }
      assert.deepEqual(
        (await TronNode.create({ runtime: { [field]: undefined } })).runtime,
        defaults,
      )
    }
    for (const runtime of [null, { maxEnergyLimitForConstnat: 1 }]) {
      // Invalid JavaScript inputs intentionally bypass the static type checker.
      await rejects(Reflect.apply(TronNode.create, TronNode, [{ runtime }]), /runtime/)
    }
  })

  it('deduplicates configured accounts, with the final balance winning', async () => {
    const config = {
      mnemonic: { phrase, count: 1 },
      accounts: [
        { privateKey, balance: 1n },
        { privateKey: `0X${privateKey.toUpperCase()}`, balance: 2n },
      ],
    }
    const node = await TronNode.create(config)
    assert.lengthOf(config.accounts, 2)
    assert.deepEqual(node.config.accounts, [{ privateKey: privateKey.toUpperCase(), balance: 2n }])
    assert.strictEqual(
      await nodeCore(node).getBalance(
        parseTronAddress(TronWeb.address.fromPrivateKey(privateKey) as string),
      ),
      2n,
    )
    const listed = await new TronProvider(node).request({ method: 'admin/accounts-json' })
    assert.deepEqual(listed.more, [
      {
        privateKeys: [privateKey.toUpperCase()],
        more: [],
      },
    ])
  })
})

describe('Common override spelling and actual execution', () => {
  const overrides: ParamsDict[] = [
    { 1: { addGsa: 9 } },
    { 999999: { addGas: 9 } },
    { 1: { energyFee: 9 } },
  ]
  for (const params of overrides) {
    it(`rejects an unrecognized override ${JSON.stringify(params)}`, async () => {
      await rejects(TronNode.create({ runtime: { common: { params } } }), /runtime\.common\.params/)
    })
  }
  it('a recognized ADD override changes executed energy by the requested amount', async () => {
    const used: number[] = []
    for (const addGas of [3, 9]) {
      const node = await TronNode.create({ runtime: { common: { params: { 1: { addGas } } } } })
      const provider = new TronProvider(node)
      const addresses = (await node.admin.accounts()).privateKeys.map(
        (key) => TronWeb.address.fromPrivateKey(key) as string,
      )
      await provider.request({
        method: 'tre_setAccountCode',
        params: [addresses[1], '0x60016001015000'],
      })
      const result = await provider.request({
        method: 'wallet/triggerconstantcontract',
        params: { owner_address: addresses[0], contract_address: addresses[1] },
      })
      assert.isTrue(result.result?.result)
      used.push(result.energy_used!)
    }
    // PUSH1 + PUSH1 + ADD + POP, with no memory access or returned code.
    assert.deepEqual(used, [3 + 3 + 3 + 2, 3 + 3 + 9 + 2])
  })
})
