import { TronWeb, utils } from 'tronweb'
import { assert, beforeEach, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { parseTronAddress, toTronHex } from '../../src/dialect/tron/address.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider, requestWire } from '../../src/provider.ts'

// Protocol decoding is tested separately from the program API's input normalization.
let node: TronNode
let provider: TronProvider
let ownerBase58 = ''

const call = async (method: string, params: unknown[]): Promise<unknown> =>
  requestWire(provider, { method, params })

const fails = async (method: string, params: unknown[]): Promise<string> => {
  try {
    await call(method, params)
  } catch (err) {
    return (err as Error).message
  }
  return 'no failure'
}

beforeEach(async () => {
  const config = resolveConfig()
  node = await TronNode.create(config)
  provider = new TronProvider(node)
  ownerBase58 = TronWeb.address.fromPrivateKey(
    accountsFromMnemonic(config.mnemonic)[0].privateKey,
  ) as string
})

describe('tre_setAccountBalance', () => {
  it('takes the amount as a number, a decimal string or 0x hex', async () => {
    const target = utils.accounts.generateAccount().address.base58
    const address = parseTronAddress(TronWeb.address.toHex(target))
    for (const [given, want] of [
      [1_000, 1_000n],
      ['2000', 2_000n],
      ['0x7d0', 2_000n],
    ] as [unknown, bigint][]) {
      await call('tre_setAccountBalance', [target, given])
      assert.strictEqual(await nodeCore(node).getBalance(address), want, String(given))
    }
  })

  it('refuses an amount it cannot read, and one below zero', async () => {
    const target = utils.accounts.generateAccount().address.base58
    const address = parseTronAddress(TronWeb.address.toHex(target))
    await call('tre_setAccountBalance', [target, 5_000])

    for (const amount of ['', 'abc', 1.5, Number.POSITIVE_INFINITY, '1e309', true, {}]) {
      assert.strictEqual(
        await fails('tre_setAccountBalance', [target, amount]),
        'integer decode error',
        String(amount),
      )
    }
    // an amount stated as nothing is judged by the rule that judges a negative
    for (const params of [
      [target, null],
      [target, -1],
      [target, '-5'],
    ]) {
      assert.strictEqual(
        await fails('tre_setAccountBalance', params),
        'balance can not be less than 0',
        JSON.stringify(params),
      )
    }
    // leaving it out is not an amount at all: the call names no method
    assert.strictEqual(await fails('tre_setAccountBalance', [target]), 'method parameters invalid')
    // past the int64 a balance sits in, the amount is not an amount either
    assert.strictEqual(
      await fails('tre_setAccountBalance', [target, '9223372036854775808']),
      'integer decode error',
    )
    // the balance is what it was before any of them
    assert.strictEqual(await nodeCore(node).getBalance(address), 5_000n)
  })

  it('takes an address in base58, or hex with 0x and 41 each optional', async () => {
    const base58 = utils.accounts.generateAccount().address.base58
    const tron = TronWeb.address.toHex(base58) as string
    const address = parseTronAddress(tron)
    for (const form of [base58, tron, `0x${tron}`, tron.slice(2), `0x${tron.slice(2)}`]) {
      await call('tre_setAccountBalance', [form, 11])
      assert.strictEqual(await nodeCore(node).getBalance(address), 11n, form)
      await call('tre_setAccountBalance', [form, 0])
    }
  })

  it('names the form an address failed, rather than the value it read', async () => {
    const base58 = utils.accounts.generateAccount().address.base58
    // a base58 address whose check digits do not add up
    const broken = `${base58.slice(0, 33)}${base58.endsWith('a') ? 'b' : 'a'}`
    assert.strictEqual(
      await fails('tre_setAccountBalance', [broken, 1]),
      'base58 address decode error',
    )
    for (const form of ['', 'nonsense', '0x1234', `41${'ab'.repeat(20)}00`, 42]) {
      assert.strictEqual(
        await fails('tre_setAccountBalance', [form, 1]),
        'invalid address',
        String(form),
      )
    }
  })
})

describe('tre_setAccountCode and tre_setAccountStorageAt', () => {
  const target = utils.accounts.generateAccount().address.base58

  it('plants runtime code, padding an odd digit count', async () => {
    await call('tre_setAccountCode', [target, '0x60006000f3'])
    const address = parseTronAddress(TronWeb.address.toHex(target))
    assert.strictEqual((await nodeCore(node).getCode(address)).length, 5)
    // an odd count is padded rather than refused
    await call('tre_setAccountCode', [target, '0xabc'])
    assert.strictEqual((await nodeCore(node).getCode(address)).length, 2)
  })

  it('takes hex only in the form that names itself as hex', async () => {
    for (const code of ['abc', '', 'nonsense', 42, null]) {
      assert.strictEqual(
        await fails('tre_setAccountCode', [target, code]),
        'hex must begin with 0x',
        String(code),
      )
    }
    assert.strictEqual(await fails('tre_setAccountCode', [target, '0xzz']), 'hex decode error')
  })

  it('holds a storage word to 32 bytes, and delivers a short one padded', async () => {
    const address = target
    await call('tre_setAccountStorageAt', [address, '0x01', '0x2a'])
    const range = (await call('debug_storageRangeAt', ['', 0, address, '', 10])) as {
      storage: Record<string, { value: string }>
    }
    // exactly the one slot the cheat write touched
    assert.lengthOf(Object.keys(range.storage), 1)

    for (const word of [`0x${'00'.repeat(33)}`, `0x${'ab'.repeat(40)}`]) {
      assert.strictEqual(
        await fails('tre_setAccountStorageAt', [address, word, '0x01']),
        'data word should not longer than 32 bytes',
        word,
      )
      assert.strictEqual(
        await fails('tre_setAccountStorageAt', [address, '0x01', word]),
        'data word should not longer than 32 bytes',
        word,
      )
    }
    assert.strictEqual(
      await fails('tre_setAccountStorageAt', [address, '01', '0x01']),
      'hex must begin with 0x',
    )
  })

  it('writes one storage slot, and reads it back through debug_storageRangeAt', async () => {
    const address = target
    await call('tre_setAccountCode', [address, '0x60006000f3'])
    await call('tre_setAccountStorageAt', [
      address,
      `0x${'00'.repeat(31)}01`,
      `0x${'00'.repeat(31)}2a`,
    ])
    const range = (await call('debug_storageRangeAt', [
      '',
      0,
      address,
      `0x${'00'.repeat(32)}`,
      10,
    ])) as {
      storage: Record<string, { value: string }>
    }
    const values = Object.values(range.storage).map((entry) => entry.value)
    assert.isTrue(
      values.some((value) => value.endsWith('2a')),
      JSON.stringify(values),
    )
  })
})

describe('the chain clock', () => {
  it('moves forward by the seconds it is given, and answers where it landed', async () => {
    await node.tre.mine(1)
    const before = nodeCore(node).head().timestampMs
    const landed = Number(await call('tre_increaseTime', [3_600]))
    // the jump is added to a head time that is itself the wall clock, so the
    // landing point is the offset plus however long sealing took
    assert.isAtLeast(landed - before, 3_600_000)
    assert.isBelow(landed - before, 3_601_000)
    assert.strictEqual(nodeCore(node).head().timestampMs, landed)
  })

  it('turns interval sealing on and back off', async () => {
    // the interval is what tre_blockTime sets, in seconds; zero clears it
    assert.isTrue(await call('tre_blockTime', [1]))
    assert.isTrue(await call('tre_blockTime', [0]))
  })

  it('seals the number of blocks asked for, and one when asked for nothing', async () => {
    const start = nodeCore(node).blocks.height()
    await call('tre_mine', [{ blocks: 3 }])
    assert.strictEqual(nodeCore(node).blocks.height() - start, 3n)
    await call('tre_mine', [])
    assert.strictEqual(nodeCore(node).blocks.height() - start, 4n)
  })
})

describe('tre_unlockedAccounts', () => {
  it('takes base58 and 0x-hex alike, and reads a lone value as a list of one', async () => {
    const evm = `0x${toTronHex(parseTronAddress(TronWeb.address.toHex(ownerBase58))).slice(2)}`
    await call('tre_unlockedAccounts', [[ownerBase58, evm]])
    assert.strictEqual(nodeCore(node).unlockedAccounts.size, 1)

    // an address stated on its own is a list of one
    const lone = utils.accounts.generateAccount().address.base58
    assert.isTrue(await call('tre_unlockedAccounts', [lone]))
    assert.strictEqual(nodeCore(node).unlockedAccounts.size, 2)
    assert.strictEqual(await fails('tre_unlockedAccounts', ['not a list']), 'invalid address')
    // a composite that is neither a list nor an address names nothing to unlock
    assert.strictEqual(await fails('tre_unlockedAccounts', [{}]), 'method parameters invalid')
    assert.strictEqual(nodeCore(node).unlockedAccounts.size, 2)
  })
})

describe('debug_traceTransaction', () => {
  it('says why a transaction cannot be replayed, rather than tracing nothing', async () => {
    // a bare txid never reaches the lookup
    assert.include(
      await fails('debug_traceTransaction', ['ab'.repeat(32)]),
      'hex must begin with 0x',
    )
    assert.include(await fails('debug_traceTransaction', [`0x${'ab'.repeat(32)}`]), 'not found')
  })

  it('walks the frames of one that did', async () => {
    const { privateKey } = utils.accounts.generateAccount()
    const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey })
    const other = utils.accounts.generateAccount().address.base58
    const built = (await requestWire(provider, {
      method: 'wallet/createtransaction',
      params: {
        owner_address: TronWeb.address.toHex(ownerBase58),
        to_address: TronWeb.address.toHex(other),
        amount: 1_000,
      },
    })) as Record<string, unknown>
    // over the wire the amount is a JSON number; the in-process reply keeps a
    // bigint, which the client-side signer cannot ingest — clone as a wire
    // reader would see it
    const wire = JSON.parse(
      JSON.stringify(built, (_key, held) => (typeof held === 'bigint' ? Number(held) : held)),
    ) as Record<string, unknown>
    const signed = await tronWeb.trx.sign(
      wire as never,
      accountsFromMnemonic(resolveConfig().mnemonic)[0]!.privateKey,
    )
    const sent = (await provider.request({
      method: 'wallet/broadcasttransaction',
      params: signed as never,
    })) as { txid?: string }
    const trace = (await call('debug_traceTransaction', [`0x${sent.txid}`])) as {
      structLogs?: unknown[]
      gas?: number
    }
    assert.isArray(trace.structLogs)
    // the txid is case-insensitive behind the 0x prefix
    const upper = (await call('debug_traceTransaction', [
      `0x${String(sent.txid).toUpperCase()}`,
    ])) as { structLogs?: unknown[] }
    assert.isArray(upper.structLogs)
  })
})

