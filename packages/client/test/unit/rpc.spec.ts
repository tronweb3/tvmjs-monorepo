import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { assert, describe, expectTypeOf, it } from 'vitest'

import { defaultRegistry } from '../../src/dialect/index.ts'
import { CONTRACT_TYPE } from '../../src/dialect/tron/contractTypes.ts'
import { isAdaptedContractType } from '../../src/dialect/tron/wallet/contractAdapter.ts'
import { TronNode, TronProvider } from '../../src/index.ts'

import type {
  AccountPermission,
  BlockList,
  CommonTransactionParams,
  ContractName,
  ProviderMethodParams,
  ProviderRequest,
  ProviderResult,
  RPCMethods,
  TransactionBuildResult,
  TransactionEcho,
  TronTransaction,
} from '../../src/index.ts'

describe('provider method contracts', () => {
  it('keeps method and contract type maps aligned with runtime support', () => {
    const file = fileURLToPath(new URL('../../src/rpc.ts', import.meta.url))
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.NodeNext,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
    })
    const source = program.getSourceFile(file)!
    const declaration = source.statements.find(
      (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === 'RPCMethods',
    )!
    const checker = program.getTypeChecker()
    const methods = checker.getTypeAtLocation(declaration).getProperties()
    assert.deepEqual(methods.map((method) => method.name).sort(), defaultRegistry.methods().sort())
    const input = program.getSourceFile(
      fileURLToPath(new URL('../../src/rpcInput.ts', import.meta.url)),
    )!
    const contracts = input.statements.find(
      (statement) =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'ContractInputMap',
    )!
    const adapterSource = program.getSourceFile(
      fileURLToPath(new URL('../../src/dialect/tron/wallet/contractAdapter.ts', import.meta.url)),
    )!
    const adapters = adapterSource.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((declaration) => declaration.name.getText(adapterSource) === 'ADAPTERS')!
    assert.isTrue(ts.isCallExpression(adapters.initializer!))
    const adapterObject = (adapters.initializer as ts.CallExpression).arguments[0]
    assert.isTrue(ts.isObjectLiteralExpression(adapterObject))
    const adapterType = checker.getTypeAtLocation(adapterObject)
    assert.isUndefined(
      adapterType.getStringIndexType(),
      'Adapter keys must be statically enumerable',
    )
    const adapterNames = adapterType
      .getProperties()
      .map((adapter) => adapter.name)
      .sort()
    assert.deepEqual(
      adapterNames.filter((name) => !Object.prototype.hasOwnProperty.call(CONTRACT_TYPE, name)),
      [],
      'Every adapter must name a protocol contract',
    )
    assert.isTrue(adapterNames.every(isAdaptedContractType))
    assert.deepEqual(
      checker
        .getTypeAtLocation(contracts)
        .getProperties()
        .map((contract) => contract.name)
        .sort(),
      adapterNames,
    )
    type UnknownResults = {
      [M in keyof RPCMethods]: unknown extends ProviderResult<M> ? M : never
    }[keyof RPCMethods]
    expectTypeOf<UnknownResults>().toEqualTypeOf<never>()
    expectTypeOf<ProviderResult<string>>().toEqualTypeOf<unknown>()
    expectTypeOf<ProviderResult<'walletsolidity/getaccountresource'>>().toEqualTypeOf<unknown>()
    expectTypeOf<ProviderResult<'walletsolidity/getblockbylatestnum'>>().toEqualTypeOf<BlockList>()
    expectTypeOf<ProviderResult<'wallet/getexchangebyid'>>().toEqualTypeOf<never>()
  }, 15_000)

  it('distinguishes optional defaults, required inputs, and method-specific fields at compile time', () => {
    // Type-check these calls without executing intentionally invalid requests.
    const check = (provider: TronProvider) => {
      provider.request({ method: 'wallet/getblockbynum' })
      provider.request({ method: 'wallet/getassetissuebyname' })
      provider.request({ method: 'wallet/deploycontract' })
      provider.request({ method: 'wallet/deploycontract', params: {} })
      // @ts-expect-error A visible asset name cannot be omitted.
      provider.request({ method: 'wallet/getassetissuebyname', params: { visible: true } })
      provider.request({ method: 'wallet/getblock', params: { detail: false } })
      provider.request({
        method: 'wallet/getpaginatedassetissuelist',
        params: { offset: 0n, limit: '0x2' },
      })
      provider.request({ method: 'wallet/updateaccount', params: { owner_address: 'address' } })
      provider.request({
        method: 'wallet/triggerconstantcontract',
        params: { owner_address: 'address', data: '6000' },
      })
      // @ts-expect-error Program pagination requires both bounds.
      provider.request({ method: 'wallet/getpaginatedassetissuelist', params: { limit: 2 } })
      // @ts-expect-error A misspelled field is not a new optional parameter.
      provider.request({ method: 'wallet/getblock', params: { details: true } })
      provider.request({
        method: 'wallet/triggersmartcontract',
        // @ts-expect-error An ordinary trigger needs the destination contract.
        params: { owner_address: 'address', data: '6000' },
      })
      // @ts-expect-error Integer fields do not accept booleans.
      provider.request({ method: 'wallet/getblockbylatestnum', params: { num: true } })
      provider.request({
        method: 'wallet/createCommonTransaction',
        // @ts-expect-error Contract-specific fields follow contractType.
        params: { contractType: 'TransferContract', owner_address: 'address' },
      })
      provider.request({
        method: 'wallet/accountpermissionupdate',
        // @ts-expect-error Known methods do not accept arbitrary nested permission values.
        params: { owner_address: 'address', owner: { threshold: false } },
      })
    }
    assert.isFunction(check)
    const params = {
      owner_address: 'address',
      frozen_balance: 1_000_000n,
    } satisfies ProviderMethodParams<'wallet/freezebalancev2'>
    expectTypeOf(params.frozen_balance).toEqualTypeOf<bigint>()
    expectTypeOf<ProviderRequest<'wallet/getaccount'>>().toMatchTypeOf<{
      params?: { address?: string }
    }>()
    expectTypeOf<ProviderResult<'wallet/cancelallunfreezev2'>>().toEqualTypeOf<
      TransactionBuildResult<'CancelAllUnfreezeV2Contract'>
    >()
    expectTypeOf<
      ProviderResult<'wallet/createCommonTransaction', 'TransferContract'>
    >().toEqualTypeOf<TransactionBuildResult<'TransferContract'>>()
    expectTypeOf<
      ProviderResult<'wallet/createCommonTransaction'>
    >().toEqualTypeOf<TransactionBuildResult>()
    expectTypeOf<AccountPermission['threshold']>().toEqualTypeOf<bigint | undefined>()
    const narrow = (transaction: TronTransaction) => {
      const contract = transaction.raw_data.contract[0]
      if (contract.type === 'TransferAssetContract') {
        expectTypeOf(contract.parameter.value.asset_name).toEqualTypeOf<string | undefined>()
        expectTypeOf(contract.parameter.value.amount).toEqualTypeOf<number | bigint | undefined>()
        // @ts-expect-error This contract does not carry deployment bytecode.
        contract.parameter.value.new_contract
      }
    }
    assert.isFunction(narrow)
    const inspect = (echo: TransactionEcho) => {
      // @ts-expect-error Signature inspection can omit a missing or zero timestamp.
      echo.raw_data.timestamp.toFixed(0)
      // @ts-expect-error Protocol transaction echoes can contain contracts without an actuator.
      const supported: ContractName = echo.raw_data.contract[0].type
      return supported
    }
    assert.isFunction(inspect)
    expectTypeOf<TronTransaction['raw_data']['timestamp']>().toEqualTypeOf<number>()
  })

  it('infers common-builder results from their contract type', async () => {
    const { TronWeb } = await import('tronweb')
    const provider = new TronProvider(await TronNode.create())
    const keys = (await provider.node.admin.accounts()).privateKeys
    const addresses = keys.map((key) =>
      TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string),
    )
    const built = await provider.request({
      method: 'wallet/createCommonTransaction',
      params: {
        contractType: 'TransferContract',
        owner_address: addresses[0],
        to_address: addresses[1],
        amount: 1,
      },
    })
    expectTypeOf(built).toEqualTypeOf<TransactionBuildResult<'TransferContract'>>()
    if ('Error' in built) throw new Error(built.Error)
    assert.strictEqual(built.raw_data.contract[0].parameter.value.amount, 1)
    const account = await provider.request({
      method: 'wallet/createCommonTransaction',
      params: { contractType: 'AccountUpdateContract', owner_address: addresses[0] },
    })
    expectTypeOf(account).toEqualTypeOf<TransactionBuildResult<'AccountUpdateContract'>>()
    if ('Error' in account) throw new Error(account.Error)
    assert.strictEqual(account.raw_data.contract[0].type, 'AccountUpdateContract')
    const checkUnion = (params: CommonTransactionParams) => {
      const result = provider.request({ method: 'wallet/createCommonTransaction', params })
      expectTypeOf(result).toEqualTypeOf<Promise<TransactionBuildResult>>()
    }
    assert.isFunction(checkUnion)
  })

  for (const method of ['wallet/getsignweight', 'wallet/getapprovedlist'] as const) {
    it(`${method} describes incomplete and unsupported protocol transaction echoes`, async () => {
      const provider = new TronProvider(await TronNode.create())
      for (const raw_data of [
        { contract: [] },
        { contract: [], timestamp: 0, expiration: 0, ref_block_bytes: '', ref_block_hash: '' },
      ]) {
        const reply = await provider.request({ method, params: { raw_data } })
        assert.isDefined(reply.transaction)
        const echoed = reply.transaction!.transaction
        assert.deepEqual(echoed.raw_data, { contract: [] })
        expectTypeOf(echoed.raw_data.timestamp).toEqualTypeOf<number | undefined>()
        assert.isUndefined(echoed.raw_data.timestamp?.toFixed(0))
        assert.isString(echoed.txID)
        assert.isString(echoed.raw_data_hex)
      }
      const reply = await provider.request({
        method,
        params: {
          raw_data: {
            timestamp: 123,
            contract: [
              {
                type: 'VoteWitnessContract',
                parameter: { value: { votes: [] } },
              },
            ],
          },
        },
      })
      assert.isDefined(reply.transaction)
      const raw = reply.transaction!.transaction.raw_data
      assert.strictEqual(raw.timestamp?.toFixed(0), '123')
      const contract = raw.contract[0]
      expectTypeOf(contract.type).toEqualTypeOf<string>()
      assert.strictEqual(contract.type, 'VoteWitnessContract')
      assert.strictEqual(
        contract.parameter.type_url,
        'type.googleapis.com/protocol.VoteWitnessContract',
      )
      assert.notProperty(contract.parameter, 'value')
    })
  }

  it('constructs unsigned deployment skeletons with omitted params or owner', async () => {
    const provider = new TronProvider(await TronNode.create())
    for (const transaction of [
      await provider.request({ method: 'wallet/deploycontract' }),
      await provider.request({ method: 'wallet/deploycontract', params: {} }),
    ]) {
      if ('Error' in transaction) throw new Error(transaction.Error)
      const contract = transaction.raw_data.contract[0]
      assert.strictEqual(contract.type, 'CreateSmartContract')
      assert.notProperty(contract.parameter.value, 'owner_address')
    }
  })

  it('matches program defaults, empty results, and address/integer normalization', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const head = await provider.request({ method: 'wallet/getnowblock' })
    assert.isArray(head.transactions)
    const compact = await provider.request({ method: 'wallet/getblock' })
    assert.strictEqual(compact.blockID, head.blockID)
    assert.notProperty(compact, 'transactions')
    const genesis = await provider.request({ method: 'wallet/getblockbynum' })
    assert.strictEqual(genesis.block_header?.raw_data.number, 0)
    for (const method of [
      'wallet/getblockbylatestnum',
      'walletsolidity/getblockbylatestnum',
    ] as const) {
      const blocks = await provider.request({ method, params: { num: '0x2' } })
      expectTypeOf(blocks).toEqualTypeOf<BlockList>()
      assert.lengthOf(blocks.block!, 2)
      assert.notProperty(blocks.block![0].block_header!.raw_data, 'number')
      assert.notProperty(blocks.block![0], 'transactions')
    }
    const witnesses = await provider.request({
      method: 'walletsolidity/getpaginatednowwitnesslist',
      params: { offset: 0n, limit: '0x1' },
    })
    assert.lengthOf(witnesses.witnesses!, 1)
    assert.deepEqual(await provider.request({ method: 'wallet/getaccount' }), {})
    assert.deepEqual(await provider.request({ method: 'wallet/gettransactionbyid' }), {})
    assert.deepEqual(await provider.request({ method: 'wallet/getassetissuelist' }), {})
    assert.deepEqual(await provider.request({ method: 'wallet/getassetissuebyname' }), {})
    assert.deepEqual(await provider.request({ method: 'wallet/getReward' }), { reward: 0n })
    assert.deepEqual(await provider.request({ method: 'wallet/getBrokerage' }), { brokerage: 0 })
    assert.deepEqual(await provider.request({ method: 'net/listnodes' }), { nodes: [] })
    assert.strictEqual(await provider.request({ method: 'healthcheck' }), 'OK')
  })

  it('retains concrete account, permission, and receipt types through a transfer', async () => {
    const { TronWeb, utils } = await import('tronweb')
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const addresses = privateKeys.map((key) => TronWeb.address.fromPrivateKey(key) as string)
    const transaction = await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: addresses[0], to_address: addresses[1], amount: '0x1' },
    })
    if ('Error' in transaction) throw new Error(transaction.Error)
    const sent = await provider.request({
      method: 'wallet/broadcasttransaction',
      params: utils.crypto.signTransaction(privateKeys[0], transaction),
    })
    assert.isTrue(sent.result)
    const account = await provider.request({
      method: 'walletsolidity/getaccount',
      params: { address: addresses[1] },
    })
    expectTypeOf(account.balance).toEqualTypeOf<bigint | undefined>()
    assert.strictEqual(typeof account.balance, 'bigint')
    assert.strictEqual(account.owner_permission?.keys?.[0].weight, 1n)
    const receipt = await provider.request({
      method: 'wallet/gettransactionreceiptbyid',
      params: { value: transaction.txID },
    })
    expectTypeOf(receipt.Receipt?.net_usage).toEqualTypeOf<number | undefined>()
    assert.isNumber(receipt.Receipt?.net_usage)
    const info = await provider.request({
      method: 'wallet/gettransactioninfobyid',
      params: { value: transaction.txID },
    })
    expectTypeOf(info.fee).toEqualTypeOf<bigint | undefined>()
    assert.strictEqual(info.fee, 0n)
  })

  it('allows deployment bytecode to be omitted when deploying an empty contract', async () => {
    const { TronWeb, utils } = await import('tronweb')
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const key = (await node.admin.accounts()).privateKeys[0]
    const transaction = await provider.request({
      method: 'wallet/deploycontract',
      params: {
        owner_address: TronWeb.address.fromPrivateKey(key) as string,
        origin_energy_limit: 1,
        fee_limit: 100_000_000,
      },
    })
    if ('Error' in transaction) throw new Error(transaction.Error)
    assert.notProperty(transaction.raw_data.contract[0].parameter.value.new_contract, 'bytecode')
    const sent = await provider.request({
      method: 'wallet/broadcasttransaction',
      params: utils.crypto.signTransaction(key, transaction),
    })
    assert.isTrue(sent.result)
  })
})
