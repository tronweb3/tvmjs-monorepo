import { TronWeb, utils } from 'tronweb'
import { assert, it } from 'vitest'

import { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'

const BLACKHOLE = '4177944d19c052b73ee2286823aa83f8138cb7032f'
const ZION = '417e5f4552091a69125d5dfcb7b8c2659029395bdf'
const ZERO_ADDRESS = '410000000000000000000000000000000000000000'

it('initializes Zion with its genesis name', async () => {
  const provider = new TronProvider(await TronNode.create())
  for (const method of ['wallet/getaccount', 'walletsolidity/getaccount'] as const) {
    for (const visible of [false, true]) {
      const account = await provider.request({ method, params: { address: ZION, visible } })
      assert.strictEqual(account.address, visible ? TronWeb.address.fromHex(ZION) : ZION)
      assert.strictEqual(account.account_name, visible ? 'Zion' : '5a696f6e')
      assert.strictEqual(account.balance, 99_000_000_000_000_000n)
      assert.notProperty(account, 'type')
      assert.notProperty(account, 'create_time')
    }
  }
})

it('initializes Blackhole with its name and zero-address owner, without active permissions', async () => {
  const provider = new TronProvider(await TronNode.create())
  for (const method of ['wallet/getaccount', 'walletsolidity/getaccount'] as const) {
    for (const visible of [false, true]) {
      const account = await provider.request({ method, params: { address: BLACKHOLE, visible } })
      assert.strictEqual(account.address, visible ? TronWeb.address.fromHex(BLACKHOLE) : BLACKHOLE)
      assert.strictEqual(account.balance, 0n)
      assert.strictEqual(account.account_name, visible ? 'Blackhole' : '426c61636b686f6c65')
      assert.notProperty(account, 'type')
      assert.notProperty(account, 'create_time')
      assert.notProperty(account, 'active_permission')
      assert.deepEqual(account.owner_permission, {
        permission_name: 'owner',
        threshold: 1n,
        keys: [
          { address: visible ? TronWeb.address.fromHex(ZERO_ADDRESS) : ZERO_ADDRESS, weight: 1n },
        ],
      })
    }
  }
})

it('transfers to Blackhole without new-account fees and preserves its permissions', async () => {
  const node = await TronNode.create()
  const provider = new TronProvider(node)
  const [privateKey] = (await node.admin.accounts()).privateKeys
  const owner = TronWeb.address.fromPrivateKey(privateKey) as string
  const get = (address: string) =>
    provider.request({ method: 'wallet/getaccount', params: { address } })
  const before = await get(BLACKHOLE)
  const senderBefore = (await get(owner)).balance!
  const burnedBefore = await provider.request({ method: 'wallet/getburntrx', params: {} })
  for (const amount of [1, 2]) {
    const transaction = await provider.request({
      method: 'wallet/createtransaction',
      params: { owner_address: owner, to_address: BLACKHOLE, amount },
    })
    if ('Error' in transaction) throw new Error(transaction.Error)
    const sent = await provider.request({
      method: 'wallet/broadcasttransaction',
      params: utils.crypto.signTransaction(privateKey, transaction),
    })
    assert.isTrue(sent.result)
    const receipt = await provider.request({
      method: 'wallet/gettransactioninfobyid',
      params: { value: transaction.txID },
    })
    assert.strictEqual(receipt.fee ?? 0n, 0n)
  }
  const after = await get(BLACKHOLE)
  assert.strictEqual(after.balance, 3n)
  assert.strictEqual(senderBefore - (await get(owner)).balance!, 3n)
  assert.deepEqual(after.owner_permission, before.owner_permission)
  assert.notProperty(after, 'active_permission')
  assert.notProperty(after, 'create_time')
  assert.deepEqual(
    await provider.request({ method: 'wallet/getburntrx', params: {} }),
    burnedBefore,
  )

  const withdrawal = await provider.request({
    method: 'wallet/createtransaction',
    params: { owner_address: BLACKHOLE, to_address: owner, amount: 1 },
  })
  assert.notProperty(withdrawal, 'Error')
  const rejected = await provider.request({
    method: 'wallet/broadcasttransaction',
    params: utils.crypto.signTransaction(privateKey, withdrawal),
  })
  if ('Error' in rejected) throw new Error(rejected.Error)
  assert.isFalse(rejected.result)
  assert.strictEqual(rejected.code, 'SIGERROR')
  assert.deepEqual(await get(BLACKHOLE), after)
})

it('records optimized transaction fees in getburntrx without crediting Blackhole', async () => {
  const node = await TronNode.create()
  const provider = new TronProvider(node)
  const [privateKey] = (await node.admin.accounts()).privateKeys
  const owner = TronWeb.address.fromPrivateKey(privateKey) as string
  const recipient = utils.accounts.generateAccount().address.base58
  const get = (address: string) =>
    provider.request({ method: 'wallet/getaccount', params: { address } })
  const burned = async () =>
    (await provider.request({ method: 'wallet/getburntrx', params: {} })).burnTrxAmount ?? 0n
  const parameters = await provider.request({ method: 'wallet/getchainparameters', params: {} })
  assert.strictEqual(
    parameters.chainParameter?.find(({ key }) => key === 'getAllowOptimizeBlackHole')?.value,
    1,
  )
  const blackholeBefore = await get(BLACKHOLE)
  const senderBefore = (await get(owner)).balance!
  const burnedBefore = await burned()
  const transaction = await provider.request({
    method: 'wallet/createtransaction',
    params: { owner_address: owner, to_address: recipient, amount: 1 },
  })
  if ('Error' in transaction) throw new Error(transaction.Error)
  const sent = await provider.request({
    method: 'wallet/broadcasttransaction',
    params: utils.crypto.signTransaction(privateKey, transaction),
  })
  assert.isTrue(sent.result)
  const receipt = await provider.request({
    method: 'wallet/gettransactioninfobyid',
    params: { value: transaction.txID },
  })
  const fee = receipt.fee ?? 0n
  assert.isTrue(fee > 0n)
  assert.strictEqual(senderBefore - (await get(owner)).balance!, 1n + fee)
  assert.strictEqual((await get(recipient)).balance, 1n)
  assert.strictEqual((await burned()) - burnedBefore, fee)
  assert.deepEqual(await get(BLACKHOLE), blackholeBefore)
})
