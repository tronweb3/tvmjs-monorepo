import { bytesToHex, concatBytes, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, describe, expect, it } from 'vitest'

import { nodeCore } from '../../src/core/nodeAccess.ts'
import { transactionToPb } from '../../src/dialect/tron/wallet/encode.ts'
import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'

import type { SignedTronTx } from '../../src/dialect/tron/wallet/types.ts'

type RawPb = {
  serializeBinary(): Uint8Array
  setRefBlockNum(value: number): void
  setTimestamp(value: number | string): void
  setScripts(value: Uint8Array): void
  setAuthsList(value: unknown[]): void
  getContractList(): {
    getParameter(): {
      getValue_asU8(): Uint8Array
      setValue(value: Uint8Array): void
    }
    setProvider(value: Uint8Array): void
    setContractname(value: Uint8Array): void
    setPermissionId(value: number): void
  }[]
  addContract(value: unknown): void
}

type TransactionPb = {
  getRawData(): RawPb
  addSignature(value: Uint8Array): void
  serializeBinary(): Uint8Array
}

function proto(): {
  AccountId: new () => { setName(value: Uint8Array): void; setAddress(value: Uint8Array): void }
  authority: new () => {
    setPermissionName(value: Uint8Array): void
    setAccount(value: unknown): void
  }
} {
  return (globalThis as unknown as { TronWebProto: ReturnType<typeof proto> }).TronWebProto
}

function signedPacket(
  privateKey: string,
  tx: SignedTronTx,
  amend: (raw: RawPb) => void,
): {
  id: string
  rawHex: string
  wireHex: string
} {
  const packet = utils.transaction.txJsonToPb(tx as never) as unknown as TransactionPb
  const raw = packet.getRawData()
  amend(raw)
  const rawBytes = raw.serializeBinary()
  const id = utils.ethersUtils.sha256(rawBytes).slice(2)
  const signature = utils.crypto.signTransaction(privateKey, { txID: id }).signature?.[0]
  if (signature === undefined) throw new Error('test signer did not return a signature')
  packet.addSignature(hexToBytes(`0x${signature}`))
  return {
    id,
    rawHex: bytesToHex(rawBytes).slice(2),
    wireHex: bytesToHex(packet.serializeBinary()).slice(2),
  }
}

