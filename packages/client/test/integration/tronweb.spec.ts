import { connect } from 'node:net'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, afterAll, beforeAll, describe, expect, it } from 'vitest'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

import type { Server } from 'node:http'

const RUNTIME_CODE =
  '0x6080604052348015600f57600080fd5b506004361060285760003560e01c80632ddbd13a14602d575b600080fd5b60336047565b604051603e9190604d565b60405180910390f35b60005481565b9081526020019056fea2646970667358221220c51fe6383da9d6d3eb400e2da0740e3bbcb4e1834682da9388000d75ec81741564736f6c63430008000033'

const TOTAL_ABI = [
  {
    inputs: [],
    name: 'total',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
]

describe('TronWeb against @tvmjs/client over HTTP', () => {
  const config = resolveConfig()
  let node: TronNode
  let server: Server
  let tronWeb: TronWeb
  let baseUrl = ''
  // a contract installed via cheat methods, exercised via the REST surface
  const contractBase58 = utils.accounts.generateAccount().address.base58

  beforeAll(async () => {
    node = await TronNode.create(config)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    tronWeb = new TronWeb({
      fullHost: started.url,
      privateKey: accountsFromMnemonic(config.mnemonic)[0].privateKey,
    })

    const contract = parseTronAddress(contractBase58)
    await nodeCore(node).setCode(contract, hexToBytes(RUNTIME_CODE))
    await nodeCore(node).setStorage(
      contract,
      hexToBytes(`0x${'00'.repeat(32)}`),
      hexToBytes('0x01'),
    )
  })

  afterAll(() => {
    server.close()
  })

  it('getCurrentBlock returns the current head (chain starts at height 1)', async () => {
    const block = await tronWeb.trx.getCurrentBlock()
    assert.strictEqual(block.block_header.raw_data.number, 1)
    assert.strictEqual(block.blockID.length, 64)
  })

  it('getBalance reads prefunded and empty accounts (walletsolidity route)', async () => {
    const funded = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    assert.strictEqual(
      await tronWeb.trx.getBalance(funded),
      Number(accountsFromMnemonic(config.mnemonic)[0].balance),
    )

    const empty = utils.accounts.generateAccount().address.base58
    assert.strictEqual(await tronWeb.trx.getBalance(empty), 0)
  })

  it('contract(abi, address).total().call() goes through triggerconstantcontract', async () => {
    const instance = tronWeb.contract(TOTAL_ABI, contractBase58)
    const total = await instance.total().call()
    assert.strictEqual(total, 1n)
  })

  it('estimateEnergy reports energy for a view call', async () => {
    const result = await tronWeb.transactionBuilder.estimateEnergy(
      contractBase58,
      'total()',
      {},
      [],
    )
    assert.isTrue(result.result.result)
    assert.strictEqual(result.energy_required, 496)
  })

  it('a reverting constant call reports the runtime message and a FAILED ret', async () => {
    const reverting = utils.accounts.generateAccount().address.base58
    const caller = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    await fetch(`${baseUrl}/tre`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tre_setAccountCode',
        params: [reverting, '0x60006000fd'],
      }),
    })

    // TronWeb turns the wire's revert message into a thrown error
    await expect(
      tronWeb.transactionBuilder.triggerConstantContract(
        TronWeb.address.toHex(reverting),
        'x()',
        {},
        [],
        TronWeb.address.toHex(caller),
      ),
    ).rejects.toThrow(/REVERT opcode executed/)

    const call = (await fetch(`${baseUrl}/wallet/triggerconstantcontract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner_address: TronWeb.address.toHex(caller),
        contract_address: TronWeb.address.toHex(reverting),
        function_selector: 'x()',
      }),
    }).then((response) => response.json())) as {
      result: { result: boolean; message?: string }
      transaction: { ret?: { ret: string }[] }
      constant_result: string[]
    }
    // the call itself was served, so result stays true — the failure shows up
    // as the runtime message plus a FAILED ret on the embedded transaction
    assert.isTrue(call.result.result)
    assert.strictEqual(TronWeb.toUtf8(call.result.message as string), 'REVERT opcode executed')
    assert.deepEqual(call.transaction.ret, [{ ret: 'FAILED' }])
    assert.deepEqual(call.constant_result, [''])

    const estimate = (await fetch(`${baseUrl}/wallet/estimateenergy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner_address: TronWeb.address.toHex(caller),
        contract_address: TronWeb.address.toHex(reverting),
        function_selector: 'x()',
      }),
    }).then((response) => response.json())) as {
      result: { result?: boolean; code?: string; message?: string }
      energy_required?: number
    }
    // a call that cannot succeed has no estimate to give
    assert.strictEqual(estimate.result.code, 'CONTRACT_EXE_ERROR')
    assert.isUndefined(estimate.energy_required)
    assert.isUndefined(estimate.result.result)
  })

  it('carries constant-call extra_data into its echoed transaction', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    for (const path of [
      'wallet/triggerconstantcontract',
      'walletsolidity/triggerconstantcontract',
    ]) {
      const reply = (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner_address: owner,
            contract_address: contractBase58,
            extra_data: 'hi',
            visible: true,
          }),
        })
      ).json()) as { transaction: { raw_data: { data?: unknown } } }
      assert.strictEqual(reply.transaction.raw_data.data, '6869')
    }
  })

  it('triggerconstantcontract on a non-contract address raises a validate error', async () => {
    const empty = utils.accounts.generateAccount().address.base58
    await expect(
      tronWeb.transactionBuilder.triggerConstantContract(empty, 'total()', {}, []),
    ).rejects.toThrow(/Smart contract is not exist/)
  })

  it('getBlockByNumber / getBlock work after mining', async () => {
    await node.tre.mine(2)
    const block2 = await tronWeb.trx.getBlockByNumber(2)
    assert.strictEqual(block2.block_header.raw_data.number, 2)

    const byHash = await tronWeb.trx.getBlockByHash(block2.blockID)
    assert.strictEqual(byHash.block_header.raw_data.number, 2)
  })

  it('full and Solidity block reads select and serialize the same records', async () => {
    await node.tre.mine(1)
    const get = async (path: string): Promise<Record<string, unknown>> =>
      (await (await fetch(`${baseUrl}/${path}`)).json()) as Record<string, unknown>
    const head = (await get('wallet/getnowblock?visible=true')) as {
      blockID?: string
      block_header?: { raw_data?: { number?: number } }
    }
    const number = head.block_header?.raw_data?.number
    assert.isString(head.blockID)
    if (typeof number !== 'number') throw new Error('head block number is missing')
    if (typeof head.blockID !== 'string') throw new Error('head block id is missing')
    const start = Math.max(0, number - 1)
    const requests = [
      'getnowblock?visible=true',
      `getblock?id_or_num=${number}&detail=true&visible=true`,
      `getblockbyid?value=${head.blockID}&visible=true`,
      `getblockbynum?num=${number}&visible=true`,
      'getblockbylatestnum?num=2&visible=true',
      `getblockbylimitnext?startNum=${start}&endNum=${number + 1}&visible=true`,
    ]
    for (const request of requests) {
      assert.deepEqual(
        await get(`walletsolidity/${request}`),
        await get(`wallet/${request}`),
        request,
      )
    }
  })

  it('getCurrentRefBlockParams derives ref block fields (write-path precondition)', async () => {
    const params = await tronWeb.trx.getCurrentRefBlockParams()
    assert.strictEqual(params.ref_block_bytes.length, 4)
    assert.strictEqual(params.ref_block_hash.length, 16)
    assert.isAbove(params.expiration, 0)
  })

  it('getContractInfo exposes runtimecode', async () => {
    const info = await tronWeb.trx.getContractInfo(contractBase58)
    assert.strictEqual(`0x${(info as { runtimecode?: string }).runtimecode ?? ''}`, RUNTIME_CODE)
  })

  it('getNodeInfo / getChainParameters respond', async () => {
    const nodeInfo = await tronWeb.trx.getNodeInfo()
    assert.strictEqual(nodeInfo.configNodeInfo.codeVersion, '4.8.2')
    assert.strictEqual((nodeInfo.configNodeInfo as Record<string, unknown>).versionNum, '18817')

    const chainParams = await tronWeb.trx.getChainParameters()
    const energyFee = chainParams.find((p: { key: string }) => p.key === 'getEnergyFee')
    assert.strictEqual(energyFee?.value, config.chainParameters.energyFee)
  })

  it('a non-REVERT runtime failure drops the success shape entirely', async () => {
    const bad = utils.accounts.generateAccount().address.base58
    const caller = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    // 0xfe is the designated invalid instruction
    await nodeCore(node).setCode(parseTronAddress(bad), hexToBytes('0xfe'))

    const call = (await fetch(`${baseUrl}/wallet/triggerconstantcontract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner_address: TronWeb.address.toHex(caller),
        contract_address: TronWeb.address.toHex(bad),
        function_selector: 'x()',
      }),
    }).then((response) => response.json())) as Record<string, unknown>

    assert.deepEqual(Object.keys(call), ['result'])
    const outcome = call.result as { code?: string; message?: string }
    assert.strictEqual(outcome.code, 'OTHER_ERROR')
    // the message names what actually stopped execution: the interpreter's own
    // exception, not a revert
    assert.strictEqual(TronWeb.toUtf8(outcome.message ?? ''), 'invalid opcode')
  })

  it('bandwidth is billed over the signed transaction plus the result allowance', async () => {
    const receiver = utils.accounts.generateAccount().address.base58
    const sender = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[1].privateKey,
    ) as string
    const web = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[1].privateKey,
    })
    await nodeCore(node).setBalance(parseTronAddress(receiver), 1n) // exists: per-byte billing, not the flat fee

    const signed = await web.trx.sign(await web.transactionBuilder.sendTrx(receiver, 1000, sender))
    await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    })
    const info = (await web.trx.getTransactionInfo(signed.txID)) as unknown as {
      receipt?: { net_usage?: number }
    }
    // raw_data bytes + a 65-byte signature + envelope, then 64 per contract
    const rawBytes = signed.raw_data_hex.length / 2
    assert.isAbove(info.receipt?.net_usage ?? 0, rawBytes + 64)
  })

  it('the zero-value endpoints answer instead of going missing', async () => {
    const get = async (path: string): Promise<Record<string, unknown>> =>
      (await (await fetch(`${baseUrl}/${path}`)).json()) as Record<string, unknown>

    assert.deepEqual(await get('wallet/getReward?address=41'), { reward: 0 })
    assert.deepEqual(await get('wallet/getpendingsize'), { pendingSize: 0 })
    // without a known account there is no slot count to report
    assert.deepEqual(await get('wallet/getavailableunfreezecount'), {})
    const owner0 = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    assert.deepEqual(
      await get(`wallet/getavailableunfreezecount?owner_address=${owner0}&visible=true`),
      {
        count: 32,
      },
    )
    assert.deepEqual(await get('wallet/listproposals'), {})
    assert.deepEqual(await get('wallet/listexchanges'), {})
    // the transaction-store counter is a deprecated stub fixed at zero
    assert.deepEqual(await get('wallet/totaltransaction'), {})
    // nothing is staked here, so the v1 delegation reads have nothing to index
    assert.deepEqual(await get('wallet/getdelegatedresource'), {})
    assert.deepEqual(await get('wallet/getdelegatedresourceaccountindex'), {})
    // the solidity mirrors come along for free
    assert.deepEqual(await get('walletsolidity/getReward?address=41'), { reward: 0 })

    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    assert.deepEqual(await get(`wallet/validateaddress?address=${owner}`), {
      result: true,
      message: 'Base58check format',
    })
    // length decides the encoding before anything is decoded
    assert.deepEqual(await get('wallet/validateaddress?address=nonsense'), {
      result: false,
      message: 'Length error',
    })
    const badChecksum = `${owner.slice(0, 33)}${owner[33] === 'a' ? 'b' : 'a'}`
    assert.deepEqual(await get(`wallet/validateaddress?address=${badChecksum}`), {
      result: false,
      message: 'Invalid address',
    })
  })

  it('visible=true prints log addresses and resMessage as text', async () => {
    const reverting = utils.accounts.generateAccount().address.base58
    const sender = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[1].privateKey,
    ) as string
    const web = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[1].privateKey,
    })
    await nodeCore(node).setCode(parseTronAddress(reverting), hexToBytes('0x60006000fd'))

    const built = await web.transactionBuilder.triggerSmartContract(
      TronWeb.address.toHex(reverting),
      'x()',
      { feeLimit: 10_000_000, callValue: 0 },
      [],
      TronWeb.address.toHex(sender),
    )
    const signed = await web.trx.sign(built.transaction)
    await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    })

    const info = (await (
      await fetch(`${baseUrl}/wallet/gettransactioninfobyid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: signed.txID, visible: true }),
      })
    ).json()) as { resMessage?: string; result?: string; receipt?: { result?: string } }
    // the receipt names the VM outcome, the info names the transaction outcome
    assert.strictEqual(info.receipt?.result, 'REVERT')
    assert.strictEqual(info.result, 'FAILED')
    // plain text under visible=true, not the hex form
    assert.strictEqual(info.resMessage, 'REVERT opcode executed')
  })

  it('range queries refuse out-of-bounds spans instead of clamping', async () => {
    const get = async (path: string): Promise<Record<string, unknown>> =>
      (await (await fetch(`${baseUrl}/${path}`)).json()) as Record<string, unknown>

    assert.deepEqual(await get('wallet/getblockbylatestnum?num=0'), {})
    assert.deepEqual(await get('wallet/getblockbylatestnum?num=100'), {})
    assert.isDefined((await get('wallet/getblockbylatestnum?num=1')).block)

    assert.deepEqual(await get('wallet/getblockbylimitnext?startNum=5&endNum=1'), {})
    assert.deepEqual(await get('wallet/getblockbylimitnext?startNum=0&endNum=200'), {})
    // an in-range span with nothing in it still reports the empty list
    assert.deepEqual(await get('wallet/getblockbylimitnext?startNum=900&endNum=910'), { block: [] })

    // numeric fields: absent and unparseable
    // both raise, rather than degrading to zero
    assert.strictEqual((await get('wallet/getblockbylimitnext')).Error, 'Cannot parse null string')
    assert.strictEqual((await get('wallet/getblockbynum?num=')).Error, 'For input string: ""')
    // an absent height is height zero, not an error
    assert.isDefined((await get('wallet/getblockbynum')).block_header)

    // hex fields accept 0x and odd lengths, and reject non-hex
    assert.strictEqual(
      (await get('wallet/getblockbyid?value=zz')).Error,
      'exception decoding Hex string: invalid characters encountered in Hex string',
    )

    assert.strictEqual(
      (await get('wallet/getblock?id_or_num=-1')).Error,
      'num must be non-positive number.',
    )
    assert.strictEqual(
      (await get('wallet/getblock?id_or_num=abc')).Error,
      'id must be legal block hash.',
    )
  })

  it('the block header reports the protocol version', async () => {
    const block = await tronWeb.trx.getCurrentBlock()
    assert.strictEqual(block.block_header.raw_data.version, 36)
  })

  it('a contract account is typed and carries no permissions', async () => {
    const account = (await tronWeb.trx.getAccount(contractBase58)) as unknown as Record<
      string,
      unknown
    >
    assert.strictEqual(account.type, 'Contract')
    assert.isUndefined(account.owner_permission)
    assert.isUndefined(account.active_permission)
  })

  it('txid lookups accept either case and a 0x prefix', async () => {
    const receiver = utils.accounts.generateAccount().address.base58
    const web = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[1].privateKey,
    })
    const sender = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[1].privateKey,
    ) as string
    const signed = await web.trx.sign(await web.transactionBuilder.sendTrx(receiver, 1000, sender))
    await fetch(`${baseUrl}/wallet/broadcasttransaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    })

    const byId = async (
      value: string,
      path = 'wallet/gettransactionbyid',
    ): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value }),
        })
      ).json()) as Record<string, unknown>

    assert.strictEqual((await byId(signed.txID)).txID, signed.txID)
    assert.strictEqual((await byId(signed.txID.toUpperCase())).txID, signed.txID)
    assert.strictEqual((await byId(`0x${signed.txID}`)).txID, signed.txID)
    assert.strictEqual(
      (await byId(signed.txID, 'walletsolidity/gettransactionbyid')).txID,
      signed.txID,
    )

    const info = async (path: string): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: signed.txID }),
        })
      ).json()) as Record<string, unknown>
    assert.strictEqual((await info('wallet/gettransactioninfobyid')).id, signed.txID)
    assert.strictEqual((await info('walletsolidity/gettransactioninfobyid')).id, signed.txID)

    const blockNumber = Number((await info('wallet/gettransactioninfobyid')).blockNumber)
    const byBlock = async (path: string): Promise<unknown> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ num: blockNumber }),
        })
      ).json()) as unknown
    for (const path of [
      'wallet/gettransactioninfobyblocknum',
      'walletsolidity/gettransactioninfobyblocknum',
    ]) {
      assert.strictEqual(((await byBlock(path)) as { id?: string }[])[0]?.id, signed.txID)
    }
    for (const path of [
      'wallet/gettransactioncountbyblocknum',
      'walletsolidity/gettransactioncountbyblocknum',
    ]) {
      assert.deepEqual(await byBlock(path), { count: 1 })
    }

    // the receipt view prints only the receipt sub-message, capitalised
    const receipt = (await (
      await fetch(`${baseUrl}/wallet/gettransactionreceiptbyid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: signed.txID }),
      })
    ).json()) as { Receipt?: Record<string, unknown> }
    assert.deepEqual(Object.keys(receipt), ['Receipt'])
    // a fresh receiver means the flat create fee, so net_fee rather than net_usage
    assert.deepEqual(receipt.Receipt, { net_fee: 100_000 })
  })

  it('getchainparameters keeps the baseline key order', async () => {
    const params = (await tronWeb.trx.getChainParameters()) as { key: string }[]
    assert.strictEqual(params[0]?.key, 'getMaintenanceTimeInterval')
    assert.strictEqual(params[1]?.key, 'getAccountUpgradeCost')
    assert.strictEqual(params[2]?.key, 'getCreateAccountFee')
  })

  it('an absent address finds nothing; a malformed one fails the merge', async () => {
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>

    for (const path of ['wallet/getaccount', 'wallet/getaccountnet', 'wallet/getaccountresource']) {
      assert.deepEqual(await post(path, {}), {}, path)
    }

    const broken = await post('wallet/getaccount', { address: 'nonsense', visible: true })
    assert.strictEqual(broken.Error, '1:12: invalid address for field: protocol.Account.address')
  })

  it('planted code looks the same across all three contract views', async () => {
    const planted = utils.accounts.generateAccount().address.base58
    await nodeCore(node).setCode(parseTronAddress(planted), hexToBytes('0x6001600155'))

    const account = (await tronWeb.trx.getAccount(planted)) as unknown as { type?: string }
    assert.strictEqual(account.type, 'Contract')

    const contract = (await tronWeb.trx.getContract(planted)) as unknown as {
      contract_address?: string
    }
    assert.isDefined(contract.contract_address)

    const info = (await tronWeb.trx.getContractInfo(planted)) as unknown as {
      runtimecode?: string
      smart_contract?: { contract_address?: string }
    }
    assert.strictEqual(info.runtimecode, '6001600155')
    assert.isDefined(info.smart_contract?.contract_address)

    // planting is not undone by clearing the code: the account stays a
    // contract account and keeps its record, whose hash follows the code
    await nodeCore(node).setCode(parseTronAddress(planted), new Uint8Array())
    const cleared = (await tronWeb.trx.getContract(planted)) as unknown as {
      contract_address?: string
      code_hash?: string
    }
    assert.isDefined(cleared.contract_address)
    // keccak256 of no bytes at all
    assert.strictEqual(
      cleared.code_hash,
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    )
    assert.strictEqual(
      ((await tronWeb.trx.getAccount(planted)) as unknown as { type?: string }).type,
      'Contract',
    )
    assert.isUndefined(
      ((await tronWeb.trx.getContractInfo(planted)) as unknown as { runtimecode?: string })
        .runtimecode,
    )
  })

  it('a failed deploy leaves nothing behind, even while reads flush state', async () => {
    const sender = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[1].privateKey,
    ) as string
    const web = new TronWeb({
      fullHost: baseUrl,
      privateKey: accountsFromMnemonic(config.mnemonic)[1].privateKey,
    })

    // a constructor that always reverts
    const built = (await web.transactionBuilder.createSmartContract(
      { abi: [], bytecode: '0x60006000fd', feeLimit: 100_000_000 },
      sender,
    )) as unknown as { contract_address: string; txID: string }
    const predicted = parseTronAddress(built.contract_address)

    // a read that computes a state root, racing the deploy
    const rootReads = Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${baseUrl}/wallet/triggerconstantcontract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner_address: TronWeb.address.toHex(sender),
            contract_address: TronWeb.address.toHex(contractBase58),
            function_selector: 'total()',
          }),
        }),
      ),
    )
    const broadcast = fetch(`${baseUrl}/wallet/broadcasttransaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await web.trx.sign(built as never)),
    })
    await Promise.all([rootReads, broadcast])

    // the revert must have left no code and no contract record
    assert.strictEqual((await nodeCore(node).getCode(predicted)).length, 0)
    assert.deepEqual(await tronWeb.trx.getContract(built.contract_address), {})
  })

  it('parser failures report the fault, not this node internals', async () => {
    const get = async (path: string): Promise<{ Error?: string }> =>
      (await (await fetch(`${baseUrl}/${path}`)).json()) as { Error?: string }

    assert.strictEqual(
      (await get('wallet/getblockbylatestnum?num=abc')).Error,
      'For input string: "abc"',
    )

    const post = async (body: unknown): Promise<{ Error?: string }> =>
      (await (
        await fetch(`${baseUrl}/wallet/broadcasthex`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as { Error?: string }

    assert.strictEqual(
      (await post({ transaction: 'zz-not-hex' })).Error,
      'exception decoding Hex string: invalid characters encountered in Hex string',
    )
    assert.match(
      (await post({ transaction: 'deadbeef' })).Error ?? '',
      /^While parsing a protocol message, /,
    )
  })

  it('the block header prints its fields in protobuf order', async () => {
    const block = (await (await fetch(`${baseUrl}/wallet/getblockbynum?num=1`)).json()) as {
      block_header: { raw_data: Record<string, unknown> }
    }
    assert.deepEqual(Object.keys(block.block_header.raw_data), [
      'timestamp',
      'txTrieRoot',
      'parentHash',
      'number',
      'witness_address',
      'version',
    ])
  })

  it('separates an unimplemented endpoint from a path that does not exist', async () => {
    // the balance traces these read are only recorded under
    // history-balance-lookup, which no deployment enables — the reply is
    // empty everywhere
    const missing = await fetch(`${baseUrl}/wallet/getblockbalance`, {
      method: 'POST',
      body: '{}',
    })
    assert.strictEqual(missing.status, 501)
    assert.deepEqual(await missing.json(), {
      Error: 'wallet/getblockbalance is not implemented',
    })

    // wallet paths are case-sensitive, so the lower-case spelling is no route
    const wrongCase = await fetch(`${baseUrl}/wallet/getbrokerage`)
    assert.strictEqual(wrongCase.status, 404)
    assert.deepEqual(await wrongCase.json(), { Error: 'wallet/getbrokerage not found' })

    // the correctly-spelled route is served and answers the chain default
    assert.strictEqual(await tronWeb.trx.getBrokerage(contractBase58), 20)

    // The delegation store accepts byte keys without an address-length check.
    // A short but decodable key is a store miss, so both views return its
    // default brokerage instead of rejecting the request.
    for (const path of ['wallet/getBrokerage', 'walletsolidity/getBrokerage']) {
      assert.deepEqual(await (await fetch(`${baseUrl}/${path}?address=4111`)).json(), {
        brokerage: 20,
      })
    }
  })

  it('dispatches HTTP methods per endpoint the way the servlets declare them', async () => {
    // doGet is an empty override on the transaction builders: 200, no body
    const stub = await fetch(`${baseUrl}/wallet/createtransaction?owner_address=41&amount=1`)
    assert.strictEqual(stub.status, 200)
    assert.strictEqual(await stub.text(), '')

    // broadcast declares doPost only
    assert.strictEqual((await fetch(`${baseUrl}/wallet/broadcasttransaction`)).status, 405)

    const options = await fetch(`${baseUrl}/wallet/getnowblock`, { method: 'OPTIONS' })
    assert.strictEqual(options.status, 200)
    assert.strictEqual(options.headers.get('allow'), 'GET, HEAD, POST, TRACE, OPTIONS')
    const postOnly = await fetch(`${baseUrl}/wallet/broadcasttransaction`, { method: 'OPTIONS' })
    assert.strictEqual(postOnly.headers.get('allow'), 'POST, TRACE, OPTIONS')

    assert.strictEqual(
      (await fetch(`${baseUrl}/wallet/getnowblock`, { method: 'PUT' })).status,
      405,
    )
    assert.strictEqual(
      (await fetch(`${baseUrl}/wallet/getnowblock`, { method: 'PATCH' })).status,
      501,
    )

    // a path no route claims still goes through the method table: the
    // not-found servlet declares doGet alone, so a GET is 404 and a POST is 405
    const unclaimed = `${baseUrl}/wallet/nosuchroute`
    assert.strictEqual((await fetch(unclaimed)).status, 404)
    assert.strictEqual((await fetch(unclaimed, { method: 'PUT' })).status, 405)
    assert.strictEqual((await fetch(unclaimed, { method: 'PATCH' })).status, 501)
    const unclaimedOptions = await fetch(unclaimed, { method: 'OPTIONS' })
    assert.strictEqual(unclaimedOptions.headers.get('allow'), 'GET, HEAD, TRACE, OPTIONS')
    assert.isNull(unclaimedOptions.headers.get('content-type'))

    const unclaimedPost = await fetch(unclaimed, { method: 'POST', body: '{}' })
    assert.strictEqual(unclaimedPost.status, 405)
    assert.deepEqual(JSON.parse(await unclaimedPost.text()), {
      servlet: '@tvmjs/client:404',
      message: 'HTTP method POST is not supported by this URL',
      url: '/wallet/nosuchroute',
      status: '405',
    })
  })

  it('escapes request paths in method-error responses', async () => {
    for (const namespace of ['wallet', 'admin']) {
      for (const suffix of [
        'missing"route',
        'missing\\route',
        'missing\nroute',
        'missing\troute',
      ]) {
        const path = `${namespace}/${suffix}`
        const response = await fetch(`${baseUrl}/${namespace}/${encodeURIComponent(suffix)}`, {
          method: 'POST',
          body: '{}',
        })
        assert.strictEqual(response.status, 405)
        assert.strictEqual(response.headers.get('content-type'), 'application/json')
        assert.deepEqual(await response.json(), {
          servlet: `@tvmjs/client:${namespace === 'wallet' ? '404' : path}`,
          message: 'HTTP method POST is not supported by this URL',
          url: `/${path}`,
          status: '405',
        })
      }
    }
  })

  it('reads POST parameters from the body only, and GET from the query only', async () => {
    const ownerBase58 = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const query = `address=${ownerBase58}&visible=true`

    const viaQuery = await fetch(`${baseUrl}/wallet/getaccount?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    // the query string never reaches a POST handler, so no account comes back
    assert.isUndefined(((await viaQuery.json()) as Record<string, unknown>).address)

    const viaBody = await fetch(`${baseUrl}/wallet/getaccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: ownerBase58, visible: true }),
    })
    assert.isDefined(((await viaBody.json()) as Record<string, unknown>).address)

    // form bodies are decoded as URL-encoded pairs, same as the JSON form
    const viaForm = await fetch(`${baseUrl}/wallet/getaccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: query,
    })
    assert.isDefined(((await viaForm.json()) as Record<string, unknown>).address)
  })

  it('accepts every Account merge field that the handler does not otherwise read', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const reply = (await (
      await fetch(`${baseUrl}/wallet/getaccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: owner,
          visible: true,
          // The reference parses protobuf map fields as repeated generated
          // entry messages.  These fields do not select the account, but a
          // valid request must not be rejected before the address is read.
          asset: [{ key: 'a', value: 1 }],
          assetV2: [{ key: '1000001', value: 2 }],
          latest_asset_operation_time: [{ key: 'a', value: 3 }],
          latest_asset_operation_timeV2: [{ key: '1000001', value: 4 }],
          free_asset_net_usage: [{ key: 'a', value: 5 }],
          free_asset_net_usageV2: [{ key: '1000001', value: 6 }],
          votes: [{ vote_address: owner, vote_count: 1 }],
          frozen: [{ frozen_balance: 10, expire_time: 11 }],
          tron_power: { frozen_balance: 12, expire_time: 13 },
          frozen_supply: [{ frozen_balance: 14, expire_time: 15 }],
          account_resource: {
            frozen_balance_for_energy: { frozen_balance: 16, expire_time: 17 },
          },
          owner_permission: {
            type: 'Owner',
            id: 0,
            permission_name: 'owner',
            threshold: 1,
            parent_id: 0,
            operations: '',
            keys: [{ address: owner, weight: 1 }],
          },
          witness_permission: { type: 'Witness' },
          active_permission: [{ type: 'Active', id: 2 }],
          frozenV2: [{ type: 'ENERGY', amount: 18 }],
          unfrozenV2: [{ type: 'BANDWIDTH', unfreeze_amount: 19, unfreeze_expire_time: 20 }],
          create_time: 7,
          allowance: 8,
          latest_withdraw_time: 9,
        }),
      })
    ).json()) as { address?: string; Error?: string }
    assert.strictEqual(reply.Error, undefined)
    assert.strictEqual(reply.address, owner)
  })

  it('walks nested protobuf fields instead of treating their object as opaque', async () => {
    const owner = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const getAccount = async (body: Record<string, unknown>) =>
      (await (
        await fetch(`${baseUrl}/wallet/getaccount`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: owner, visible: true, ...body }),
        })
      ).json()) as { Error?: string }

    assert.include(
      (await getAccount({ votes: [{ vote_address: 1 }] })).Error ?? '',
      'Expected string.',
    )
    assert.include(
      (await getAccount({ asset: [{ key: 'a', value: 'not-an-int' }] })).Error ?? '',
      `Couldn't parse integer`,
    )
    assert.include(
      (await getAccount({ owner_permission: { keys: [{ address: 1 }] } })).Error ?? '',
      'Expected string.',
    )

    const asset = (await (
      await fetch(`${baseUrl}/wallet/createassetissue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ frozen_supply: [{ frozen_amount: 'not-an-int' }] }),
      })
    ).json()) as { Error?: string }
    assert.include(asset.Error ?? '', `Couldn't parse integer`)
  })

  it('uses the query decoder for the GET asset-owner lookup', async () => {
    const reply = await fetch(`${baseUrl}/wallet/getassetissuebyaccount?address=zz`)
    const body = (await reply.json()) as { Error?: string }
    assert.include(body.Error ?? '', 'exception decoding Hex string')
  })

  it('reports a malformed body instead of treating it as absent', async () => {
    const post = async (body: string) => {
      const res = await fetch(`${baseUrl}/wallet/getaccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      return [res.status, (await res.json()) as { Error?: string }] as const
    }

    const [scalarStatus, scalar] = await post('123')
    assert.strictEqual(scalarStatus, 200)
    assert.strictEqual(scalar.Error, 'can not cast to JSONObject.')

    const [, empty] = await post('')
    assert.strictEqual(empty.Error, '1:1: Expected "{".')

    const [, nullLiteral] = await post('null')
    assert.match(nullLiteral.Error ?? '', /^Cannot invoke "org\.tron\.json\.JSONObject/)

    const [, broken] = await post('not json')
    assert.match(broken.Error ?? '', /^Unrecognized token: /)

    // the shapes the reference's own reader takes and RFC 8259 does not
    for (const body of ['{"num":010}', '{"num":1,}', '{num:1}', "{'num':1}"]) {
      const [, lax] = await post(body)
      assert.match(lax.Error ?? '', /^Unrecognized token: /, body)
    }
  })

  it('stringifies 64-bit fields on GET when int64_as_string is set', async () => {
    const asString = (await (
      await fetch(`${baseUrl}/wallet/getnowblock?int64_as_string=true`)
    ).json()) as { block_header: { raw_data: { timestamp: unknown } } }
    assert.strictEqual(typeof asString.block_header.raw_data.timestamp, 'string')

    // the flag rides the query string, so POST never sees it
    const asNumber = (await (
      await fetch(`${baseUrl}/wallet/getnowblock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ int64_as_string: true }),
      })
    ).json()) as { block_header: { raw_data: { timestamp: unknown } } }
    assert.strictEqual(typeof asNumber.block_header.raw_data.timestamp, 'number')

    // the flag is read before the servlet runs and only on GET, so a POST is
    // unaffected wherever the flag sits
    const postQuery = (await (
      await fetch(`${baseUrl}/wallet/getnowblock?int64_as_string=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { block_header: { raw_data: { timestamp: unknown } } }
    assert.strictEqual(typeof postQuery.block_header.raw_data.timestamp, 'number')

    // `num` is an int64 in the reply this route prints and an int32 in the
    // asset list, so the message decides and not the leaf name
    const maintenance = (await (
      await fetch(`${baseUrl}/wallet/getnextmaintenancetime?int64_as_string=true`)
    ).json()) as { num: unknown }
    assert.strictEqual(typeof maintenance.num, 'string')
    const interval = config.chainParameters.maintenanceTimeIntervalMs
    assert.strictEqual(
      maintenance.num,
      String((Math.floor(nodeCore(node).head().timestampMs / interval) + 1) * interval),
    )

    // the node info reply never passes through the protobuf printer, so the
    // printer's options have nothing to act on
    const nodeInfo = (await (
      await fetch(`${baseUrl}/wallet/getnodeinfo?int64_as_string=true`)
    ).json()) as { beginSyncNum: unknown }
    assert.strictEqual(typeof nodeInfo.beginSyncNum, 'number')
  })

  it('pages the witness list, and answers nothing past the end', async () => {
    const page = async (body: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/getpaginatednowwitnesslist`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>

    const first = (await page({ offset: 0, limit: 10 })).witnesses as unknown[]
    assert.strictEqual(first.length, 1)
    // a non-positive limit, a negative offset, or a page past the end: nothing
    assert.deepEqual(await page({ offset: 0, limit: 0 }), {})
    assert.deepEqual(await page({ offset: -1, limit: 10 }), {})
    assert.deepEqual(await page({ offset: 5, limit: 10 }), {})
  })

  it('retries only the full-node witness page for a maintenance block', async () => {
    const page = async (
      path: string,
      body: Record<string, number> = { offset: 0, limit: 10 },
    ): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>

    const interval = node.config.chainParameters.maintenanceTimeIntervalMs
    const next = (Math.floor(nodeCore(node).head().timestampMs / interval) + 1) * interval
    await node.tre.increaseTime(Math.ceil((next - nodeCore(node).head().timestampMs) / 1000))

    // Invalid pages return before the maintenance retry branch.
    assert.deepEqual(await page('wallet/getpaginatednowwitnesslist', { offset: 0, limit: 0 }), {})
    assert.deepEqual(await page('wallet/getpaginatednowwitnesslist'), {
      Error: 'Service temporarily unavailable during maintenance period. Please try again later.',
    })
    assert.lengthOf(
      (await page('walletsolidity/getpaginatednowwitnesslist')).witnesses as unknown[],
      1,
    )

    // A normal block clears the one-block maintenance state again.
    await node.tre.mine(1)
    assert.lengthOf((await page('wallet/getpaginatednowwitnesslist')).witnesses as unknown[], 1)
  })

  it('serves the net alias of the node-info servlets, not the monitor one', async () => {
    // an empty peer list is an empty repeated field, which prints as nothing
    assert.deepEqual(await (await fetch(`${baseUrl}/net/listnodes`)).json(), {})
    // every deployment keeps /monitor off its gateway, so the
    // path stays declared-but-unimplemented rather than answering here
    const monitor = await fetch(`${baseUrl}/monitor/getnodeinfo`)
    assert.strictEqual(monitor.status, 501)
  })

  it('validates addresses in all three encodings the servlet accepts', async () => {
    const validate = async (address: string): Promise<unknown> =>
      (
        await fetch(`${baseUrl}/wallet/validateaddress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address }),
        })
      ).json()

    const ownerBase58 = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const hex = TronWeb.address.toHex(ownerBase58) as string
    const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
    const base64 = toBase64(hexToBytes(`0x${hex}`))
    assert.deepEqual(await validate(hex), { result: true, message: 'Hex string format' })
    assert.deepEqual(await validate(ownerBase58), {
      result: true,
      message: 'Base58check format',
    })
    assert.deepEqual(await validate(base64), { result: true, message: 'Base64 format' })
    // a payload of the wrong width decodes but is not an address
    assert.deepEqual(await validate(toBase64(hexToBytes(`0x${hex.slice(2)}`))), {
      result: false,
      message: 'Invalid address',
    })
    assert.deepEqual(await validate('41'), { result: false, message: 'Length error' })
  })

  it('reports a missing address while keeping an explicit empty string distinct', async () => {
    const missingGet = await fetch(`${baseUrl}/wallet/validateaddress`)
    assert.strictEqual(missingGet.status, 200)
    assert.deepEqual(await missingGet.json(), {
      result: false,
      message: 'Cannot invoke "String.length()" because "input" is null',
    })

    const missingPost = await fetch(`${baseUrl}/wallet/validateaddress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.strictEqual(missingPost.status, 200)
    assert.deepEqual(await missingPost.json(), {
      result: false,
      message: 'Cannot invoke "String.length()" because "input" is null',
    })

    const nullPost = await fetch(`${baseUrl}/wallet/validateaddress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"address":null}',
    })
    assert.deepEqual(await nullPost.json(), {
      result: false,
      message: 'Cannot invoke "String.length()" because "input" is null',
    })

    const empty = await fetch(`${baseUrl}/wallet/validateaddress?address=`)
    assert.deepEqual(await empty.json(), { result: false, message: 'Length error' })
  })

  it('reports the reward endpoints own error envelope for a bad hex address', async () => {
    const reward = await (
      await fetch(`${baseUrl}/wallet/getReward`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: '41zzzz' }),
      })
    ).json()
    assert.deepEqual(reward, {
      Error:
        'INVALID address, exception decoding Hex string: invalid characters encountered in Hex string',
    })
    // a base58 that does not decode is simply nobody, not an error
    assert.deepEqual(
      await (
        await fetch(`${baseUrl}/wallet/getReward`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: 'Tzzzz' }),
        })
      ).json(),
      { reward: 0 },
    )
  })

  it('refuses a transaction whose bytes exceed the block builder ceiling', async () => {
    const owner = tronWeb.defaultAddress.base58 as string
    const to = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(resolveConfig().mnemonic)[8]!.privateKey,
    ) as string
    const tx = (await tronWeb.transactionBuilder.sendTrx(to, 1000, owner)) as unknown as {
      raw_data: Record<string, unknown>
      txID: string
      raw_data_hex: string
    }
    tx.raw_data.data = 'ab'.repeat(600_000)
    const pb = utils.transaction.txJsonToPb(tx as never)
    tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '')
    tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).replace(/^0x/, '')
    const reply = (await tronWeb.trx.sendRawTransaction(
      await tronWeb.trx.sign(tx as never),
    )) as unknown as { code?: string; message?: string }
    assert.strictEqual(reply.code, 'TOO_BIG_TRANSACTION_ERROR')
    assert.match(
      TronWeb.toUtf8(`0x${reply.message ?? ''}`),
      /^Too big transaction with result, TxId [0-9a-f]+, the size is \d+ bytes, maxTxSize 512000$/,
    )
  })

  it('judges every name in a body against the message it merges into', async () => {
    const post = async (path: string, body: string): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).json()) as Record<string, unknown>

    // a name the message does not declare is stepped over, and the step wants
    // `identifier: value` pairs — so an empty object stops at the brace
    assert.strictEqual(
      (await post('wallet/getaccount', '{"nosuch":{}}')).Error,
      '1:12: Expected identifier. -}',
    )
    // the step reads a value that starts with a digit as an integer
    assert.strictEqual(
      (await post('wallet/getaccount', '{"nosuch":1.5}')).Error,
      '1:11: Couldn\'t parse integer: For input string: "1.5"',
    )
    // a declared field is held to its own type instead
    assert.strictEqual(
      (await post('wallet/getaccount', '{"account_id":1}')).Error,
      '1:15: Expected string.',
    )
    assert.strictEqual(
      (await post('wallet/getaccount', '{"account_id":"zz"}')).Error,
      '1:15: INVALID hex String',
    )
    // an enum member is read as an int32 first, so the range it names is 32 bits
    assert.strictEqual(
      (await post('wallet/getaccount', '{"type":99999999999999999999}')).Error,
      "1:9: Couldn't parse integer: Number out of range for 32-bit signed integer: 99999999999999999999",
    )
    // beyond fifteen characters the parse reads a word at a time and blames
    // only the group it stopped in
    assert.strictEqual(
      (await post('wallet/getblockbynum', '{"num":"aaaaaaaaaaaaaaaaaa"}')).Error,
      '1:8: Couldn\'t parse integer: For input string: ""a"',
    )
  })

  it('answers a request the parser refuses the way the container does', async () => {
    const send = (text: string): Promise<number> =>
      new Promise((resolve) => {
        const { port } = new URL(baseUrl)
        const socket = connect(Number(port), '127.0.0.1', () => socket.write(text))
        let raw = ''
        socket.on('data', (chunk) => {
          raw += chunk.toString()
        })
        socket.on('close', () => resolve(Number(/^HTTP\/1\.[01] (\d+)/.exec(raw)?.[1] ?? 0)))
        socket.on('error', () => resolve(0))
      })
    const line = (start: string, extra = ''): string =>
      `${start}\r\nHost: h\r\n${extra}Connection: close\r\n\r\n`

    // a method token the container does not implement, rather than a bad one
    assert.strictEqual(await send(line('get /wallet/getnowblock HTTP/1.1')), 501)
    assert.strictEqual(await send(line('FOO /wallet/getnowblock HTTP/1.1')), 501)
    // a version it cannot speak
    assert.strictEqual(await send(line('GET /wallet/getnowblock HTTP/2.0')), 426)
    assert.strictEqual(await send(line('GET /wallet/getnowblock HTTP/9.9')), 505)
    // the ceiling on the request line and on the headers is reported apart
    assert.strictEqual(await send(line(`GET /wallet/${'a'.repeat(9000)} HTTP/1.1`)), 414)
    assert.strictEqual(
      await send(line('GET /wallet/getnowblock HTTP/1.1', `X-Pad: ${'a'.repeat(9000)}\r\n`)),
      431,
    )
    // a percent escape naming no byte, read before the verb is
    for (const target of ['/%', '/%zz', '/wallet/%', '/wallet/getnowblock%']) {
      assert.strictEqual(await send(line(`GET ${target} HTTP/1.1`)), 400, target)
    }
    assert.strictEqual(await send(line('POST /% HTTP/1.1')), 400)
    // an escape that does name one is decoded and routed
    assert.strictEqual(await send(line('GET /wallet/%67etnowblock HTTP/1.1')), 200)

    // and what fits still runs
    assert.strictEqual(await send(line(`GET /wallet/${'a'.repeat(4000)} HTTP/1.1`)), 404)
    assert.strictEqual(
      await send(line('GET /wallet/getnowblock HTTP/1.1', `X-Pad: ${'a'.repeat(4000)}\r\n`)),
      200,
    )
  })

  it('reads a target stated in absolute form', async () => {
    const send = (target: string): Promise<number> =>
      new Promise((resolve) => {
        const { port } = new URL(baseUrl)
        const socket = connect(Number(port), '127.0.0.1', () =>
          socket.write(`GET ${target} HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`),
        )
        let raw = ''
        socket.on('data', (chunk) => {
          raw += chunk.toString()
        })
        socket.on('close', () => resolve(Number(/^HTTP\/1\.[01] (\d+)/.exec(raw)?.[1] ?? 0)))
        socket.on('error', () => resolve(0))
      })

    // an absolute target names the same resource as the origin form, whatever
    // authority it carries
    assert.strictEqual(await send('http://any-host/wallet/getnowblock'), 200)
    assert.strictEqual(await send('https://x/wallet/getnowblock'), 200)
    assert.strictEqual(await send('http://x/nosuch'), 404)
    // a doubled leading slash has no scheme, so it stays an opaque path
    assert.strictEqual(await send('//wallet/getnowblock'), 404)
  })

  it('echoes a TRACE whatever the path is', async () => {
    const trace = (path: string): Promise<{ status: number; type: string; body: string }> =>
      new Promise((resolve) => {
        const { port } = new URL(baseUrl)
        const socket = connect(Number(port), '127.0.0.1', () => {
          socket.write(
            `TRACE ${path} HTTP/1.1\r\nHost: h\r\nX-Probe: v\r\nConnection: close\r\n\r\n`,
          )
        })
        let raw = ''
        socket.on('data', (chunk) => {
          raw += chunk.toString()
        })
        socket.on('end', () => {
          const [head, body = ''] = raw.split('\r\n\r\n')
          resolve({
            status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0),
            type: /content-type: (\S+)/i.exec(head)?.[1] ?? '',
            body,
          })
        })
      })

    // the container answers TRACE before any path lookup, so a path no servlet
    // claims is echoed exactly like one that does
    for (const path of ['/wallet/getnowblock', '/wallet/nosuchpath12345', '/']) {
      const reply = await trace(path)
      assert.strictEqual(reply.status, 200, path)
      assert.strictEqual(reply.type, 'message/http', path)
      assert.include(reply.body, `TRACE ${path} HTTP/1.1`)
      // every header the request carried comes back
      assert.include(reply.body, 'X-Probe: v')
    }
  })

  it('refuses a contract type no chain has ever enabled', async () => {
    const mask = (bit: number): string => {
      const bytes = new Array<number>(32).fill(0)
      bytes[bit >> 3] |= 1 << (bit % 8)
      return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
    }
    const owner = tronWeb.defaultAddress.base58 as string
    const key = { address: TronWeb.address.toHex(owner), weight: 1 }
    const update = async (bit: number): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/accountpermissionupdate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner_address: TronWeb.address.toHex(owner),
            owner: { type: 'Owner', permission_name: 'owner', threshold: 1, keys: [key] },
            actives: [
              {
                type: 'Active',
                permission_name: 'active',
                threshold: 1,
                keys: [key],
                operations: mask(bit),
              },
            ],
          }),
        })
      ).json()) as Record<string, unknown>

    // no proposal ever added 51, and 52/53 wait on one mainnet never
    // passed — none of the three is available on any chain
    for (const bit of [7, 51, 52, 53]) {
      assert.strictEqual((await update(bit)).Error, `${bit} isn't a validate ContractType`)
    }
    // stake 2.0 brought 54..59 in, and they are available wherever it is
    assert.isUndefined((await update(59)).Error)
  })

  it("fills a permission's protobuf defaults before judging it", async () => {
    const owner = tronWeb.defaultAddress.base58 as string
    const key = { address: TronWeb.address.toHex(owner), weight: 1 }
    const active = { type: 'Active', permission_name: 'a', threshold: 1, keys: [key] }
    const update = async (ownerPermission: unknown): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${baseUrl}/wallet/accountpermissionupdate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner_address: TronWeb.address.toHex(owner),
            owner: ownerPermission,
            actives: [active],
          }),
        })
      ).json()) as Record<string, unknown>

    // an absent field is already at its default by the time an actuator reads
    // it, so it is judged rather than skipped
    assert.strictEqual(
      (await update({ type: 'Owner', permission_name: 'o', keys: [key] })).Error,
      "permission's threshold should be greater than 0",
    )
    assert.strictEqual(
      (
        await update({
          type: 'Owner',
          permission_name: 'o',
          threshold: 1,
          keys: [{ address: TronWeb.address.toHex(owner) }],
        })
      ).Error,
      "key's weight should be greater than 0",
    )
    assert.strictEqual(
      (await update({ type: 'Owner', permission_name: 'o', threshold: 1 })).Error,
      "key's count should be greater than 0",
    )
  })

  it('requires an id on the proposal and exchange lookups', async () => {
    const post = async (path: string, body: unknown): Promise<unknown> =>
      (
        await fetch(`${baseUrl}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()

    assert.deepEqual(await post('wallet/getproposalbyid', {}), {
      Error: 'key [id] does not exist',
    })
    assert.deepEqual(await post('wallet/getproposalbyid', { id: 'abc' }), {
      Error:
        'Character a is neither a decimal digit number, decimal point, nor "e" notation exponential mark.',
    })
    assert.deepEqual(await post('wallet/getproposalbyid', { id: 1.5 }), {
      Error: 'Rounding necessary',
    })
    // a query string goes through the long parser instead, null included
    assert.deepEqual(await (await fetch(`${baseUrl}/wallet/getproposalbyid?id=abc`)).json(), {
      Error: 'For input string: "abc"',
    })
    assert.deepEqual(await (await fetch(`${baseUrl}/wallet/getproposalbyid?id=`)).json(), {
      Error: 'For input string: ""',
    })
    // each bound of a paginated list is its own parse, so one missing fails
    for (const query of ['limit=10', 'offset=0', '']) {
      assert.deepEqual(
        await (await fetch(`${baseUrl}/wallet/getpaginatedproposallist?${query}`)).json(),
        { Error: 'Cannot parse null string' },
        query,
      )
    }
    assert.deepEqual(
      await (await fetch(`${baseUrl}/wallet/getpaginatedproposallist?offset=abc&limit=10`)).json(),
      { Error: 'For input string: "abc"' },
    )
    assert.deepEqual(await post('wallet/getpaginatedproposallist', { offset: '0', limit: '10' }), {
      Error: '1:11: Couldn\'t parse integer: For input string: ""0""',
    })
    // a known id finds nothing here; the exchange lookup prints its miss
    assert.deepEqual(await post('wallet/getproposalbyid', { id: 1 }), {})
    assert.deepEqual(await post('wallet/getexchangebyid', { id: 1 }), {
      Error: 'null',
    })
  })

  it('carries extra_data into the transaction it signs', async () => {
    const ownerBase58 = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string
    const built = (await (
      await fetch(`${baseUrl}/wallet/createtransaction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_address: ownerBase58,
          to_address: utils.accounts.generateAccount().address.base58,
          amount: 1,
          visible: true,
          extra_data: 'hi',
        }),
      })
    ).json()) as { raw_data: Record<string, unknown>; raw_data_hex: string }
    assert.strictEqual(built.raw_data.data, '6869')
    // proto field order puts the memo between the expiration and the contract
    assert.deepEqual(Object.keys(built.raw_data), [
      'ref_block_bytes',
      'ref_block_hash',
      'expiration',
      'data',
      'contract',
      'timestamp',
    ])
    assert.include(built.raw_data_hex, '6869')
  })

  // the account responses are hand-shaped (there is no pb→JSON printer for the
  // TRON HTTP dialect in JS); these pins hold the wire shape in place
  it('getaccount / resource responses keep the pinned wire shape', async () => {
    const ownerBase58 = TronWeb.address.fromPrivateKey(
      accountsFromMnemonic(config.mnemonic)[0].privateKey,
    ) as string

    const account = (await tronWeb.trx.getAccount(ownerBase58)) as unknown as Record<
      string,
      unknown
    >
    // every account carries the owner and active permissions it was created
    // with, and the asset-store flag every operator-funded account gets
    assert.deepEqual(Object.keys(account).sort(), [
      'account_resource',
      'active_permission',
      'address',
      'asset_optimized',
      'balance',
      'frozenV2',
      'net_window_optimized',
      'net_window_size',
      'owner_permission',
    ])
    assert.match(account.address as string, /^41[0-9a-f]{40}$/)
    // three freeze slots exist from account init; amounts are zero → omitted
    assert.deepEqual(account.frozenV2, [{}, { type: 'ENERGY' }, { type: 'TRON_POWER' }])

    // unknown accounts print a literal {}
    const unknown = (await tronWeb.trx.getAccount(
      utils.accounts.generateAccount().address.base58,
    )) as unknown as Record<string, unknown>
    assert.deepEqual(unknown, {})

    // unstaked account: per-account limits and chain weights are zero → omitted
    const resources = (await tronWeb.trx.getAccountResources(ownerBase58)) as unknown as Record<
      string,
      unknown
    >
    assert.deepEqual(Object.keys(resources).sort(), [
      'TotalEnergyLimit',
      'TotalNetLimit',
      'freeNetLimit',
    ])
  })
})