describe('dev RPC argument validation', () => {
  it('tre_mine bounds the count to (0, 100] and decodes integers strictly', async () => {
    const range = 'blocks should between (0, 100]'
    for (const blocks of [0, -1, 101]) {
      assert.strictEqual(await fails('tre_mine', [{ blocks }]), range, String(blocks))
    }
    // an options object without a usable count reads as zero, not as the default
    assert.strictEqual(await fails('tre_mine', [{}]), range)
    for (const blocks of ['foo', 2.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      assert.strictEqual(await fails('tre_mine', [{ blocks }]), 'integer decode error')
    }
    // strings carry decimal and 0x-hex integers
    const start = nodeCore(node).blocks.height()
    await call('tre_mine', [{ blocks: '3' }])
    await call('tre_mine', [{ blocks: '0x2' }])
    assert.strictEqual(nodeCore(node).blocks.height() - start, 5n)
  })

  it('tre_blockTime takes [0, 60] whole seconds only', async () => {
    assert.strictEqual(await fails('tre_blockTime', []), 'method parameters invalid')
    const range = 'block time should between [0, 60] in second'
    assert.strictEqual(await fails('tre_blockTime', [-1]), range)
    assert.strictEqual(await fails('tre_blockTime', [61]), range)
    assert.strictEqual(await fails('tre_blockTime', [null]), range)
    for (const seconds of ['foo', 2.5, Number.POSITIVE_INFINITY]) {
      assert.strictEqual(await fails('tre_blockTime', [seconds]), 'integer decode error')
    }
    assert.isTrue(await call('tre_blockTime', [60]))
    assert.isTrue(await call('tre_blockTime', [0]))
  })

  it('tre_increaseTime refuses what it cannot count, and the clock survives', async () => {
    await node.tre.mine(1)
    const before = nodeCore(node).head().timestampMs
    for (const seconds of ['foo', Number.POSITIVE_INFINITY, Number.NaN, 1.5]) {
      assert.strictEqual(await fails('tre_increaseTime', [seconds]), 'integer decode error')
    }
    // the refusals above must not have polluted the clock
    const landed = Number(await call('tre_increaseTime', [60]))
    assert.isFinite(landed)
    assert.isAtLeast(landed - before, 60_000)
  })

  it('debug_storageRangeAt serves the head under any of its names, nothing older', async () => {
    const target = utils.accounts.generateAccount().address.base58
    await call('tre_setAccountCode', [target, '0x60006000f3'])
    // two blocks in, so one-before-head is a real block
    await node.tre.mine(2)
    const head = nodeCore(node).head()
    const key = `0x${'00'.repeat(32)}`
    for (const ref of [
      '',
      'latest',
      null,
      0,
      '0',
      '0x0',
      Number(head.number),
      String(head.number),
      `0x${head.number.toString(16)}`,
      `0x${head.blockID}`,
      head.blockID.toUpperCase(),
    ]) {
      const range = (await call('debug_storageRangeAt', [ref, 0, target, key, 5])) as {
        storage: unknown
      }
      assert.isDefined(range.storage, String(ref))
    }
    const latestOnly = 'only the latest/current state is supported'
    for (const ref of [
      Number(head.number) - 1,
      Number(head.number) + 1,
      -1,
      'earliest',
      'pending',
      true,
    ]) {
      assert.strictEqual(
        await fails('debug_storageRangeAt', [ref, 0, target, key, 5]),
        latestOnly,
        String(ref),
      )
    }
    assert.strictEqual(
      await fails('debug_storageRangeAt', [Number(head.number), 999, target, key, 5]),
      `${latestOnly}, txIndex must be 0`,
    )
    // the index is judged before the block
    assert.strictEqual(
      await fails('debug_storageRangeAt', [Number(head.number) - 1, 1, target, key, 5]),
      `${latestOnly}, txIndex must be 0`,
    )
    // an address without an account has an empty range, not an error
    const ghost = utils.accounts.generateAccount().address.base58
    assert.deepEqual(await call('debug_storageRangeAt', ['latest', 0, ghost, key, 5]), {
      storage: {},
      nextKey: null,
    })
  })
})

describe('cheat writes are transactional', () => {
  it('a fault inside tre_setAccountCode leaves no half-written state', async () => {
    const target = utils.accounts.generateAccount().address.base58
    const address = parseTronAddress(TronWeb.address.toHex(target))
    const before = await nodeCore(node).stateManager.getStateRoot()
    const original = nodeCore(node).registerContract.bind(nodeCore(node))
    nodeCore(node).registerContract = () => {
      throw new Error('injected registry fault')
    }
    try {
      assert.include(await fails('tre_setAccountCode', [target, '0x60006000f3']), 'injected')
    } finally {
      nodeCore(node).registerContract = original
    }
    assert.lengthOf(await nodeCore(node).getCode(address), 0)
    assert.deepEqual(await nodeCore(node).stateManager.getStateRoot(), before)
  })

  it('a fault mid-batch rolls back the whole generated-accounts batch', async () => {
    const before = await nodeCore(node).stateManager.getStateRoot()
    const batches = nodeCore(node).generatedAccounts.length
    const original = nodeCore(node).setBalance.bind(nodeCore(node))
    let calls = 0
    nodeCore(node).setBalance = async (address, balance) => {
      calls += 1
      if (calls === 3) throw new Error('injected funding fault')
      return original(address, balance)
    }
    try {
      assert.include(
        await fails('admin/temporary-accounts-generation', { accounts: 5 } as never),
        'injected',
      )
    } finally {
      nodeCore(node).setBalance = original
    }
    assert.lengthOf(nodeCore(node).generatedAccounts, batches)
    assert.deepEqual(await nodeCore(node).stateManager.getStateRoot(), before)
  })
})

describe('debug_storageRangeAt argument rules', () => {
  const target = utils.accounts.generateAccount().address.base58

  it('judges the index, then the block, then the count', async () => {
    const address = target
    await call('tre_setAccountStorageAt', [address, '0x01', '0x2a'])

    // an index past the first is an index into a block that is not the head
    assert.strictEqual(
      await fails('debug_storageRangeAt', ['latest', 1, address, '', 5]),
      'only the latest/current state is supported, txIndex must be 0',
    )
    // and it is judged before the block, so a stale block behind a bad index
    // reports the index
    assert.strictEqual(
      await fails('debug_storageRangeAt', [999, 1, address, '', 5]),
      'only the latest/current state is supported, txIndex must be 0',
    )
    // an index before the first names no earlier state, so it passes
    assert.isObject(await call('debug_storageRangeAt', ['latest', -1, address, '', 5]))

    assert.strictEqual(
      await fails('debug_storageRangeAt', [999, 0, address, '', 5]),
      'only the latest/current state is supported',
    )
    for (const limit of [0, -1, null]) {
      assert.strictEqual(
        await fails('debug_storageRangeAt', ['latest', 0, address, '', limit]),
        'limit must be greater than 0',
        String(limit),
      )
    }
    assert.strictEqual(
      await fails('debug_storageRangeAt', ['latest', 0, address, '', 'many']),
      'integer decode error',
    )
  })

  it('reads the start key as a string parameter, so a composite is a decode failure', async () => {
    const address = target

    // absent, empty and a bare `0x` all name the very beginning
    for (const start of [null, undefined, '', '0x']) {
      assert.isObject(
        await call('debug_storageRangeAt', ['latest', 0, address, start, 5]),
        String(start),
      )
    }
    // a scalar reads as the text it spells, hex or not
    assert.isObject(await call('debug_storageRangeAt', ['latest', 0, address, 5, 5]))
    assert.strictEqual(
      await fails('debug_storageRangeAt', ['latest', 0, address, true, 5]),
      'hex decode error',
    )
    for (const start of [[], {}]) {
      assert.strictEqual(
        await fails('debug_storageRangeAt', ['latest', 0, address, start, 5]),
        'hex decode error',
        JSON.stringify(start),
      )
    }
  })
})

describe('debug_traceTransaction argument rules', () => {
  it('holds the transaction id to 32 bytes of hex', async () => {
    assert.strictEqual(
      await fails('debug_traceTransaction', ['ab'.repeat(32)]),
      'hex must begin with 0x',
    )
    assert.strictEqual(await fails('debug_traceTransaction', ['0xzz']), 'hex decode error')
    for (const id of ['0x1234', `0x${'ab'.repeat(31)}`, `0x${'ab'.repeat(33)}`]) {
      assert.strictEqual(await fails('debug_traceTransaction', [id]), 'hash must be 32 bytes', id)
    }
  })
})

describe('the argument count each dev method declares', () => {
  it('names no method when the count does not match', async () => {
    const address = utils.accounts.generateAccount().address.base58
    const word = `0x${'00'.repeat(31)}01`
    const wrong: [string, unknown[]][] = [
      ['tre_setAccountBalance', []],
      ['tre_setAccountBalance', [address, 1, 1]],
      ['tre_setAccountCode', [address]],
      ['tre_setAccountStorageAt', [address, word]],
      ['tre_blockTime', []],
      ['tre_blockTime', [1, 1]],
      ['tre_mine', [{ blocks: 1 }, 1]],
      ['tre_unlockedAccounts', []],
      ['debug_traceTransaction', []],
      ['debug_storageRangeAt', ['latest', 0, address, '']],
      ['debug_storageRangeAt', ['latest', 0, address, '', 1, 1]],
    ]
    for (const [method, params] of wrong) {
      assert.strictEqual(
        await fails(method, params),
        'method parameters invalid',
        `${method} ${JSON.stringify(params)}`,
      )
    }
    // the counts that do match still run
    assert.isTrue(await call('tre_blockTime', [0]))
    assert.strictEqual(await call('tre_mine', []), '0x0')
    assert.strictEqual(await call('tre_mine', [{ blocks: 1 }]), '0x0')
  })
})

describe('the storage range takes its counts from the JSON value', () => {
  it('truncates a number, trims a string, and reads an empty one as zero', async () => {
    const address = utils.accounts.generateAccount().address.base58
    await call('tre_setAccountStorageAt', [address, '0x01', '0x2a'])

    // a count past the first transaction names a state part-way through a block
    for (const txIndex of [' 1', 2.5, '1']) {
      assert.strictEqual(
        await fails('debug_storageRangeAt', ['latest', txIndex, address, '', 5]),
        'only the latest/current state is supported, txIndex must be 0',
        String(txIndex),
      )
    }
    // an empty count reads as zero, which the limit rule then refuses
    assert.strictEqual(
      await fails('debug_storageRangeAt', ['latest', 0, address, '', '']),
      'limit must be greater than 0',
    )
    // and the head is named whatever the case
    for (const ref of ['latest', 'LATEST', 'Latest']) {
      assert.isObject(await call('debug_storageRangeAt', [ref, 0, address, '', 5]), String(ref))
    }
  })
})