describe('canonical transaction wire data', () => {
  for (const http of [false, true]) {
    it.each([false, true])(
      `normalizes envelope fields through ${http ? 'HTTP' : 'provider'} inspection and broadcast (visible: %s)`,
      async (visible) => {
        const node = await TronNode.create()
        const provider = new TronProvider(node)
        const started = http ? await startHttpServer(provider, { port: 0 }) : undefined
        try {
          const [owner, receiver] = (await node.admin.accounts()).privateKeys.map((key) =>
            TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string),
          )
          await node.tre.unlockedAccounts([owner])
          const request = async (
            method: string,
            params: object,
          ): Promise<Record<string, unknown>> =>
            (started === undefined
              ? await provider.request({ method, params })
              : await (
                  await fetch(`${started.url}/${method}`, {
                    method: 'POST',
                    body: JSON.stringify(params),
                  })
                ).json()) as Record<string, unknown>
          const built = await provider.request({
            method: 'wallet/createtransaction',
            params: { owner_address: owner, to_address: receiver, amount: 1, visible },
          })
          if ('Error' in built) throw new Error(built.Error)
          const permissionName = bytesToHex(new TextEncoder().encode('permission')).slice(2)
          const accountName = bytesToHex(new TextEncoder().encode('account')).slice(2)
          const input = {
            ...built,
            raw_data: {
              ...built.raw_data,
              timestamp: String(built.raw_data.timestamp),
              expiration: String(built.raw_data.expiration),
              ref_block_num: '22',
              fee_limit: '123',
              scripts: '0X0A',
              ignored: 'omitted',
              auths: [
                { permission_name: visible ? 'permission' : permissionName },
                {},
                {
                  account: {
                    name: visible ? 'account' : accountName,
                    address: visible ? TronWeb.address.fromHex(owner) : owner,
                  },
                },
                { account: { name: visible ? 'account' : accountName, address: '' } },
              ],
            },
          }
          const before = structuredClone(input)
          for (const method of ['wallet/getsignweight', 'wallet/getapprovedlist']) {
            const reply = await request(method, input)
            const echo = reply.transaction as { transaction: SignedTronTx }
            assert.strictEqual(echo.transaction.raw_data.ref_block_num, 22)
            assert.strictEqual(echo.transaction.raw_data.timestamp, built.raw_data.timestamp)
            assert.strictEqual(echo.transaction.raw_data.fee_limit, 123)
            assert.strictEqual(echo.transaction.raw_data.scripts, '0a')
            assert.deepEqual(echo.transaction.raw_data.auths, [
              ...input.raw_data.auths.slice(0, 3),
              { account: { name: visible ? 'account' : accountName } },
            ])
            assert.notProperty(echo.transaction.raw_data, 'ignored')
          }
          const sent = await request('wallet/broadcasttransaction', input)
          assert.isTrue(sent.result)
          const stored = await request('wallet/gettransactionbyid', { value: sent.txid })
          const raw = stored.raw_data as SignedTronTx['raw_data']
          assert.strictEqual(raw.ref_block_num, 22)
          assert.strictEqual(raw.timestamp, built.raw_data.timestamp)
          assert.lengthOf(raw.auths!, 4)
          assert.deepEqual(raw.auths![0], { permission_name: permissionName })
          assert.deepEqual(raw.auths![1], {})
          assert.deepEqual(raw.auths![2], { account: { name: accountName, address: owner } })
          assert.deepEqual(raw.auths![3], {
            account: { name: accountName, ...(http ? {} : { address: '' }) },
          })
          const registry = globalThis as unknown as {
            TronWebProto: {
              Transaction: {
                raw: {
                  deserializeBinary(bytes: Uint8Array): {
                    getRefBlockNum(): number
                    getAuthsList(): { getPermissionName_asU8(): Uint8Array }[]
                  }
                }
              }
            }
          }
          const decoded = registry.TronWebProto.Transaction.raw.deserializeBinary(
            hexToBytes(`0x${stored.raw_data_hex}`),
          )
          assert.strictEqual(decoded.getRefBlockNum(), 22)
          assert.lengthOf(decoded.getAuthsList(), 4)
          assert.strictEqual(
            bytesToHex(decoded.getAuthsList()[0].getPermissionName_asU8()).slice(2),
            permissionName,
          )
          assert.deepEqual(input, before)
          for (const field of ['ref_block_num', 'expiration', 'timestamp', 'fee_limit']) {
            const rejected = await request('wallet/broadcasttransaction', {
              ...built,
              raw_data: { ...built.raw_data, [field]: '9007199254740993' },
            })
            assert.isFalse(rejected.result ?? false)
            assert.strictEqual(rejected.code, 'CONTRACT_VALIDATE_ERROR')
          }
        } finally {
          if (started !== undefined) {
            started.server.closeAllConnections()
            await new Promise<void>((resolve, reject) =>
              started.server.close((error) => (error ? reject(error) : resolve())),
            )
          }
        }
      },
    )
  }

  it('rejects a wide envelope from broadcasthex before accepting its rounded representation', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const [key, peer] = (await node.admin.accounts()).privateKeys
    const tx = await provider.request({
      method: 'wallet/createtransaction',
      params: {
        owner_address: TronWeb.address.fromPrivateKey(key) as string,
        to_address: TronWeb.address.fromPrivateKey(peer) as string,
        amount: 1,
      },
    })
    if ('Error' in tx) throw new Error(tx.Error)
    const packet = signedPacket(key, tx as unknown as SignedTronTx, (raw) =>
      raw.setTimestamp('9007199254740993'),
    )
    const result = (await provider.request({
      method: 'wallet/broadcasthex',
      params: { transaction: packet.wireHex },
    })) as { result: boolean; code: string }
    assert.strictEqual(result.result, false)
    assert.strictEqual(result.code, 'CONTRACT_VALIDATE_ERROR')
  })

  for (const method of ['wallet/getsignweight', 'wallet/getapprovedlist'] as const) {
    for (const visible of [false, true]) {
      for (const frozen of [false, true]) {
        it(`${method} preserves a ${visible ? 'Base58' : 'hex'} transaction (${frozen ? 'frozen' : 'mutable'}) for subsequent broadcast`, async () => {
          const node = await TronNode.create()
          const provider = new TronProvider(node)
          const { privateKeys } = await node.admin.accounts()
          const [owner, receiver] = privateKeys.map(
            (key) => TronWeb.address.fromPrivateKey(key) as string,
          )
          const web = new TronWeb({ fullHost: 'http://127.0.0.1:1', privateKey: privateKeys[0] })
          const unsigned = await provider.request({
            method: 'wallet/createtransaction',
            params: { owner_address: owner, to_address: receiver, amount: 17, visible },
          })
          if ('Error' in unsigned) throw new Error(unsigned.Error)
          const signed = await web.trx.sign(unsigned)
          const before = structuredClone(signed)
          const freeze = (value: unknown): void => {
            if (value === null || typeof value !== 'object') return
            for (const child of Object.values(value)) freeze(child)
            Object.freeze(value)
          }
          if (frozen) freeze(signed)
          const inspection = (await provider.request({ method, params: signed })) as {
            result: unknown
          }
          assert.deepEqual(inspection.result, {})
          assert.deepEqual(signed, before)
          const balance =
            (
              await provider.request({
                method: 'wallet/getaccount',
                params: { address: receiver },
              })
            ).balance ?? 0n
          assert.isTrue(
            (
              await provider.request({
                method: 'wallet/broadcasttransaction',
                params: signed,
              })
            ).result,
          )
          assert.deepEqual(signed, before)
          assert.strictEqual(
            (
              await provider.request({
                method: 'wallet/getaccount',
                params: { address: receiver },
              })
            ).balance,
            balance + 17n,
          )
        })
      }
    }
  }

  it('captures a signature inspection request before the caller makes further edits', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const [owner, receiver] = privateKeys.map(
      (key) => TronWeb.address.fromPrivateKey(key) as string,
    )
    const unsigned = await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: receiver, amount: 17, visible: true },
    })
    if ('Error' in unsigned) throw new Error(unsigned.Error)
    const signed = utils.crypto.signTransaction(privateKeys[0], unsigned)
    const value = signed.raw_data.contract[0].parameter.value
    if (!('amount' in value)) throw new Error('expected a transfer')
    const pending = provider.request({ method: 'wallet/getsignweight', params: signed })
    value.amount = 99
    const inspected = (await pending) as {
      result: unknown
      transaction: { transaction: SignedTronTx }
    }
    assert.deepEqual(inspected.result, {})
    assert.strictEqual(
      inspected.transaction.transaction.raw_data.contract[0].parameter.value.amount,
      17,
    )
    assert.strictEqual(value.amount, 99)
  })

  for (const method of ['wallet/getsignweight', 'wallet/getapprovedlist']) {
    for (const visible of [false, true]) {
      it(`${method} HTTP inspection preserves a visible=${visible} transaction for broadcast`, async () => {
        const node = await TronNode.create()
        const started = await startHttpServer(new TronProvider(node), { port: 0 })
        try {
          const { privateKeys } = await node.admin.accounts()
          const [owner, receiver] = privateKeys.map(
            (key) => TronWeb.address.fromPrivateKey(key) as string,
          )
          const web = new TronWeb({ fullHost: started.url, privateKey: privateKeys[0] })
          const post = async (path: string, params: unknown) =>
            (
              await fetch(`${started.url}/${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(params),
              })
            ).json()
          const tx = await post('wallet/createtransaction', {
            owner_address: visible ? owner : TronWeb.address.toHex(owner),
            to_address: visible ? receiver : TronWeb.address.toHex(receiver),
            amount: 17,
            visible,
          })
          const signed = await web.trx.sign(tx)
          assert.deepEqual((await post(method, signed)).result, {})
          const before = await web.trx.getBalance(receiver)
          assert.isTrue((await post('wallet/broadcasttransaction', signed)).result)
          assert.strictEqual(await web.trx.getBalance(receiver), before + 17)
        } finally {
          await new Promise<void>((resolve, reject) =>
            started.server.close((error) => (error ? reject(error) : resolve())),
          )
        }
      })
    }
  }

  it('rejects a post-signature change to a signed contract field', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const unsigned = (await provider.request({
      method: 'wallet/freezebalancev2',
      params: { owner_address: owner, frozen_balance: 1_000_000, resource: 'ENERGY' },
    })) as unknown as SignedTronTx
    const signed = utils.crypto.signTransaction(privateKeys[0], unsigned)
    ;(signed.raw_data.contract[0].parameter.value as unknown as Record<string, unknown>).resource =
      'BANDWIDTH'

    const result = (await provider.request({
      method: 'wallet/broadcasttransaction',
      params: signed,
    })) as { code?: string }
    assert.strictEqual(result.code, 'SIGERROR')
  })

  it('accepts hex packets with signed envelope metadata and stores their exact raw bytes', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const receiver = TronWeb.address.fromPrivateKey(privateKeys[1]) as string
    const unsigned = (await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: receiver, amount: 1 },
    })) as unknown as SignedTronTx
    const packet = signedPacket(privateKeys[0], unsigned, (raw) => {
      raw.setRefBlockNum(22)
      raw.setScripts(hexToBytes('0x01'))
      const account = new (proto().AccountId)()
      account.setName(hexToBytes('0x6e616d65'))
      account.setAddress(hexToBytes(`0x${TronWeb.address.toHex(owner)}`))
      const authority = new (proto().authority)()
      authority.setPermissionName(hexToBytes('0x7065726d'))
      authority.setAccount(account)
      const named = new (proto().authority)()
      named.setPermissionName(hexToBytes('0x7065726d'))
      const emptyAccount = new (proto().authority)()
      emptyAccount.setAccount(new (proto().AccountId)())
      raw.setAuthsList([authority, new (proto().authority)(), named, emptyAccount])
      const contract = raw.getContractList()[0]
      contract.setProvider(hexToBytes('0x70726f7669646572'))
      contract.setContractname(hexToBytes('0x6e616d65'))
    })

    const sent = (await provider.request({
      method: 'wallet/broadcasthex',
      params: { transaction: packet.wireHex },
    })) as { result?: boolean; txid?: string; transaction: string }
    assert.isTrue(sent.result, JSON.stringify(sent))
    assert.strictEqual(sent.txid, packet.id)
    const echo = JSON.parse(sent.transaction) as { raw_data: SignedTronTx['raw_data'] }
    assert.deepEqual(echo.raw_data.auths?.slice(1), [
      {},
      { permission_name: '7065726d' },
      { account: {} },
    ])
    const stored = (await provider.request({
      method: 'wallet/gettransactionbyid',
      params: { value: packet.id },
    })) as { raw_data_hex?: string }
    assert.strictEqual(stored.raw_data_hex, packet.rawHex)
  })

  it('keeps all contracts from a hex packet through structural validation', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const receiver = TronWeb.address.fromPrivateKey(privateKeys[1]) as string
    const unsigned = (await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: receiver, amount: 1 },
    })) as unknown as SignedTronTx
    const packet = signedPacket(privateKeys[0], unsigned, (raw) => {
      raw.addContract(raw.getContractList()[0])
    })

    const sent = (await provider.request({
      method: 'wallet/broadcasthex',
      params: { transaction: packet.wireHex },
    })) as { code?: string; txid?: string }
    assert.strictEqual(sent.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(sent.txid, packet.id)
    const stored = (await provider.request({
      method: 'wallet/gettransactionbyid',
      params: { value: packet.id },
    })) as Record<string, unknown>
    assert.deepEqual(stored, {})
  })

  it('validates permission IDs as integers in builders and broadcasts', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const receiver = TronWeb.address.fromPrivateKey(privateKeys[1]) as string

    const invalid = [
      'abc',
      '1,000',
      '2.0',
      -2_147_483_649,
      1.5,
      2_147_483_648,
      true,
      false,
      null,
      [],
      {},
    ]
    for (const Permission_id of invalid) {
      const reply = (await provider.request({
        method: 'wallet/createtransaction',
        // @ts-expect-error Deliberately malformed permission IDs exercise runtime validation.
        params: { owner_address: owner, to_address: receiver, amount: 1, Permission_id },
      })) as { Error?: string; txID?: string }
      assert.isString(reply.Error)
      assert.isUndefined(reply.txID)
    }

    const valid = [
      [-2_147_483_648, undefined],
      [-1, undefined],
      ['2', 2],
      [2, 2],
      [0, undefined],
      [2_147_483_647, 2_147_483_647],
    ] as const
    for (const [Permission_id, expected] of valid) {
      const built = (await provider.request({
        method: 'wallet/createtransaction',
        params: { owner_address: owner, to_address: receiver, amount: 1, Permission_id },
      })) as unknown as SignedTronTx
      assert.strictEqual(built.raw_data.contract[0].Permission_id, expected)
    }

    const built = (await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: receiver, amount: 1 },
    })) as unknown as SignedTronTx
    for (const Permission_id of [-2_147_483_648, -1, 0, 2, 2_147_483_647]) {
      const transaction = structuredClone(built)
      transaction.raw_data.contract[0].Permission_id = Permission_id
      const inspected = (await provider.request({
        method: 'wallet/getsignweight',
        params: transaction,
      })) as { Error?: string; transaction: { transaction: SignedTronTx } }
      assert.isUndefined(inspected.Error)
      assert.lengthOf(inspected.transaction.transaction.raw_data.contract, 1)
    }
    for (const Permission_id of invalid) {
      const malformed = structuredClone(built)
      malformed.raw_data.contract[0].Permission_id = Permission_id as never
      for (const method of [
        'wallet/broadcasttransaction',
        'wallet/getsignweight',
        'wallet/getapprovedlist',
      ]) {
        await expect(provider.request({ method, params: malformed })).rejects.toThrow(
          /Permission_id/,
        )
      }
    }

    const signed = utils.crypto.signTransaction(privateKeys[0], built)
    signed.raw_data.contract[0].Permission_id = '0' as never
    const accepted = (await provider.request({
      method: 'wallet/broadcasttransaction',
      params: signed,
    })) as { result?: boolean }
    assert.isTrue(accepted.result)

    const started = await startHttpServer(provider, { port: 0 })
    try {
      for (const [Permission_id, expected] of [
        ...valid,
        ...invalid.map((value) => [value, 'error'] as const),
      ]) {
        const response = await fetch(`${started.url}/wallet/createtransaction`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner_address: TronWeb.address.toHex(owner),
            to_address: TronWeb.address.toHex(receiver),
            amount: 1,
            Permission_id,
          }),
        })
        const reply = (await response.json()) as SignedTronTx & { Error?: string }
        if (expected === 'error') {
          assert.include(reply.Error ?? '', 'Permission_id')
          assert.isUndefined(reply.txID)
        } else {
          assert.isUndefined(reply.Error)
          assert.strictEqual(reply.raw_data.contract[0].Permission_id, expected)
        }
      }
      for (const Permission_id of [-2_147_483_648, -1, 0, 2, 2_147_483_647]) {
        const transaction = structuredClone(built)
        transaction.raw_data.contract[0].Permission_id = Permission_id
        const response = await fetch(`${started.url}/wallet/getsignweight`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(transaction),
        })
        const inspected = (await response.json()) as {
          Error?: string
          transaction: { transaction: SignedTronTx }
        }
        assert.isUndefined(inspected.Error)
        assert.lengthOf(inspected.transaction.transaction.raw_data.contract, 1)
      }
      for (const Permission_id of invalid) {
        const malformed = structuredClone(built)
        malformed.raw_data.contract[0].Permission_id = Permission_id as never
        for (const contracts of [
          malformed.raw_data.contract,
          [built.raw_data.contract[0], ...malformed.raw_data.contract],
        ]) {
          for (const method of ['broadcasttransaction', 'getsignweight', 'getapprovedlist']) {
            const response = await fetch(`${started.url}/wallet/${method}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                ...malformed,
                raw_data: { ...malformed.raw_data, contract: contracts },
              }),
            })
            const reply = (await response.json()) as Record<string, unknown>
            assert.strictEqual(response.status, 200)
            assert.deepEqual(Object.keys(reply), ['Error'])
            assert.include(String(reply.Error), 'Permission_id')
          }
        }
      }
    } finally {
      started.server.close()
    }
  })

  it('skips unknown contract value fields without changing the signed transaction', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const [owner, receiver] = privateKeys
      .slice(0, 2)
      .map((key) => TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string))
    const built = (await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: receiver, amount: 1 },
    })) as unknown as SignedTronTx
    const signed = utils.crypto.signTransaction(
      privateKeys[0],
      structuredClone(built),
    ) as unknown as SignedTronTx
    Object.assign(signed.raw_data.contract[0].parameter.value, {
      unknown_number: 1,
      unknown_object: { amount: 'abc' },
      unknown_array: [null, 'abc'],
    })
    const started = await startHttpServer(provider, { port: 0 })
    try {
      for (const method of ['wallet/getsignweight', 'wallet/getapprovedlist']) {
        const response = await fetch(`${started.url}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(signed),
        })
        for (const reply of [
          await response.json(),
          await provider.request({ method, params: structuredClone(signed) }),
        ]) {
          assert.deepEqual(reply.result, {})
          const echo = reply.transaction.transaction as SignedTronTx
          assert.lengthOf(echo.raw_data.contract, 1)
          assert.deepEqual(
            echo.raw_data.contract[0].parameter.value,
            built.raw_data.contract[0].parameter.value,
          )
          assert.strictEqual(echo.txID, built.txID)
          assert.strictEqual(echo.raw_data_hex, built.raw_data_hex)
        }
      }
      const malformed = structuredClone(signed)
      malformed.raw_data.contract[0].parameter.value.amount = 'abc'
      const dropped = (await provider.request({
        method: 'wallet/getsignweight',
        params: malformed,
      })) as {
        transaction: { transaction: SignedTronTx }
      }
      assert.lengthOf(dropped.transaction.transaction.raw_data.contract, 0)
      const response = await fetch(`${started.url}/wallet/broadcasttransaction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
      })
      const sent = (await response.json()) as { result?: boolean; txid?: string }
      assert.isTrue(sent.result)
      assert.strictEqual(sent.txid, built.txID)
    } finally {
      started.server.close()
    }
  })

  it('omits nonpositive permission IDs only from the echo, not the wire or authorization', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const [owner, receiver] = privateKeys
      .slice(0, 2)
      .map((key) => TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key) as string))
    const built = (await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: receiver, amount: 1 },
    })) as unknown as SignedTronTx
    const started = await startHttpServer(provider, { port: 0 })
    try {
      for (const Permission_id of [-2_147_483_648, -1, 0, 2, 2_147_483_647]) {
        // The oracle is the protobuf field setter, independently of JSON packing/printing.
        const packet = signedPacket(privateKeys[0], built, (raw) => {
          raw.getContractList()[0].setPermissionId(Permission_id)
        })
        const transaction = structuredClone(built)
        transaction.raw_data.contract[0].Permission_id = Permission_id
        const signed = utils.crypto.signTransaction(privateKeys[0], {
          ...transaction,
          txID: packet.id,
        })
        for (const method of ['wallet/getsignweight', 'wallet/getapprovedlist']) {
          const response = await fetch(`${started.url}/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(signed),
          })
          for (const reply of [
            await response.json(),
            await provider.request({ method, params: signed }),
          ]) {
            const echo = reply.transaction.transaction as SignedTronTx
            assert.lengthOf(echo.raw_data.contract, 1)
            assert.strictEqual(
              echo.raw_data.contract[0].Permission_id,
              Permission_id > 0 ? Permission_id : undefined,
            )
            assert.strictEqual(echo.raw_data_hex, packet.rawHex)
            assert.strictEqual(echo.txID, packet.id)
            if (Permission_id < 0) {
              assert.strictEqual(reply.result.message, 'Permission for this, does not exist!')
              assert.notStrictEqual(echo.txID, built.txID)
            } else if (Permission_id === 0) {
              assert.deepEqual(reply.result, {})
              assert.strictEqual(echo.txID, built.txID)
            }
          }
        }
        if (Permission_id < 0) {
          const rejected = (await provider.request({
            method: 'wallet/broadcasttransaction',
            params: signed,
          })) as { code?: string }
          assert.strictEqual(rejected.code, 'SIGERROR')
        }
        assert.strictEqual(signed.raw_data.contract[0].Permission_id, Permission_id)
      }
    } finally {
      started.server.close()
    }
  })

  it('keeps visible text bytes stable from construction through broadcast', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const unsigned = (await provider.request({
      method: 'wallet/updateaccount',
      params: { owner_address: owner, account_name: 'aa', visible: true },
    })) as unknown as SignedTronTx
    const signed = utils.crypto.signTransaction(privateKeys[0], unsigned)
    const sent = (await provider.request({
      method: 'wallet/broadcasttransaction',
      params: signed,
    })) as { result?: boolean; txid: string }
    assert.isTrue(sent.result, JSON.stringify(sent))
    const visible = (await provider.request({
      method: 'wallet/gettransactionbyid',
      params: { value: sent.txid, visible: true },
    })) as unknown as SignedTronTx
    const hex = (await provider.request({
      method: 'wallet/gettransactionbyid',
      params: { value: sent.txid, visible: false },
    })) as unknown as SignedTronTx
    assert.strictEqual(visible.raw_data.contract[0].parameter.value.account_name, 'aa')
    assert.strictEqual(hex.raw_data.contract[0].parameter.value.account_name, '6161')
  })

  it('round-trips visible control and escape characters through JSON', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const started = await startHttpServer(provider, { port: 0 })
    try {
      for (const [index, [account_name, expected]] of [
        ['0a', '\n'],
        ['09', '\t'],
        ['5c', '\\'],
        ['22', '"'],
        ['fffe', '\ufffd\ufffd'],
        ['61620a', 'ab\n'],
        ['6162', 'ab'],
      ].entries()) {
        const owner = TronWeb.address.fromPrivateKey(privateKeys[index]) as string
        const unsigned = (await provider.request({
          method: 'wallet/updateaccount',
          params: { owner_address: owner, account_name },
        })) as unknown as SignedTronTx
        const sent = (await provider.request({
          method: 'wallet/broadcasttransaction',
          params: utils.crypto.signTransaction(privateKeys[index], unsigned),
        })) as { result?: boolean; txid: string }
        assert.isTrue(sent.result, JSON.stringify(sent))
        const visible = (await provider.request({
          method: 'wallet/gettransactionbyid',
          params: { value: sent.txid, visible: true },
        })) as unknown as SignedTronTx
        assert.strictEqual(visible.raw_data.contract[0].parameter.value.account_name, expected)
        const response = await fetch(`${started.url}/wallet/gettransactionbyid`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: sent.txid, visible: true }),
        })
        const http = (await response.json()) as SignedTronTx
        assert.strictEqual(http.raw_data.contract[0].parameter.value.account_name, expected)
      }
    } finally {
      started.server.close()
    }
  })

  it('keeps hexadecimal-looking visible TRC-10 text stable through signature', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const head = (await provider.request({ method: 'wallet/getnowblock' })) as {
      block_header: { raw_data: { timestamp: number } }
    }
    const start = head.block_header.raw_data.timestamp + 60_000
    const unsigned = (await provider.request({
      method: 'wallet/createassetissue',
      params: {
        owner_address: owner,
        name: 'DEAD',
        abbr: 'cafe',
        description: 'beef',
        url: 'https://asset.invalid',
        total_supply: 1_000,
        trx_num: 1,
        num: 1,
        start_time: start,
        end_time: start + 86_400_000,
        visible: true,
      },
    })) as unknown as SignedTronTx
    const value = unsigned.raw_data.contract[0].parameter.value
    assert.strictEqual(value.abbr, 'cafe')
    assert.strictEqual(value.description, 'beef')

    const sent = (await provider.request({
      method: 'wallet/broadcasttransaction',
      params: utils.crypto.signTransaction(privateKeys[0], unsigned),
    })) as { result?: boolean; txid: string }
    assert.isTrue(sent.result, JSON.stringify(sent))

    const info = (await provider.request({
      method: 'wallet/gettransactioninfobyid',
      params: { value: sent.txid },
    })) as { blockNumber: number }
    const block = (await provider.request({
      method: 'wallet/getblockbynum',
      params: { num: info.blockNumber, visible: true },
    })) as { transactions: SignedTronTx[] }
    const stored = block.transactions.find((transaction) => transaction.txID === sent.txid)
    assert.isDefined(stored)
    assert.strictEqual(stored?.raw_data.contract[0].parameter.value.abbr, 'cafe')
    assert.strictEqual(stored?.raw_data.contract[0].parameter.value.description, 'beef')
  })

  it('applies one visible-text rule to every AssetIssue text field', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const head = (await provider.request({ method: 'wallet/getnowblock' })) as {
      block_header: { raw_data: { timestamp: number } }
    }
    const start = head.block_header.raw_data.timestamp + 60_000
    const unsigned = (await provider.request({
      method: 'wallet/createassetissue',
      params: {
        owner_address: owner,
        name: '5443',
        abbr: '5c',
        description: '5c',
        url: '5c',
        total_supply: 1_000,
        trx_num: 1,
        num: 1,
        start_time: start,
        end_time: start + 86_400_000,
      },
    })) as unknown as SignedTronTx
    const sent = (await provider.request({
      method: 'wallet/broadcasttransaction',
      params: utils.crypto.signTransaction(privateKeys[0], unsigned),
    })) as { result?: boolean; txid: string }
    assert.isTrue(sent.result, JSON.stringify(sent))

    const stored = (await provider.request({
      method: 'wallet/gettransactionbyid',
      params: { value: sent.txid, visible: true },
    })) as unknown as SignedTronTx
    assert.deepInclude(stored.raw_data.contract[0].parameter.value, {
      name: 'TC',
      abbr: '\\',
      description: '\\',
      url: '\\',
    })
  })

  it('keeps protobuf-default AssetIssue fields absent after hex broadcast', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const head = (await provider.request({ method: 'wallet/getnowblock' })) as {
      block_header: { raw_data: { timestamp: number } }
    }
    const start = head.block_header.raw_data.timestamp + 60_000
    const unsigned = (await provider.request({
      method: 'wallet/createassetissue',
      params: {
        owner_address: owner,
        name: 'Asset',
        abbr: 'AST',
        total_supply: 1_000,
        trx_num: 1,
        num: 1,
        start_time: start,
        end_time: start + 86_400_000,
        url: 'https://asset.invalid',
        visible: true,
      },
    })) as unknown as SignedTronTx
    const signed = utils.crypto.signTransaction(privateKeys[0], unsigned)
    const packet = utils.transaction.txJsonToPb(signed as never) as unknown as TransactionPb
    for (const signature of signed.signature ?? [])
      packet.addSignature(hexToBytes(`0x${signature}`))
    const sent = (await provider.request({
      method: 'wallet/broadcasthex',
      params: { transaction: bytesToHex(packet.serializeBinary()).slice(2) },
    })) as { result?: boolean; txid: string }
    assert.isTrue(sent.result, JSON.stringify(sent))

    const stored = (await provider.request({
      method: 'wallet/gettransactionbyid',
      params: { value: sent.txid },
    })) as unknown as SignedTronTx
    const value = stored.raw_data.contract[0].parameter.value as Record<string, unknown>
    assert.strictEqual(value.total_supply, 1_000)
    assert.strictEqual(value.url, '68747470733a2f2f61737365742e696e76616c6964')
    for (const field of [
      'precision',
      'order',
      'vote_score',
      'free_asset_net_limit',
      'public_free_asset_net_limit',
      'public_free_asset_net_usage',
      'public_latest_free_net_time',
    ]) {
      assert.isUndefined(value[field])
    }
  })

  it('uses the last singular value in AssetIssue protobuf fields', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const start = nodeCore(node).head().timestampMs + 60_000
    const unsigned = (await provider.request({
      method: 'wallet/createassetissue',
      params: {
        owner_address: owner,
        name: 'DuplicateFields',
        abbr: 'DUP',
        total_supply: 100,
        frozen_supply: [{ frozen_amount: 5, frozen_days: 1 }],
        trx_num: 1,
        num: 1,
        start_time: start,
        end_time: start + 3 * 86_400_000,
        url: 'https://asset.invalid',
        visible: true,
      },
    })) as unknown as SignedTronTx
    const packet = signedPacket(privateKeys[0], unsigned, (raw) => {
      const parameter = raw.getContractList()[0].getParameter()
      parameter.setValue(
        concatBytes(
          parameter.getValue_asU8(),
          // total_supply=200, then a FrozenSupply whose own singular fields repeat.
          hexToBytes('0x20c8012a080805080710011002'),
        ),
      )
    })

    const sent = (await provider.request({
      method: 'wallet/broadcasthex',
      params: { transaction: packet.wireHex },
    })) as { result?: boolean; txid: string }
    assert.isTrue(sent.result, JSON.stringify(sent))
    const stored = (await provider.request({
      method: 'wallet/gettransactionbyid',
      params: { value: sent.txid },
    })) as unknown as SignedTronTx
    const value = stored.raw_data.contract[0].parameter.value as Record<string, unknown>
    assert.strictEqual(value.total_supply, 200)
    assert.deepEqual(value.frozen_supply, [
      { frozen_amount: 5, frozen_days: 1 },
      { frozen_amount: 7, frozen_days: 2 },
    ])
  })

  it('broadcasts a binary UnfreezeAssetContract through the local decoder', async () => {
    const node = await TronNode.create()
    const provider = new TronProvider(node)
    const { privateKeys } = await node.admin.accounts()
    const owner = TronWeb.address.fromPrivateKey(privateKeys[0]) as string
    const start = nodeCore(node).head().timestampMs + 60_000
    const issue = (await provider.request({
      method: 'wallet/createassetissue',
      params: {
        owner_address: owner,
        name: 'BinaryUnfreeze',
        abbr: 'BUF',
        total_supply: 100,
        frozen_supply: [{ frozen_amount: 5, frozen_days: 1 }],
        trx_num: 1,
        num: 1,
        start_time: start,
        end_time: start + 2 * 86_400_000,
        url: 'https://asset.invalid',
        visible: true,
      },
    })) as unknown as SignedTronTx
    const issued = (await provider.request({
      method: 'wallet/broadcasttransaction',
      params: utils.crypto.signTransaction(privateKeys[0], issue),
    })) as { result?: boolean }
    assert.isTrue(issued.result, JSON.stringify(issued))
    await node.tre.increaseTime(86_461)

    const unfreeze = (await provider.request({
      method: 'wallet/unfreezeasset',
      params: { owner_address: owner, visible: true },
    })) as unknown as SignedTronTx
    const signed = utils.crypto.signTransaction(privateKeys[0], unfreeze) as unknown as SignedTronTx
    const packet = transactionToPb(signed) as unknown as TransactionPb
    for (const signature of signed.signature ?? []) {
      packet.addSignature(hexToBytes(`0x${signature}`))
    }
    const sent = (await provider.request({
      method: 'wallet/broadcasthex',
      params: { transaction: bytesToHex(packet.serializeBinary()).slice(2) },
    })) as { result?: boolean; txid?: string; transaction?: string }
    assert.isTrue(sent.result, JSON.stringify(sent))
    const stored = (await provider.request({
      method: 'wallet/gettransactionbyid',
      params: { value: sent.txid },
    })) as unknown as SignedTronTx
    assert.strictEqual(stored.raw_data.contract[0].type, 'UnfreezeAssetContract')
    assert.strictEqual(
      stored.raw_data.contract[0].parameter.value.owner_address,
      TronWeb.address.toHex(owner).toLowerCase(),
    )
  })
})
