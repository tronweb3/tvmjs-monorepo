import { rejects } from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { concatBytes, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, afterEach, beforeEach, describe, it, vi } from 'vitest'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { NodeCore } from '../../src/core/node.ts'
import { BlockTimeChangeError } from '../../src/index.ts'
import type { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'
import { probeState } from '../stateProbe.ts'

import type { Server } from 'node:http'
import type { SignedTronTx } from '../../src/dialect/tron/wallet/types.ts'

const NOW = 1_800_000_000_000
// Increment storage[0], then return the new value, NUMBER and TIMESTAMP.
const COUNTER = '60005460010180600055600052436020524260405260606000f3'
type Controls = 'node' | 'provider' | 'http'
type Info = { blockNumber: number; blockTimeStamp: number; fee?: number; contractResult: string[] }
type Block = {
  block_header: {
    raw_data: { number: number; timestamp: number; txTrieRoot: string; witness_address: string }
  }
  transactions?: { txID: string }[]
}

describe('instant and interval transaction mining', () => {
  let node: TronNode
  let provider: TronProvider
  let server: Server
  let url: string
  let tronWeb: TronWeb
  let owner: string
  let receiver: string
  let ownerKey: string
  let clock: Clock
  let logged: string[]
  let observeLog: ((line: string) => void) | undefined

  beforeEach(async () => {
    const config = resolveConfig()
    logged = []
    observeLog = undefined
    config.runtime.logger = {
      log: (line) => {
        logged.push(line)
        observeLog?.(line)
      },
    }
    const keys = accountsFromMnemonic(config.mnemonic)
    ownerKey = keys[0].privateKey
    owner = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(ownerKey) as string)
    receiver = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(keys[1].privateKey) as string)
    clock = new Clock(() => NOW)
    node = await createNode(config, clock)
    provider = new TronProvider(node)
    const started = await startHttpServer(provider, { port: 0 })
    server = started.server
    url = started.url
    tronWeb = new TronWeb({ fullHost: url, privateKey: ownerKey })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await node.tre.blockTime(0)
    vi.useRealTimers()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  })

  async function post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    return (await (
      await fetch(`${url}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as T
  }

  async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const reply = await post<{ result: T; error?: unknown }>('tre', {
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    })
    assert.isUndefined(reply.error, JSON.stringify(reply.error))
    return reply.result
  }

  async function setInterval(seconds: number, controls: Controls = 'http'): Promise<void> {
    if (controls === 'node') await node.tre.blockTime(seconds)
    else if (controls === 'provider') {
      assert.isTrue(await provider.request({ method: 'tre_blockTime', params: [seconds] as never }))
    } else assert.isTrue(await rpc('tre_blockTime', [seconds]))
  }

  async function mine(blocks = 1, controls: Controls = 'http'): Promise<void> {
    if (controls === 'node') await node.tre.mine(blocks)
    else if (controls === 'provider') {
      assert.strictEqual(
        await provider.request({ method: 'tre_mine', params: [{ blocks }] as never }),
        '0x0',
      )
    } else assert.strictEqual(await rpc('tre_mine', [{ blocks }]), '0x0')
  }

  function sign(tx: SignedTronTx, privateKey = ownerKey): SignedTronTx {
    const pb = utils.transaction.txJsonToPb(tx as never)
    tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '')
    tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).replace(/^0x/, '').toLowerCase()
    tx.signature = []
    return utils.crypto.signTransaction(privateKey, tx as never) as unknown as SignedTronTx
  }

  async function transfer(amount: number): Promise<SignedTronTx> {
    const tx = await post<SignedTronTx>('wallet/createtransaction', {
      owner_address: owner,
      to_address: receiver,
      amount,
    })
    assert.isString(tx.txID, JSON.stringify(tx))
    return sign(tx)
  }

  async function send(tx: SignedTronTx): Promise<void> {
    const reply = await post('wallet/broadcasttransaction', tx)
    assert.isTrue(reply.result, JSON.stringify(reply))
    assert.strictEqual(reply.txid, tx.txID)
  }

  const info = (txid: string) => post<Info>('wallet/gettransactioninfobyid', { value: txid })
  const head = () => post<Block>('wallet/getnowblock', {})
  const balance = async (address = receiver) =>
    Number((await post('wallet/getaccount', { address })).balance ?? 0)

  it.each(['node', 'provider', 'http'] as const)(
    'queues real interval ticks behind an active %s write',
    async (controls) => {
      vi.useRealTimers()
      const tx = await transfer(37)
      await setInterval(1, controls)
      await send(tx)
      const core = nodeCore(node)
      const beforeHeight = core.head().number
      const beforeBalance = await balance()
      const original = core.stateManager.getStateRoot.bind(core.stateManager)
      let entered!: () => void
      let release!: () => void
      const suspended = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const stateRoot = vi
        .spyOn(core.stateManager, 'getStateRoot')
        .mockImplementationOnce(async () => {
          const root = await original()
          entered()
          await gate
          return root
        })
      const manual = mine(1, controls)
      try {
        await suspended
        await delay(1150)
        assert.strictEqual(core.head().number, beforeHeight)
        release()
        await manual
        await setInterval(0, controls)
        const occurrences = core.blocks
          .range(beforeHeight + 1n, core.head().number + 1n)
          .flatMap((block) => block.txs)
          .filter((record) => record.txid === tx.txID)
        assert.lengthOf(occurrences, 1)
        assert.strictEqual(await balance(), beforeBalance + 37)
      } finally {
        release()
        await manual.catch(() => {})
        stateRoot.mockRestore()
        await setInterval(0, controls)
      }
    },
  )

  it.each([0, 30])(
    'reads committed BLOCKHASH values with interval %s and replays old history',
    async (seconds) => {
      const contract = await deploy('6000354060005260206000f3')
      await node.tre.mine(3)
      const known = nodeCore(node).head()
      // Constant execution uses the head; a transaction executes in the next block.
      const previous = nodeCore(node).blocks.getByNumber(known.number - 1n)!
      const word = (value: bigint) => value.toString(16).padStart(64, '0')
      const constant = async (height: bigint) =>
        post<{ constant_result: string[] }>('wallet/triggerconstantcontract', {
          owner_address: owner,
          contract_address: contract,
          data: word(height),
        })
      assert.strictEqual((await constant(previous.number)).constant_result[0], previous.blockID)
      for (const height of [known.number, known.number + 1n]) {
        assert.strictEqual((await constant(height)).constant_result[0], word(0n))
      }
      await setInterval(seconds)
      const built = await post<{ transaction: SignedTronTx }>('wallet/triggersmartcontract', {
        owner_address: owner,
        contract_address: contract,
        data: word(known.number),
        fee_limit: 100_000_000,
      })
      const tx = sign(built.transaction)
      await send(tx)
      if (seconds > 0) await mine()
      assert.strictEqual((await info(tx.txID)).contractResult[0], known.blockID)
      const firstTrace = await node.debug.traceTransaction(tx.txID)
      assert.strictEqual(firstTrace.returnValue, known.blockID)
      await node.tre.mine(100)
      await node.tre.mine(100)
      await node.tre.mine(56)
      assert.strictEqual((await constant(known.number)).constant_result[0], word(0n))
      assert.deepEqual(await node.debug.traceTransaction(tx.txID), firstTrace)
    },
  )

  async function deploy(runtime = COUNTER): Promise<string> {
    const length = (runtime.length / 2).toString(16).padStart(2, '0')
    const tx = await tronWeb.transactionBuilder.createSmartContract(
      {
        abi: [],
        bytecode: `60${length}80600b6000396000f3${runtime}`,
        feeLimit: 100_000_000,
      },
      TronWeb.address.fromHex(owner),
    )
    await send(sign(tx as unknown as SignedTronTx))
    return tx.contract_address
  }

  async function call(contract: string, discriminator: number): Promise<SignedTronTx> {
    const built = await post<{ transaction: SignedTronTx }>('wallet/triggersmartcontract', {
      owner_address: owner,
      contract_address: contract,
      data: discriminator.toString(16).padStart(8, '0'),
      fee_limit: 100_000_000,
    })
    assert.isDefined(built.transaction, JSON.stringify(built))
    return sign(built.transaction)
  }

  it.each([0, 30])(
    'uses the witness and block context in constant, canonical and replay execution with interval %s',
    async (seconds) => {
      // Return COINBASE, NUMBER and TIMESTAMP as three words.
      const contract = await deploy('41600052436020524260405260606000f3')
      const expected = (block: Block) => {
        const raw = block.block_header.raw_data
        return [
          raw.witness_address.slice(2).padStart(64, '0'),
          BigInt(raw.number).toString(16).padStart(64, '0'),
          BigInt(Math.floor(raw.timestamp / 1000))
            .toString(16)
            .padStart(64, '0'),
        ].join('')
      }
      const constant = async () =>
        (
          await post<{ constant_result: string[] }>('wallet/triggerconstantcontract', {
            owner_address: owner,
            contract_address: contract,
          })
        ).constant_result[0]

      await setInterval(seconds)
      const before = await head()
      assert.strictEqual(await constant(), expected(before))
      const tx = await call(contract, 0)
      await send(tx)
      if (seconds > 0) {
        assert.strictEqual(await constant(), expected(before))
        await mine()
      }
      const produced = await head()
      assert.strictEqual(
        produced.block_header.raw_data.number,
        before.block_header.raw_data.number + 1,
      )
      assert.strictEqual((await info(tx.txID)).contractResult[0], expected(produced))
      assert.strictEqual(await constant(), expected(produced))
      await mine(2)
      assert.strictEqual(await constant(), expected(await head()))
      assert.strictEqual(
        (await node.debug.traceTransaction(tx.txID)).returnValue,
        expected(produced),
      )
    },
  )

  it('keeps GASPRICE at the fixed compatible-EVM value', async () => {
    // GASPRICE; MSTORE(0); RETURN(0, 32)
    const contract = await deploy('3a60005260206000f3')
    const tx = await call(contract, 0)
    await send(tx)
    const expected = '0'.repeat(64)
    assert.strictEqual((await info(tx.txID)).contractResult[0], expected)
    assert.strictEqual((await node.debug.traceTransaction(tx.txID)).returnValue, expected)
    const constant = await post<{ constant_result: string[] }>('wallet/triggerconstantcontract', {
      owner_address: owner,
      contract_address: contract,
    })
    assert.strictEqual(constant.constant_result[0], expected)
  })

  it.each([
    { transport: 'http', seconds: 0 },
    { transport: 'http', seconds: 30 },
    { transport: 'provider', seconds: 0 },
    { transport: 'provider', seconds: 30 },
  ] as const)(
    'broadcasthex validates and commits signed transfers through $transport with interval $seconds',
    async ({ transport, seconds }) => {
      await setInterval(seconds)
      const before = await balance()
      const tx = await transfer(123)
      const broadcast = async (signed: SignedTronTx, prefix = '') => {
        const pb = utils.transaction.txJsonToPb(signed as never)
        for (const signature of signed.signature ?? []) {
          pb.addSignature(hexToBytes(`0x${signature}`))
        }
        const params = { transaction: prefix + Buffer.from(pb.serializeBinary()).toString('hex') }
        return transport === 'http'
          ? post('wallet/broadcasthex', params)
          : provider.request({ method: 'wallet/broadcasthex', params })
      }

      const wrongSigner = sign(
        structuredClone(tx),
        tronWeb.utils.accounts.generateAccount().privateKey,
      )
      assert.strictEqual((await broadcast(wrongSigner)).code, 'SIGERROR')
      const expired = structuredClone(tx)
      expired.raw_data.expiration = (await head()).block_header.raw_data.timestamp
      assert.strictEqual((await broadcast(sign(expired))).code, 'TRANSACTION_EXPIRATION_ERROR')
      assert.strictEqual(await balance(), before)
      assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 0 })

      const accepted = await broadcast(tx, '0x')
      assert.isTrue(accepted.result)
      assert.strictEqual(accepted.code, 'SUCCESS')
      assert.strictEqual(accepted.message, '')
      assert.strictEqual(accepted.txid, tx.txID)
      const echo = JSON.parse(String(accepted.transaction))
      assert.isNotEmpty(echo.raw_data.contract)
      assert.deepEqual(
        echo.signature,
        tx.signature?.map((signature) => signature.toLowerCase()),
      )
      assert.strictEqual(echo.raw_data.timestamp, tx.raw_data.timestamp)
      assert.strictEqual(echo.raw_data.expiration, tx.raw_data.expiration)
      assert.strictEqual(echo.raw_data.contract[0].type, 'TransferContract')
      assert.strictEqual(
        echo.raw_data.contract[0].parameter.type_url,
        tx.raw_data.contract[0].parameter.type_url,
      )
      assert.match(echo.raw_data.contract[0].parameter.value, /^[0-9a-f]+$/)
      assert.strictEqual((await broadcast(tx)).code, 'DUP_TRANSACTION_ERROR')
      if (seconds > 0) {
        assert.strictEqual(await balance(), before)
        assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 1 })
        await mine()
      }
      assert.strictEqual(await balance(), before + 123)
      assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 0 })
      assert.strictEqual((await broadcast(tx)).code, 'DUP_TRANSACTION_ERROR')
      assert.strictEqual(await balance(), before + 123)
      assert.deepEqual(
        (await head()).transactions?.map((entry) => entry.txID),
        [tx.txID],
      )
      assert.strictEqual(
        (await info(tx.txID)).blockNumber,
        (await head()).block_header.raw_data.number,
      )
    },
  )

  it.each(['node', 'provider', 'http'] as const)(
    'zero keeps one transaction per block through %s controls, including concurrent sends',
    async (controls) => {
      await setInterval(0, controls)
      const before = (await head()).block_header.raw_data.number
      const txs = await Promise.all([transfer(100), transfer(200)])
      await Promise.all(txs.map(send))
      const receipts = await Promise.all(txs.map((tx) => info(tx.txID)))
      assert.deepEqual(receipts.map((receipt) => receipt.blockNumber).sort(), [
        before + 1,
        before + 2,
      ])
      for (const receipt of receipts) {
        const block = await post<Block>('wallet/getblockbynum', { num: receipt.blockNumber })
        assert.lengthOf(block.transactions!, 1)
      }
      const height = nodeCore(node).head().number
      await vi.advanceTimersByTimeAsync(10_000)
      assert.strictEqual(nodeCore(node).head().number, height)
    },
  )

  it.each(['node', 'provider', 'http'] as const)(
    'waits and packs three ordered transactions into one interval block through %s controls',
    async (controls) => {
      await setInterval(5, controls)
      const before = await probeState(node)
      const held = await balance()
      const txs = []
      for (const amount of [1_000, 2_000, 3_000]) {
        const tx = await transfer(amount)
        txs.push(tx)
        await send(tx)
        assert.isEmpty(await info(tx.txID))
      }
      assert.deepEqual(await probeState(node), before)
      assert.strictEqual(await balance(), held)
      await vi.advanceTimersByTimeAsync(4_999)
      assert.strictEqual(nodeCore(node).head().number, before.height)
      await vi.advanceTimersByTimeAsync(1)
      const block = await head()
      assert.strictEqual(block.block_header.raw_data.number, Number(before.height + 1n))
      assert.deepEqual(
        block.transactions!.map((tx) => tx.txID),
        txs.map((tx) => tx.txID),
      )
      assert.strictEqual(await balance(), held + 6_000)
      const receipts = await Promise.all(txs.map((tx) => info(tx.txID)))
      for (const receipt of receipts) {
        assert.strictEqual(receipt.blockNumber, block.block_header.raw_data.number)
        assert.strictEqual(receipt.blockTimeStamp, NOW + 5_000)
      }
      assert.lengthOf(
        await post<unknown[]>('wallet/gettransactioninfobyblocknum', {
          num: block.block_header.raw_data.number,
        }),
        3,
      )
      assert.deepEqual(
        await post('wallet/gettransactioncountbyblocknum', {
          num: block.block_header.raw_data.number,
        }),
        { count: 3 },
      )

      // Independent protobuf preimage: field 5 (ret) contains field 3 = SUCCESS.
      // Java promotes the odd third leaf, yielding H(H(A || B) || C).
      const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest()
      const leaves = txs.map((tx) => {
        const pb = utils.transaction.txJsonToPb(tx as never)
        for (const signature of tx.signature!) pb.addSignature(hexToBytes(`0x${signature}`))
        return hash(concatBytes(pb.serializeBinary(), new Uint8Array([0x2a, 2, 0x18, 1])))
      })
      const expectedRoot = hash(concatBytes(hash(concatBytes(...leaves.slice(0, 2))), leaves[2]))
      assert.strictEqual(block.block_header.raw_data.txTrieRoot, expectedRoot.toString('hex'))
      await vi.advanceTimersByTimeAsync(5_000)
      assert.isUndefined((await head()).transactions)
    },
  )

  it.each(['node', 'provider', 'http'] as const)(
    'manual mining packs the queue and advances each block by the configured interval (%s)',
    async (controls) => {
      await setInterval(5, controls)
      const txs = [await transfer(100), await transfer(200)]
      for (const tx of txs) await send(tx)
      const before = nodeCore(node).head().number
      await mine(3, controls)
      const first = await post<Block>('wallet/getblockbynum', { num: Number(before + 1n) })
      assert.deepEqual(
        first.transactions!.map((tx) => tx.txID),
        txs.map((tx) => tx.txID),
      )
      for (let offset = 1; offset <= 3; offset++) {
        const block = await post<Block>('wallet/getblockbynum', { num: Number(before) + offset })
        assert.strictEqual(block.block_header.raw_data.timestamp, NOW + offset * 5_000)
        if (offset > 1) assert.isUndefined(block.transactions)
      }
      assert.strictEqual(nodeCore(node).clock.nowMs(), NOW + 15_000)
    },
  )

  it('switching back to zero drains queued transactions into separate blocks', async () => {
    await setInterval(5)
    const before = nodeCore(node).head().number
    const txs = [await transfer(100), await transfer(200)]
    for (const tx of txs) await send(tx)
    await setInterval(0)
    assert.strictEqual(nodeCore(node).head().number, before + 2n)
    assert.strictEqual((await info(txs[0].txID)).blockNumber, Number(before + 1n))
    assert.strictEqual((await info(txs[1].txID)).blockNumber, Number(before + 2n))
    await vi.advanceTimersByTimeAsync(10_000)
    assert.strictEqual(nodeCore(node).head().number, before + 2n)
    await send(await transfer(300))
    assert.strictEqual(nodeCore(node).head().number, before + 3n)
  })

  it('rolls back a host execution failure and keeps its pending transaction retryable', async () => {
    await setInterval(5)
    const tx = await transfer(123)
    await send(tx)
    const core = nodeCore(node)
    const before = core.head().number
    const held = await balance()
    const failure = vi
      .spyOn(core.vm.tvm, 'runCall')
      .mockRejectedValueOnce(new Error('host failure'))
    try {
      await rejects(mine(), /host failure/)
      assert.strictEqual(core.head().number, before)
      assert.strictEqual(await balance(), held)
      assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 1 })
    } finally {
      failure.mockRestore()
    }
    await mine()
    assert.strictEqual((await info(tx.txID)).blockNumber, Number(before + 1n))
    assert.strictEqual(await balance(), held + 123)
  })

  it('replacing an interval preserves the queue and cancels the previous timer', async () => {
    await setInterval(5)
    const tx = await transfer(100)
    await send(tx)
    await rejects(node.tre.blockTime(61), /must be/)
    await setInterval(10)
    const before = nodeCore(node).head().number
    await vi.advanceTimersByTimeAsync(5_000)
    assert.strictEqual(nodeCore(node).head().number, before)
    await vi.advanceTimersByTimeAsync(5_000)
    assert.strictEqual(nodeCore(node).head().number, before + 1n)
    assert.strictEqual((await info(tx.txID)).blockNumber, Number(before + 1n))
  })

  it('recovers a failed switch to instant mode without losing or reordering queued transactions', async () => {
    await setInterval(5)
    const txs = [await transfer(100), await transfer(200), await transfer(300)]
    await send(txs[0])
    await send(txs[1])
    const before = await probeState(node)
    const cause = new Error('seal unavailable')
    const seal = vi.spyOn(nodeCore(node), 'sealBlock').mockRejectedValueOnce(cause)
    await rejects(node.tre.blockTime(0), (error: BlockTimeChangeError) => {
      assert.instanceOf(error, BlockTimeChangeError)
      assert.strictEqual(error.cause, cause)
      assert.deepEqual(error.data, {
        requestedBlockTime: 0,
        activeBlockTime: 5,
        committedTransactionIds: [],
        pendingTransactionIds: txs.slice(0, 2).map((tx) => tx.txID),
      })
      return true
    })
    assert.deepEqual(await probeState(node), before)
    seal.mockRestore()
    await send(txs[2])
    assert.strictEqual(nodeCore(node).head().number, before.height)
    assert.deepEqual(
      nodeCore(node).pendingIds(),
      txs.map((tx) => tx.txID),
    )
    await setInterval(0)
    for (const [index, tx] of txs.entries()) {
      const receipt = await info(tx.txID)
      assert.strictEqual(receipt.blockNumber, Number(before.height) + index + 1)
      const block = await post<Block>('wallet/getblockbynum', { num: receipt.blockNumber })
      assert.deepEqual(
        block.transactions!.map((entry) => entry.txID),
        [tx.txID],
      )
    }
  })

  it.each(['node', 'provider', 'http'] as const)(
    'keeps the original interval after a partially committed instant switch through %s',
    async (controls) => {
      await setInterval(60, controls)
      const core = nodeCore(node)
      const before = core.head().number
      const held = await balance()
      const txs = [await transfer(100), await transfer(200)]
      for (const tx of txs) {
        tx.raw_data.expiration = NOW + 600_000
        await send(sign(tx))
        assert.isEmpty(await info(tx.txID))
      }
      assert.deepEqual(
        core.pendingIds(),
        txs.map((tx) => tx.txID),
      )
      assert.strictEqual(core.head().number, before)
      // A failed switch must preserve the original tick, not restart its 60-second wait.
      await vi.advanceTimersByTimeAsync(20_000)
      const sealBlock = core.sealBlock.bind(core)
      const cause = new Error('seal unavailable')
      const seal = vi
        .spyOn(core, 'sealBlock')
        .mockImplementationOnce(sealBlock)
        .mockRejectedValueOnce(cause)
      let failure: { message: string; data?: unknown } | undefined
      if (controls === 'http') {
        const reply = await post<{
          result?: unknown
          error: { code: number; message: string; data?: unknown }
        }>('tre', { jsonrpc: '2.0', id: 1, method: 'tre_blockTime', params: [0] })
        assert.isUndefined(reply.result)
        assert.strictEqual(reply.error.code, -32000)
        assert.match(reply.error.message, /seal unavailable/)
        failure = reply.error
      } else {
        await rejects(setInterval(0, controls), (error: BlockTimeChangeError) => {
          assert.instanceOf(error, BlockTimeChangeError)
          assert.strictEqual(error.cause, cause)
          assert.match(error.message, /seal unavailable/)
          failure = error
          return true
        })
      }
      seal.mockRestore()
      const firstReceipt = await info(txs[0].txID)
      assert.strictEqual(firstReceipt.blockNumber, Number(before + 1n))
      assert.strictEqual(firstReceipt.blockTimeStamp, NOW)
      assert.isEmpty(await info(txs[1].txID))
      assert.strictEqual(core.head().number, before + 1n)
      assert.strictEqual(await balance(), held + 100)
      assert.deepEqual(core.pendingIds(), [txs[1].txID])
      await vi.advanceTimersByTimeAsync(39_999)
      assert.strictEqual((await head()).block_header.raw_data.number, Number(before + 1n))
      await vi.advanceTimersByTimeAsync(1)
      const secondReceipt = await info(txs[1].txID)
      assert.strictEqual(secondReceipt.blockNumber, Number(before + 2n))
      assert.strictEqual(secondReceipt.blockTimeStamp, NOW + 60_000)
      assert.deepEqual(await info(txs[0].txID), firstReceipt)
      assert.strictEqual(await balance(), held + 300)
      assert.deepEqual(core.pendingIds(), [])
      assert.deepEqual(
        core.blocks
          .range(before + 1n, core.head().number + 1n)
          .map((block) => block.txs.map((tx) => tx.txid)),
        [[txs[0].txID], [txs[1].txID]],
      )
      assert.deepEqual(failure?.data, {
        requestedBlockTime: 0,
        activeBlockTime: 60,
        committedTransactionIds: [txs[0].txID],
        pendingTransactionIds: [txs[1].txID],
      })
    },
  )

  it('rejects pending duplicates and owns a copy of programmatically submitted transactions', async () => {
    await setInterval(5)
    const tx = await transfer(123)
    const original = structuredClone(tx)
    const held = await balance()
    const sent = await provider.request({
      method: 'wallet/broadcasttransaction',
      params: tx as never,
    })
    assert.isTrue((sent as { result: boolean }).result)
    assert.strictEqual(
      (await post('wallet/broadcasttransaction', original)).code,
      'DUP_TRANSACTION_ERROR',
    )
    tx.raw_data.contract[0].parameter.value.amount = 999_999
    tx.signature = []
    await mine()
    assert.strictEqual(await balance(), held + 123)
    assert.strictEqual(
      (await post('wallet/broadcasttransaction', original)).code,
      'DUP_TRANSACTION_ERROR',
    )
    assert.lengthOf((await head()).transactions!, 1)
  })

  it.each(
    [65_000, 86_400_001].flatMap((idleMs) =>
      [0, 5].flatMap((seconds) =>
        ['node', 'TronWeb'].map((builder) => ({ idleMs, seconds, builder })),
      ),
    ),
  )(
    'mines a $builder transfer after $idleMs ms idle with block time $seconds',
    async ({ idleMs, seconds, builder }) => {
      await setInterval(seconds)
      const before = await head()
      const held = await balance()
      clock.advanceMs(idleMs)
      assert.deepEqual(await head(), before)
      const tx =
        builder === 'node'
          ? await transfer(100)
          : ((await tronWeb.trx.sign(
              await tronWeb.transactionBuilder.sendTrx(
                TronWeb.address.fromHex(receiver),
                100,
                TronWeb.address.fromHex(owner),
              ),
            )) as unknown as SignedTronTx)
      assert.strictEqual(tx.raw_data.expiration, before.block_header.raw_data.timestamp + 60_000)
      await send(tx)
      if (seconds > 0) {
        assert.deepEqual(await head(), before)
        assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 1 })
        await mine()
      }
      const block = await head()
      assert.strictEqual(
        block.block_header.raw_data.number,
        before.block_header.raw_data.number + 1,
      )
      assert.isAtLeast(block.block_header.raw_data.timestamp, NOW + idleMs)
      assert.deepEqual(
        block.transactions!.map((entry) => entry.txID),
        [tx.txID],
      )
      assert.strictEqual((await info(tx.txID)).blockNumber, block.block_header.raw_data.number)
      assert.strictEqual(await balance(), held + 100)
    },
  )

  it.each([0, 2_999, 3_000, 3_001, 86_400_000, 86_400_001])(
    'checks expiration at head + %s ms even when the clock is ahead',
    async (offset) => {
      const before = await head()
      const held = await balance()
      clock.advanceMs(65_000)
      const tx = await transfer(100)
      tx.raw_data.expiration = before.block_header.raw_data.timestamp + offset
      sign(tx)
      const reply = await post('wallet/broadcasttransaction', tx)
      if (offset >= 3_000 && offset <= 86_400_000) {
        assert.isTrue(reply.result, JSON.stringify(reply))
        assert.strictEqual(await balance(), held + 100)
      } else {
        assert.strictEqual(reply.code, 'TRANSACTION_EXPIRATION_ERROR')
        assert.deepEqual(await head(), before)
        assert.strictEqual(await balance(), held)
      }
    },
  )

  it('keeps candidates valid against the head when the new block crosses their expiration', async () => {
    await setInterval(5)
    const shortLived = await transfer(100)
    shortLived.raw_data.expiration = NOW + 4_000
    sign(shortLived)
    const valid = await transfer(200)
    const held = await balance()
    await send(shortLived)
    await send(valid)
    assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 2 })
    await mine()
    assert.strictEqual(
      (await info(shortLived.txID)).blockNumber,
      (await info(valid.txID)).blockNumber,
    )
    assert.deepEqual(
      (await head()).transactions!.map((tx) => tx.txID),
      [shortLived.txID, valid.txID],
    )
    assert.strictEqual(await balance(), held + 300)
    assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 0 })
    assert.isEmpty(await post('wallet/gettransactionfrompending', { value: shortLived.txID }))
  })

  it('rechecks expiration against the updated head when draining successive blocks', async () => {
    await setInterval(60)
    const first = await transfer(100)
    const expired = await transfer(200)
    expired.raw_data.expiration = NOW + 4_000
    sign(expired)
    const last = await transfer(300)
    const before = await head()
    const held = await balance()
    for (const tx of [first, expired, last]) await send(tx)
    clock.advanceMs(5_000)
    await setInterval(0)
    assert.strictEqual(
      (await head()).block_header.raw_data.number,
      before.block_header.raw_data.number + 2,
    )
    assert.strictEqual(
      (await info(last.txID)).blockNumber,
      (await info(first.txID)).blockNumber + 1,
    )
    assert.isEmpty(await info(expired.txID))
    assert.strictEqual(await balance(), held + 400)
    assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 0 })
  })

  it.each([0, 5])(
    'rejects an overdrawn broadcast before admission with block time %s',
    async (seconds) => {
      await setInterval(seconds)
      const tx = await transfer(1)
      tx.raw_data.contract[0].parameter.value.amount = 11_000_000_000
      sign(tx)
      const before = await probeState(node)
      const reply = await post('wallet/broadcasttransaction', tx)
      assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
      assert.include(TronWeb.toUtf8(String(reply.message)), 'balance is not sufficient')
      assert.deepEqual(await probeState(node), before)
      await mine()
      assert.isEmpty(await info(tx.txID))
      assert.isUndefined((await head()).transactions)
    },
  )

  it.each([0, 5])(
    'rejects unpaid resource fees without changing state with block time %s',
    async (seconds) => {
      await setInterval(seconds)
      await node.tre.setAccountBalance(owner, 100)
      const tx = await transfer(1)
      tx.raw_data.data = 'ff'
      sign(tx)
      const before = await probeState(node)
      const reply = (await provider.request({
        method: 'wallet/broadcasttransaction',
        params: tx as never,
      })) as { code: string }
      assert.strictEqual(reply.code, 'BANDWITH_ERROR')
      assert.deepEqual(await probeState(node), before)
      await mine()
      assert.isEmpty(await info(tx.txID))
    },
  )

  it('rejects cumulative overspending at admission without undoing earlier or blocking later transactions', async () => {
    await setInterval(5)
    const ownerBefore = await balance(owner)
    const receiverBefore = await balance()
    const first = await transfer(9_000_000_000)
    const invalid = await transfer(2_000_000_000)
    const last = await transfer(1_000_000)
    await send(first)
    const beforeInvalid = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', invalid)
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.deepEqual(await probeState(node), beforeInvalid)
    await send(last)
    await mine()
    assert.deepEqual(
      (await head()).transactions!.map((tx) => tx.txID),
      [first.txID, last.txID],
    )
    assert.isEmpty(await info(invalid.txID))
    const fees =
      Number((await info(first.txID)).fee ?? 0) + Number((await info(last.txID)).fee ?? 0)
    assert.strictEqual(await balance(owner), ownerBefore - 9_001_000_000 - fees)
    assert.strictEqual(await balance(), receiverBefore + 9_001_000_000)
  })

  it('admits a transfer funded by a preceding pending transaction without exposing or charging the preview', async () => {
    await setInterval(5)
    const newKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const newOwner = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(newKey) as string)
    const funding = await transfer(20_000_000)
    funding.raw_data.contract[0].parameter.value.to_address = newOwner
    sign(funding)
    const spend = await transfer(5_000_000)
    spend.raw_data.contract[0].parameter.value.owner_address = newOwner
    sign(spend, newKey)
    const before = await probeState(node)
    await send(funding)
    await send(spend)
    assert.deepEqual(await probeState(node), before)
    assert.strictEqual(await balance(newOwner), 0)
    assert.isEmpty(await info(spend.txID))
    await mine()
    assert.deepEqual(
      (await head()).transactions!.map((tx) => tx.txID),
      [funding.txID, spend.txID],
    )
    assert.strictEqual(
      await balance(newOwner),
      15_000_000 - Number((await info(spend.txID)).fee ?? 0),
    )
  })

  it('admits a call to a contract deployed by a preceding pending transaction', async () => {
    await setInterval(5)
    const before = await probeState(node)
    const contract = await deploy()
    const tx = await transfer(1)
    tx.raw_data.contract = [
      {
        type: 'TriggerSmartContract',
        parameter: {
          type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
          value: { owner_address: owner, contract_address: contract, data: '00000001' },
        },
      },
    ]
    tx.raw_data.fee_limit = 100_000_000
    await send(sign(tx))
    assert.deepEqual(await probeState(node), before)
    assert.isEmpty(await info(tx.txID))
    await mine()
    assert.lengthOf((await head()).transactions!, 2)
    const receipt = await info(tx.txID)
    assert.strictEqual(BigInt(`0x${receipt.contractResult[0].slice(0, 64)}`), 1n)
  })

  it('checks signatures against permissions updated by a preceding pending transaction', async () => {
    await setInterval(5)
    const newKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const signer = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(newKey) as string)
    const keys = [{ address: signer, weight: 1 }]
    const update = await post<SignedTronTx>('wallet/accountpermissionupdate', {
      owner_address: owner,
      owner: { type: 0, permission_name: 'owner', threshold: 1, keys },
      actives: [
        {
          type: 2,
          permission_name: 'active',
          threshold: 1,
          operations: '7fff1fc0033ec30f000000000000000000000000000000000000000000000000',
          keys,
        },
      ],
    })
    const before = await probeState(node)
    await send(sign(update))
    const oldSignature = await transfer(100)
    assert.strictEqual((await post('wallet/broadcasttransaction', oldSignature)).code, 'SIGERROR')
    const newSignature = sign(await transfer(200), newKey)
    await send(newSignature)
    assert.deepEqual(await probeState(node), before)
    await mine()
    assert.deepEqual(
      (await head()).transactions!.map((tx) => tx.txID),
      [update.txID, newSignature.txID],
    )
  })

  it('keeps pending staking records and weights private across dependent transactions', async () => {
    await setInterval(5)
    const freeze = await post<SignedTronTx>('wallet/freezebalancev2', {
      owner_address: owner,
      frozen_balance: 1_000_000,
      resource: 'ENERGY',
    })
    const unfreeze = await transfer(1)
    unfreeze.raw_data.contract = [
      {
        type: 'UnfreezeBalanceV2Contract',
        parameter: {
          type_url: 'type.googleapis.com/protocol.UnfreezeBalanceV2Contract',
          value: { owner_address: owner, unfreeze_balance: 1_000_000, resource: 'ENERGY' },
        },
      },
    ]
    const before = await probeState(node)
    await send(sign(freeze))
    await send(sign(unfreeze))
    assert.deepEqual(await probeState(node), before)
    await mine()
    assert.deepEqual(
      (await head()).transactions!.map((tx) => tx.txID),
      [freeze.txID, unfreeze.txID],
    )
    const account = await post('wallet/getaccount', { address: owner })
    assert.deepEqual(
      (account.unfrozenV2 as { unfreeze_amount: number }[]).map((entry) => entry.unfreeze_amount),
      [1_000_000],
    )
    assert.strictEqual(nodeCore(node).totalEnergyWeightTrx, 0n)
  })

  it('copies existing asset metadata and continues asset IDs in pending state', async () => {
    const issue = async (address: string, name: string) =>
      post<SignedTronTx>('wallet/createassetissue', {
        owner_address: address,
        name: TronWeb.fromUtf8(name).slice(2),
        abbr: '544b',
        total_supply: 1000,
        trx_num: 1,
        num: 1,
        start_time: NOW + 60_000,
        end_time: NOW + 86_400_000,
        url: TronWeb.fromUtf8('https://example.invalid').slice(2),
      })
    await send(sign(await issue(owner, 'First')))
    await setInterval(5)
    const before = await probeState(node)
    const update = await post<SignedTronTx>('wallet/updateasset', {
      owner_address: owner,
      description: '75706461746564',
      url: '68747470733a2f2f782e74657374',
      new_limit: 0,
      new_public_limit: 0,
    })
    await send(sign(update))
    const receiverKey = (await node.admin.accounts()).privateKeys[1]
    await send(sign(await issue(receiver, 'Second'), receiverKey))
    assert.deepEqual(await probeState(node), before)
    await mine()
    const assets = (await post('wallet/getassetissuelist', {})).assetIssue as {
      id: string
      description?: string
    }[]
    assert.deepEqual(
      assets.map((asset) => asset.id),
      ['1000001', '1000002'],
    )
    assert.strictEqual(assets[0].description, '75706461746564')
  })

  it('rolls back a failed admission preview and preserves the existing queue for retry', async () => {
    await setInterval(5)
    const first = await transfer(100)
    const second = await transfer(200)
    await send(first)
    const before = await probeState(node)
    const execute = NodeCore.prototype.execute
    const fault = vi.spyOn(NodeCore.prototype, 'execute').mockImplementationOnce(async function (
      this: NodeCore,
      params,
    ) {
      await execute.call(this, params)
      throw new Error('execution unavailable')
    })
    await rejects(
      provider.request({ method: 'wallet/broadcasttransaction', params: second as never }),
      /execution unavailable/,
    )
    fault.mockRestore()
    assert.deepEqual(await probeState(node), before)
    await send(second)
    await mine()
    assert.deepEqual(
      (await head()).transactions!.map((tx) => tx.txID),
      [first.txID, second.txID],
    )
  })

  it('executes each admission once and keeps its cumulative state private', async () => {
    await setInterval(5)
    const before = await probeState(node)
    const execute = vi.spyOn(NodeCore.prototype, 'execute')
    for (let i = 1; i <= 30; i++) await send(await transfer(i))
    assert.strictEqual(execute.mock.calls.length, 30)
    assert.deepEqual(await probeState(node), before)
    await mine()
    assert.strictEqual(execute.mock.calls.length, 60)
    assert.lengthOf((await head()).transactions!, 30)
  })

  it.each(['node', 'provider', 'http'] as const)(
    'serves the live pending queue with %s mining controls',
    async (controls) => {
      const query = async (method: string, params: Record<string, unknown> = {}) =>
        controls === 'http'
          ? post(method, params)
          : ((await provider.request({ method, params: params as never })) as Record<
              string,
              unknown
            >)
      await setInterval(5, controls)
      assert.deepEqual(await query('wallet/getpendingsize'), { pendingSize: 0 })
      assert.isEmpty(await query('wallet/gettransactionlistfrompending'))
      const first = await transfer(101)
      const second = await transfer(202)
      await send(first)
      await send(second)
      const duplicate = await post('wallet/broadcasttransaction', first)
      assert.strictEqual(duplicate.code, 'DUP_TRANSACTION_ERROR')
      assert.deepEqual(await query('wallet/getpendingsize'), { pendingSize: 2 })
      assert.deepEqual(await query('wallet/gettransactionlistfrompending'), {
        txId: [first.txID, second.txID],
      })
      const held = await query('wallet/gettransactionfrompending', { value: first.txID })
      assert.strictEqual(held.txID, first.txID)
      assert.deepEqual(held.raw_data, first.raw_data)
      assert.deepEqual(held.signature, first.signature)
      assert.deepEqual(held.ret, [{ contractRet: 'SUCCESS' }])
      const visible = await query('wallet/gettransactionfrompending', {
        value: first.txID,
        visible: true,
      })
      const raw = visible.raw_data as SignedTronTx['raw_data']
      assert.strictEqual(
        raw.contract[0].parameter.value.owner_address,
        TronWeb.address.fromHex(owner),
      )
      raw.contract[0].parameter.value.amount = 999
      assert.deepEqual(await query('wallet/gettransactionfrompending', { value: first.txID }), held)
      assert.isEmpty(await query('wallet/gettransactionfrompending', { value: 'ff'.repeat(32) }))
      assert.isEmpty(await info(first.txID))
      await mine(1, controls)
      assert.deepEqual(await query('wallet/getpendingsize'), { pendingSize: 0 })
      assert.isEmpty(await query('wallet/gettransactionlistfrompending'))
      assert.isEmpty(await query('wallet/gettransactionfrompending', { value: first.txID }))
      assert.strictEqual((await info(first.txID)).blockNumber, Number(nodeCore(node).head().number))
    },
  )

  it('rebuilds pending state after a development balance write', async () => {
    await setInterval(5)
    await send(await transfer(9_000_000_000))
    // The development write seals a block and rejects the now-unfundable candidate.
    await node.tre.setAccountBalance(owner, 1_000_000_000n)
    assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 0 })
    await send(await transfer(500_000_000))
    assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 1 })
    await mine()
    assert.lengthOf((await head()).transactions!, 1)
    assert.strictEqual(await balance(owner), 500_000_000)
  })

  it('rolls back development writes and preserves pending state when their block fails', async () => {
    await setInterval(5)
    const first = await transfer(900_000_000)
    await send(first)
    const before = await probeState(node)
    const held = await balance(owner)
    const writes = [
      () => node.tre.setAccountBalance(owner, 500_000_000n),
      () => node.tre.setAccountCode(receiver, '0x6000'),
      () => node.tre.setAccountStorageAt(receiver, '0x01', '0x02'),
    ]
    for (const write of writes) {
      const seal = vi
        .spyOn(nodeCore(node), 'sealBlock')
        .mockRejectedValueOnce(new Error('seal unavailable'))
      await rejects(write(), /seal unavailable/)
      seal.mockRestore()
      assert.deepEqual(await probeState(node), before)
      assert.strictEqual(await balance(owner), held)
      assert.deepEqual(await post('wallet/getpendingsize', {}), { pendingSize: 1 })
    }
    const second = await transfer(600_000_000)
    await send(second)
    await mine()
    assert.deepEqual(
      (await head()).transactions!.map((tx) => tx.txID),
      [first.txID, second.txID],
    )
    assert.strictEqual(await balance(owner), held - 1_500_000_000)
  })

  it('rolls back account generation and balance reset when their block fails', async () => {
    const core = nodeCore(node)
    const originalAccounts = await node.admin.accounts()
    const originalBatches = core.generatedAccounts.length
    const beforeGeneration = await probeState(node)
    let seal = vi.spyOn(core, 'sealBlock').mockRejectedValueOnce(new Error('seal unavailable'))
    await rejects(node.admin.temporaryAccountsGeneration({ accounts: 2 }), /seal unavailable/)
    seal.mockRestore()
    assert.deepEqual(await probeState(node), beforeGeneration)
    assert.deepEqual(await node.admin.accounts(), originalAccounts)
    assert.lengthOf(core.generatedAccounts, originalBatches)

    await node.tre.setAccountBalance(owner, 123n)
    const beforeReset = await probeState(node)
    seal = vi.spyOn(core, 'sealBlock').mockRejectedValueOnce(new Error('seal unavailable'))
    await rejects(node.admin.accountsGeneration(), /seal unavailable/)
    seal.mockRestore()
    assert.deepEqual(await probeState(node), beforeReset)
    assert.strictEqual(await balance(owner), 123)
  })

  it('restores the clock and chain state when an increased-time block fails', async () => {
    const core = nodeCore(node)
    const before = await probeState(node)
    const time = core.clock.nowMs()
    const seal = vi.spyOn(core, 'sealBlock').mockRejectedValueOnce(new Error('seal unavailable'))
    await rejects(node.tre.increaseTime(60), /seal unavailable/)
    seal.mockRestore()
    assert.deepEqual(await probeState(node), before)
    assert.strictEqual(core.clock.nowMs(), time)
  })

  it('keeps admission VM state in the empty-block context between broadcasts', async () => {
    const contract = `41${'88'.repeat(20)}`
    const consoleAddress = '000000000000000000636f6e736f6c652e6c6f67'
    // Log the previous NUMBER, then store the current NUMBER.
    const runtime = `6000546000526000600060206000600073${consoleAddress}61fffff1504360005500`
    await node.tre.setAccountCode(contract, `0x${runtime}`)
    await setInterval(5)
    await send(await call(contract, 1))
    const second = await call(contract, 2)
    const reply = await post('wallet/broadcasttransaction', second)
    const numberOf = (reply: Record<string, unknown>) =>
      BigInt(`0x${(reply.internal_transactions as { data: string }[])[0].data}`)
    assert.strictEqual(numberOf(reply), 0n)
    await mine()
    const receipt = await post('wallet/gettransactioninfobyid', { value: second.txID })
    assert.strictEqual(numberOf(receipt), BigInt(Number(receipt.blockNumber)))
  })

  it.each([0, 5])(
    'previews at the current head and executes at the produced block: %s seconds',
    async (seconds) => {
      const contract = `41${'88'.repeat(20)}`
      const consoleAddress = '000000000000000000636f6e736f6c652e6c6f67'
      const runtime = `42600052436020526000600060406000600073${consoleAddress}61fffff15000`
      await node.tre.setAccountCode(contract, `0x${runtime}`)
      await setInterval(seconds)
      const previous = await head()
      nodeCore(node).clock.advanceMs(1000)
      const tx = await call(contract, 1)
      const reply = await post('wallet/broadcasttransaction', tx)
      assert.isTrue(reply.result)
      const dataOf = (reply: Record<string, unknown>) => {
        const data = (reply.internal_transactions as { data: string }[])[0].data
        return [BigInt(`0x${data.slice(0, 64)}`), BigInt(`0x${data.slice(64)}`)]
      }
      assert.deepEqual(dataOf(reply), [
        BigInt(previous.block_header.raw_data.timestamp / 1000),
        BigInt(previous.block_header.raw_data.number),
      ])
      if (seconds > 0) await mine()
      const receipt = await post('wallet/gettransactioninfobyid', { value: tx.txID })
      assert.deepEqual(dataOf(receipt), [
        BigInt(Number(receipt.blockTimeStamp) / 1000),
        BigInt(Number(receipt.blockNumber)),
      ])
    },
  )

  it.each([0, 5].flatMap((seconds) => [false, true].map((reverted) => ({ seconds, reverted }))))(
    'returns console-call data at admission and preserves it in the receipt: $seconds seconds, reverted=$reverted',
    async ({ seconds, reverted }) => {
      const consoleAddress = '000000000000000000636f6e736f6c652e6c6f67'
      const contract = `41${'88'.repeat(20)}`
      const runtime = `63f82c50f160e01b600052602a6004526000600060246000600073${consoleAddress}61fffff150${reverted ? '60006000fd' : '00'}`
      await node.tre.setAccountCode(contract, `0x${runtime}`)
      await setInterval(seconds)
      const tx = await call(contract, 1)
      const before = await probeState(node)
      const held = await balance(owner)
      const reply = await post('wallet/broadcasttransaction', tx)
      assert.isTrue(reply.result)
      const internals = reply.internal_transactions as Record<string, unknown>[]
      assert.lengthOf(internals, 1)
      const expectedData = `f82c50f1${'0'.repeat(62)}2a`
      assert.strictEqual(internals[0].transferTo_address, `41${consoleAddress}`)
      assert.strictEqual(internals[0].data, expectedData)
      assert.strictEqual(internals[0].rejected === true, reverted)
      if (seconds > 0) {
        assert.deepEqual(await probeState(node), before)
        assert.isEmpty(await info(tx.txID))
        internals[0].data = '00'
        await mine()
      }
      const receipt = await post('wallet/gettransactioninfobyid', { value: tx.txID })
      const mined = receipt.internal_transactions as Record<string, unknown>[]
      assert.strictEqual(mined[0].data, expectedData)
      assert.strictEqual(mined[0].rejected === true, reverted)
      assert.strictEqual(await balance(owner), held - Number(receipt.fee ?? 0))
    },
  )

  it('preserves the entire queue and state when sealing fails, then retries without duplicates', async () => {
    await setInterval(5)
    const txs = [await transfer(100), await transfer(200)]
    for (const tx of txs) await send(tx)
    const before = await probeState(node)
    const time = nodeCore(node).clock.nowMs()
    const seal = vi
      .spyOn(nodeCore(node), 'sealBlock')
      .mockRejectedValueOnce(new Error('seal unavailable'))
    await rejects(node.tre.mine(), /seal unavailable/)
    assert.deepEqual(await probeState(node), before)
    assert.strictEqual(nodeCore(node).clock.nowMs(), time)
    assert.strictEqual(
      (await post('wallet/broadcasttransaction', txs[0])).code,
      'DUP_TRANSACTION_ERROR',
    )
    seal.mockRestore()
    await mine()
    assert.deepEqual(
      (await head()).transactions!.map((tx) => tx.txID),
      txs.map((tx) => tx.txID),
    )
  })

  it('notifies block observers after receipts commit and keeps failed blocks quiet', async () => {
    await setInterval(5)
    const txs = [await transfer(100), await transfer(200)]
    for (const tx of txs) await send(tx)
    const core = nodeCore(node)
    logged.length = 0
    const before = await probeState(node)
    const seen: { number: bigint; txids: string[]; indexed: boolean }[] = []
    core.onBlock((block) => {
      seen.push({
        number: block.number,
        txids: block.txs.map((tx) => tx.txid),
        indexed: block.txs.every((tx) => core.txs.get(tx.txid)?.blockNumber === block.number),
      })
    })
    const sealBlock = core.sealBlock.bind(core)
    vi.spyOn(core, 'sealBlock').mockImplementationOnce(async (...params) => {
      await sealBlock(...params)
      throw new Error('seal failed after writing block')
    })
    await rejects(node.tre.mine(), /seal failed after writing block/)
    assert.deepEqual(await probeState(node), before)
    assert.isEmpty(seen)
    assert.isFalse(logged.some((line) => line.includes('Produced block')))

    await mine()
    assert.deepEqual(seen, [
      { number: nodeCore(node).head().number, txids: txs.map((tx) => tx.txID), indexed: true },
    ])
    assert.lengthOf(
      logged.filter((line) => line.includes('Produced block')),
      1,
    )
    assert.match(logged.find((line) => line.includes('Produced block'))!, /txs=2$/)
  })

  it('keeps mining and other observers intact when a listener fails, and supports removal', async () => {
    const core = nodeCore(node)
    const failing = vi.fn(() => {
      throw new Error('output unavailable')
    })
    const removeFailing = core.onBlock(failing)
    const seen: bigint[] = []
    const remove = core.onBlock((block) => {
      seen.push(block.number)
    })
    assert.isEmpty(seen)
    const first = await node.tre.mine()
    assert.deepEqual(seen, [first.number])
    assert.strictEqual(failing.mock.calls.length, 1)
    remove()
    removeFailing()
    await node.tre.mine()
    assert.strictEqual(nodeCore(node).head().number, first.number + 1n)
    assert.deepEqual(seen, [first.number])
    assert.strictEqual(failing.mock.calls.length, 1)
  })

  it('emits block notifications for mined transactions, not candidates expired by that block', async () => {
    await setInterval(60)
    await send(await transfer(200))
    const tx = await transfer(100)
    tx.raw_data.expiration = NOW + 4_000
    await send(sign(tx))
    const seen = vi.fn()
    logged.length = 0
    nodeCore(node).onBlock(seen)
    const before = nodeCore(node).head().number
    nodeCore(node).clock.advanceMs(5_000)
    await setInterval(0)
    assert.strictEqual(nodeCore(node).head().number, before + 1n)
    assert.strictEqual(seen.mock.calls.length, 1)
    assert.lengthOf(
      logged.filter((line) => line.includes('Transaction dropped')),
      1,
    )
    assert.include(
      logged.join('\n'),
      `WARN Transaction dropped txid=${tx.txID} reason=TRANSACTION_EXPIRATION_ERROR`,
    )
    assert.lengthOf(
      logged.filter((line) => line.includes('Produced block')),
      1,
    )
  })

  it('logs dropped transactions only after queue removal commits', async () => {
    await setInterval(60)
    const tx = await transfer(100)
    await send(tx)
    const valid = await transfer(200)
    valid.raw_data.contract[0].parameter.value.owner_address = receiver
    valid.raw_data.contract[0].parameter.value.to_address = owner
    await send(sign(valid, accountsFromMnemonic(resolveConfig().mnemonic)[1].privateKey))
    const core = nodeCore(node)
    logged.length = 0
    const droppedQueueSizes: number[] = []
    observeLog = (line) => {
      if (line.includes('Transaction dropped')) droppedQueueSizes.push(core.pendingSize())
    }
    const seal = core.sealBlock.bind(core)
    vi.spyOn(core, 'sealBlock').mockImplementationOnce(async (...args) => {
      await seal(...args)
      throw new Error('failed before commit')
    })
    // The failed balance change rolls back before it can remove or log either candidate.
    await rejects(node.tre.setAccountBalance(owner, 0), /failed before commit/)
    assert.strictEqual(core.pendingSize(), 2)
    assert.isFalse(logged.some((line) => /Transaction dropped|Produced block/.test(line)))
    logged.length = 0
    // A committed balance change invalidates the first candidate and mines the second.
    await node.tre.setAccountBalance(owner, 0)
    assert.strictEqual(core.pendingSize(), 0)
    assert.lengthOf(
      logged.filter((line) => line.includes('Transaction dropped')),
      1,
    )
    assert.include(logged.join('\n'), `txid=${tx.txID} reason=CONTRACT_VALIDATE_ERROR`)
    assert.deepEqual(droppedQueueSizes, [0])
    assert.lengthOf(
      logged.filter((line) => line.includes('Produced block')),
      1,
    )
    assert.match(logged.find((line) => line.includes('Produced block'))!, /txs=1$/)
  })

  it('routes background mining failures to the node logger and recovers on the next tick', async () => {
    logged.length = 0
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => {})
    const core = nodeCore(node)
    const before = core.head().number
    await node.tre.blockTime(1)
    vi.spyOn(core.stateManager, 'getStateRoot').mockRejectedValueOnce(
      new Error('private failure details'),
    )
    await vi.advanceTimersByTimeAsync(1000)
    assert.strictEqual(core.head().number, before)
    assert.lengthOf(
      logged.filter((line) => line.includes('ERROR Interval mining failed')),
      1,
    )
    assert.isFalse(logged.some((line) => line.includes('private failure details')))
    assert.strictEqual(fallback.mock.calls.length, 0)
    await vi.advanceTimersByTimeAsync(1000)
    assert.strictEqual(core.head().number, before + 1n)
    assert.lengthOf(
      logged.filter((line) => line.includes('Produced block')),
      1,
    )
    await node.tre.blockTime(0)
  })

  it('reports background failures without a configured logger', async () => {
    const quiet = await createNode({}, new Clock(() => NOW))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await quiet.tre.blockTime(1)
      vi.spyOn(nodeCore(quiet).stateManager, 'getStateRoot').mockRejectedValueOnce(
        new Error('private details'),
      )
      await vi.advanceTimersByTimeAsync(1000)
      assert.strictEqual(error.mock.calls.length, 1)
      assert.match(String(error.mock.calls[0][0]), /ERROR Interval mining failed$/)
      assert.notInclude(String(error.mock.calls[0][0]), 'private details')
    } finally {
      await quiet.tre.blockTime(0)
    }
  })

  it('executes calls in order with one block context and traces the second call from its own state', async () => {
    const contract = await deploy()
    await setInterval(5)
    const txs = [await call(contract, 1), await call(contract, 2)]
    for (const tx of txs) await send(tx)
    await mine()
    const block = await head()
    for (const [index, tx] of txs.entries()) {
      const receipt = await info(tx.txID)
      const output = receipt.contractResult[0]
      const words = [0, 1, 2].map((word) => BigInt(`0x${output.slice(word * 64, (word + 1) * 64)}`))
      assert.deepEqual(words, [
        BigInt(index + 1),
        BigInt(block.block_header.raw_data.number),
        BigInt((NOW + 5_000) / 1000),
      ])
      const trace = await rpc<{ returnValue: string; failed: boolean }>('debug_traceTransaction', [
        `0x${tx.txID}`,
      ])
      assert.isFalse(trace.failed)
      assert.strictEqual(trace.returnValue, output)
    }
  })

  it('includes a reverted call with a failed receipt and continues executing the same block', async () => {
    const counter = await deploy()
    const reverter = await deploy('60006000fd')
    await setInterval(5)
    const txs = [await call(counter, 1), await call(reverter, 2), await call(counter, 3)]
    for (const tx of txs) await send(tx)
    await mine()
    assert.deepEqual(
      (await head()).transactions!.map((tx) => tx.txID),
      txs.map((tx) => tx.txID),
    )
    const reverted = await post('wallet/gettransactioninfobyid', { value: txs[1].txID })
    assert.strictEqual(reverted.result, 'FAILED')
    assert.strictEqual(BigInt(`0x${(await info(txs[2].txID)).contractResult[0].slice(0, 64)}`), 2n)
    const trace = await rpc<{ returnValue: string }>('debug_traceTransaction', [`0x${txs[2].txID}`])
    assert.strictEqual(trace.returnValue, (await info(txs[2].txID)).contractResult[0])
  })

  it('batches transactions over real HTTP with a real interval timer', async () => {
    vi.useRealTimers()
    await setInterval(1)
    const txs = [await transfer(100), await transfer(200)]
    for (const tx of txs) await send(tx)
    assert.isEmpty(await info(txs[0].txID))
    let receipts: Info[] = []
    for (let attempt = 0; attempt < 60; attempt++) {
      receipts = await Promise.all(txs.map((tx) => info(tx.txID)))
      if (receipts.every((receipt) => receipt.blockNumber !== undefined)) break
      await delay(50)
    }
    assert.isNumber(receipts[0].blockNumber)
    assert.strictEqual(receipts[0].blockNumber, receipts[1].blockNumber)
  })
})
