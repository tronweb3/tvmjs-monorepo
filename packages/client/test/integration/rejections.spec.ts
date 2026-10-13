import { bytesToHex, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { assert, afterAll, beforeAll, describe, it } from 'vitest'
import { nodeCore } from '../../src/core/nodeAccess.ts'
import { createNode } from '../createNode.ts'

import { accountsFromMnemonic, resolveConfig } from '../../src/config.ts'
import { Clock } from '../../src/core/clock.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import type { TronNode } from '../../src/node.ts'
import { TronProvider } from '../../src/provider.ts'
import { startHttpServer } from '../../src/transport/httpServer.ts'
import { probeState } from '../stateProbe.ts'

import type { Server } from 'node:http'

const { txJsonToPb, txPbToTxID, txPbToRawDataHex } = utils.transaction

/**
 * Broadcast failures carry a fixed prefix per response code. The assertions
 * below are about the actuator's own wording, so the prefix is stripped here
 * and pinned once, separately.
 */
const BROADCAST_PREFIXES = [
  'Contract validate error : ',
  'Validate signature error: ',
  'Contract execute error : ',
  'Error: ',
]

function messageText(message: string | undefined): string {
  const text = TronWeb.toUtf8(message ?? '')
  for (const prefix of BROADCAST_PREFIXES) {
    if (text.startsWith(prefix)) return text.slice(prefix.length)
  }
  return text
}

/**
 * The invariant net for the write path: every rejected broadcast must leave
 * the node exactly as it found it — state root, block height, tx index, asset
 * registry and the sender's free-bandwidth ledger all unchanged. The probe is
 * a merkle root, so any stray mutation anywhere in accounts or storage trips
 * these tests without them having to know the mutation exists.
 */
describe('rejected broadcasts leave no trace', () => {
  const config = resolveConfig()
  const ownerKey = accountsFromMnemonic(config.mnemonic)[0].privateKey
  const ownerBase58 = TronWeb.address.fromPrivateKey(ownerKey) as string
  const otherKey = accountsFromMnemonic(config.mnemonic)[1].privateKey
  const otherBase58 = TronWeb.address.fromPrivateKey(otherKey) as string
  // unlocked senders so hand-tampered transactions pass the signature step
  // and reach the check under test
  const thinBase58 = utils.accounts.generateAccount().address.base58
  const thin = parseTronAddress(thinBase58)
  const clock = new Clock()
  let node: TronNode
  let server: Server
  let tronWeb: TronWeb
  let baseUrl = ''

  beforeAll(async () => {
    node = await createNode(config, clock)
    const started = await startHttpServer(new TronProvider(node), { port: 0 })
    server = started.server
    baseUrl = started.url
    tronWeb = new TronWeb({ fullHost: started.url, privateKey: ownerKey })
    await nodeCore(node).setBalance(thin, 10_000_000n) // 10 TRX
    nodeCore(node).unlockedAccounts.add(thinBase58)
  })

  afterAll(() => {
    server.close()
  })

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return (await response.json()) as Record<string, unknown>
  }

  /** re-derive txID/raw_data_hex after tampering so only the target check trips */
  function recompute(tx: Record<string, unknown>): Record<string, unknown> {
    const pb = txJsonToPb(tx as never)
    tx.txID = txPbToTxID(pb).replace(/^0x/, '')
    tx.raw_data_hex = txPbToRawDataHex(pb).replace(/^0x/, '').toLowerCase()
    tx.signature = ['00'.repeat(65)]
    return tx
  }

  it('malformed JSON body', async () => {
    const before = await probeState(node)
    // a broken body is reported as such, not passed on as missing parameters
    const reply = (await post('wallet/broadcasttransaction', 'not json at all')) as {
      Error?: string
    }
    assert.match(reply.Error ?? '', /^Unrecognized token: /)
    assert.deepEqual(await probeState(node), before)
  })

  it('transaction without a contract', async () => {
    const before = await probeState(node)
    // an empty list reaches the broadcast entry, while a missing one is
    // dereferenced a step earlier and never becomes a transaction at all
    const empty = await post('wallet/broadcasttransaction', {
      txID: 'ab'.repeat(32),
      raw_data: { contract: [] },
    })
    assert.strictEqual(empty.code, 'CONTRACT_VALIDATE_ERROR')
    const missing = await post('wallet/broadcasttransaction', {
      txID: 'ab'.repeat(32),
      raw_data: {},
    })
    assert.match(String(missing.Error ?? ''), /because "rawContractArray" is null$/)
    assert.deepEqual(await probeState(node), before)
  })

  it('signature from the wrong key', async () => {
    const unsigned = await tronWeb.transactionBuilder.sendTrx(otherBase58, 1_000_000, ownerBase58)
    // the client-side wrapper refuses a mismatched key, so sign a level lower
    const signed = utils.crypto.signTransaction(otherKey, unsigned as never)
    const before = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', signed)
    assert.strictEqual(reply.code, 'SIGERROR')
    assert.deepEqual(await probeState(node), before)
  })

  it('raw_data tampered after signing no longer matches the signature', async () => {
    // the signature covers raw_data, so editing it after the fact recovers a
    // different signer — the node never consults the client's txID
    const signed = (await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.sendTrx(thinBase58, 1000, ownerBase58),
    )) as unknown as Record<string, unknown>
    ;(signed.raw_data as { expiration: number }).expiration += 1

    const before = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', signed)
    assert.strictEqual(reply.code, 'SIGERROR', JSON.stringify(reply))
    assert.deepEqual(await probeState(node), before)
  })

  it('a stale txID and raw_data_hex are ignored, not rejected', async () => {
    const signed = (await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.sendTrx(thinBase58, 1000, ownerBase58),
    )) as unknown as Record<string, unknown>
    const realId = signed.txID as string
    signed.txID = '00'.repeat(32)
    signed.raw_data_hex = 'deadbeef'

    // neither field is part of the protobuf, so the node recomputes the id
    const reply = await post('wallet/broadcasttransaction', signed)
    assert.isTrue(reply.result, JSON.stringify(reply))
    assert.strictEqual(reply.txid, realId)
  })

  it('ref block pointing at unknown chain history', async () => {
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      1000,
      thinBase58,
    )) as unknown as { raw_data: Record<string, unknown> }
    tx.raw_data.ref_block_hash = 'deadbeefdeadbeef'
    const before = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', recompute(tx as never))
    assert.strictEqual(reply.code, 'TAPOS_ERROR')
    assert.deepEqual(await probeState(node), before)
  })

  it('expired transaction', async () => {
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      1000,
      thinBase58,
    )) as unknown as { raw_data: Record<string, unknown> }
    tx.raw_data.expiration = 1
    const before = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', recompute(tx as never))
    assert.strictEqual(reply.code, 'TRANSACTION_EXPIRATION_ERROR')
    assert.deepEqual(await probeState(node), before)
  })

  it('accepted transfer balances the books, then its duplicate leaves no trace', async () => {
    const receiver = utils.accounts.generateAccount().address.base58
    const senderBefore = await tronWeb.trx.getBalance(ownerBase58)
    const before = await probeState(node)

    const signed = await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.sendTrx(receiver, 1_000_000, ownerBase58),
    )
    const accepted = (await post('wallet/broadcasttransaction', signed)) as { result?: boolean }
    assert.isTrue(accepted.result)

    // conservation: what left the sender arrived at the receiver or was burned
    const info = await tronWeb.trx.getTransactionInfo(signed.txID)
    const fee = (info.fee as number | undefined) ?? 0
    assert.strictEqual(await tronWeb.trx.getBalance(receiver), 1_000_000)
    assert.strictEqual(await tronWeb.trx.getBalance(ownerBase58), senderBefore - 1_000_000 - fee)
    const mid = await probeState(node)
    assert.strictEqual(mid.height, before.height + 1n)
    const txCount = (probe: { txIds: string }): number =>
      probe.txIds === '' ? 0 : probe.txIds.split(',').length
    assert.strictEqual(txCount(mid), txCount(before) + 1)

    // the exact same transaction again: rejected, nothing moves
    const dup = await post('wallet/broadcasttransaction', signed)
    assert.strictEqual(dup.code, 'DUP_TRANSACTION_ERROR')
    assert.deepEqual(await probeState(node), mid)
  })

  it('transfer above the sender balance', async () => {
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      100_000_000, // 100 TRX from a 10 TRX account
      thinBase58,
    )) as unknown as Record<string, unknown>
    tx.signature = ['00'.repeat(65)]
    const before = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', tx)
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.deepEqual(await probeState(node), before)
  })

  it('transfer covering the amount but not the new-account fee', async () => {
    const fresh = utils.accounts.generateAccount().address.base58
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      fresh,
      9_950_000, // 9.95 TRX of a 10 TRX balance, less the 0.1 TRX creation fee
      thinBase58,
    )) as unknown as Record<string, unknown>
    tx.signature = ['00'.repeat(65)]
    const before = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', tx)
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.deepEqual(await probeState(node), before)
    assert.strictEqual(await tronWeb.trx.getBalance(fresh), 0)
  })

  it('transfer carrying the recipient past the int64 its balance is stored in', async () => {
    const brim = 9_223_372_036_854_775_807n
    await nodeCore(node).setBalance(thin, brim)
    await nodeCore(node).setBalance(parseTronAddress(otherBase58), brim)
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      otherBase58,
      1_000_000,
      thinBase58,
    )) as unknown as Record<string, unknown>
    tx.signature = ['00'.repeat(65)]
    const before = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', tx)
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(messageText(reply.message as string), 'long overflow')
    assert.deepEqual(await probeState(node), before)
    await nodeCore(node).setBalance(thin, 10_000_000n)
    await nodeCore(node).setBalance(
      parseTronAddress(otherBase58),
      accountsFromMnemonic(config.mnemonic)[1].balance,
    )
  })

  it('TRC-10 transfer carrying the holder past the int64 its holding is stored in', async () => {
    // a TRC-10 is one per issuer, so this case brings an account of its own
    const brimKey = utils.accounts.generateAccount().privateKey.toLowerCase()
    const brimBase58 = TronWeb.address.fromPrivateKey(brimKey) as string
    await nodeCore(node).setBalance(parseTronAddress(brimBase58), 2_000_000_000_000n)
    const issuer = new TronWeb({ fullHost: baseUrl, privateKey: brimKey })
    const issue = await issuer.trx.sign(
      await issuer.transactionBuilder.createToken(
        {
          name: 'NetBrim',
          abbreviation: 'NBR',
          description: 'invariant net',
          url: 'https://devnode.invalid',
          totalSupply: 1_000_000,
          trxRatio: 1,
          tokenRatio: 1,
          saleStart: Date.now() + 5000,
          saleEnd: Date.now() + 3_600_000,
        },
        brimBase58,
      ),
    )
    assert.isTrue(
      ((await post('wallet/broadcasttransaction', issue)) as { result?: boolean }).result,
    )
    const tokenId = Number(
      ((await tronWeb.trx.getTransactionInfo(issue.txID)) as { assetIssueID?: string })
        .assetIssueID,
    )
    await nodeCore(node).creditAsset(thin, tokenId, 10n)
    await nodeCore(node).creditAsset(
      parseTronAddress(ownerBase58),
      tokenId,
      9_223_372_036_854_775_807n,
    )

    const tx = (await tronWeb.transactionBuilder.sendToken(
      ownerBase58,
      5,
      String(tokenId),
      thinBase58,
    )) as unknown as Record<string, unknown>
    tx.signature = ['00'.repeat(65)]
    const before = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', tx)
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(messageText(reply.message as string), 'long overflow')
    assert.deepEqual(await probeState(node), before)
  })

  it('TRC-10: reissue and overdrawn transfer leave no trace', async () => {
    const issuer = new TronWeb({ fullHost: baseUrl, privateKey: otherKey })
    const mkToken = (name: string) =>
      issuer.transactionBuilder.createToken(
        {
          name,
          abbreviation: name.slice(0, 3).toUpperCase(),
          description: 'invariant net',
          url: 'https://devnode.invalid',
          totalSupply: 1_000_000,
          trxRatio: 1,
          tokenRatio: 1,
          saleStart: Date.now() + 5000,
          saleEnd: Date.now() + 3_600_000,
        },
        otherBase58,
      )
    const issue = await issuer.trx.sign(await mkToken('NetOne'))
    assert.isTrue(
      ((await post('wallet/broadcasttransaction', issue)) as { result?: boolean }).result,
    )

    // a second issuance from the same account
    const again = await issuer.trx.sign(await mkToken('NetTwo'))
    const before = await probeState(node)
    const reissue = await post('wallet/broadcasttransaction', again)
    assert.strictEqual(reissue.code, 'CONTRACT_VALIDATE_ERROR')
    assert.deepEqual(await probeState(node), before)

    // a holder of zero tokens moving some anyway
    const tokenId = String(
      ((await tronWeb.trx.getTransactionInfo(issue.txID)) as { assetIssueID?: string })
        .assetIssueID,
    )
    const overdrawn = await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.sendToken(otherBase58, 5, tokenId, ownerBase58),
    )
    const before2 = await probeState(node)
    const reply = await post('wallet/broadcasttransaction', overdrawn)
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.deepEqual(await probeState(node), before2)
  })

  it('actuator field rules reject before billing, with the real wire messages', async () => {
    const contractAddr = utils.accounts.generateAccount().address.base58
    await nodeCore(node).setCode(parseTronAddress(contractAddr), hexToBytes('0x6001'))

    const attempt = async (
      overrides: Record<string, unknown>,
    ): Promise<{ code?: string; text: string; raw: string }> => {
      const tx = (await tronWeb.transactionBuilder.sendTrx(
        ownerBase58,
        1000,
        thinBase58,
      )) as unknown as {
        raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] }
      }
      Object.assign(tx.raw_data.contract[0].parameter.value, overrides)
      const before = await probeState(node)
      const reply = (await post('wallet/broadcasttransaction', recompute(tx as never))) as {
        code?: string
        message?: string
      }
      assert.deepEqual(await probeState(node), before)
      return {
        code: reply.code,
        text: messageText(reply.message),
        raw: TronWeb.toUtf8(reply.message ?? ''),
      }
    }

    const self = await attempt({ to_address: TronWeb.address.toHex(thinBase58) })
    assert.strictEqual(self.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(self.text, 'Cannot transfer TRX to yourself.')

    // the prefix itself, pinned once — every other assertion strips it
    assert.strictEqual(
      `Contract validate error : ${self.text}`,
      'Contract validate error : Cannot transfer TRX to yourself.',
    )
    assert.strictEqual(self.raw, 'Contract validate error : Cannot transfer TRX to yourself.')

    const zero = await attempt({ amount: 0 })
    assert.strictEqual(zero.text, 'Amount must be greater than 0.')

    // the transfer-to-contract rule is proposal-gated and the gate is off here,
    // matching what this node reports in getchainparameters — so that case is
    // deliberately absent from this rejection set

    // text that is no address at all fails the merge, and the merge drops the
    // whole contract — the reply is about the emptied list, not the field
    const malformed = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      1000,
      thinBase58,
    )) as unknown as {
      raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] }
      signature?: string[]
    }
    malformed.raw_data.contract[0].parameter.value.to_address = 'not-an-address'
    malformed.signature = ['00'.repeat(65)]
    const before = await probeState(node)
    const reply = (await post('wallet/broadcasttransaction', malformed)) as {
      code?: string
      message?: string
    }
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(messageText(reply.message), 'No contract!')
    assert.deepEqual(await probeState(node), before)
  })

  it('contract deploy rules reject before billing, and the params round-trip', async () => {
    const INC = '6000546001018060005560005260206000f3'
    const bytecode = `601280600b6000396000f3${INC}`

    const deploy = async (overrides: Record<string, unknown>): Promise<string> => {
      const built = (await tronWeb.transactionBuilder.createSmartContract(
        {
          abi: [],
          bytecode,
          feeLimit: 1_000_000_000,
          callValue: 0,
          name: 'T',
          userFeePercentage: 100,
          originEnergyLimit: 10_000_000,
        } as never,
        thinBase58,
      )) as unknown as {
        raw_data: {
          fee_limit?: number
          contract: { parameter: { value: Record<string, unknown> } }[]
        }
      }
      const newContract = built.raw_data.contract[0].parameter.value.new_contract as Record<
        string,
        unknown
      >
      for (const [key, entry] of Object.entries(overrides)) {
        if (key === 'fee_limit') built.raw_data.fee_limit = entry as number
        else newContract[key] = entry
      }
      const before = await probeState(node)
      const reply = (await post('wallet/broadcasttransaction', recompute(built as never))) as {
        result?: boolean
        message?: string
      }
      if (reply.result === true) return 'ACCEPTED'
      assert.deepEqual(await probeState(node), before)
      return messageText(reply.message)
    }

    assert.strictEqual(
      await deploy({ consume_user_resource_percent: 150 }),
      'percent must be >= 0 and <= 100',
    )
    assert.strictEqual(
      await deploy({ origin_energy_limit: -5 }),
      'The originEnergyLimit must be > 0',
    )
    assert.strictEqual(
      await deploy({ origin_energy_limit: 0 }),
      'The originEnergyLimit must be > 0',
    )
    assert.strictEqual(
      await deploy({ name: 'x'.repeat(33) }),
      "contractName's length cannot be greater than 32",
    )
    assert.strictEqual(
      await deploy({ fee_limit: 900_000_000_000 }),
      'feeLimit must be >= 0 and <= 15000000000',
    )

    // an accepted deploy reports back the limits it was given, not defaults
    const signed = await tronWeb.trx.sign(
      (await tronWeb.transactionBuilder.createSmartContract(
        {
          abi: [],
          bytecode,
          feeLimit: 1_000_000_000,
          callValue: 0,
          name: 'Params',
          userFeePercentage: 40,
          originEnergyLimit: 5_000_000,
        } as never,
        ownerBase58,
      )) as never,
    )
    assert.isTrue(
      ((await post('wallet/broadcasttransaction', signed)) as { result?: boolean }).result,
    )
    const address = (
      (await tronWeb.trx.getTransactionInfo((signed as never as { txID: string }).txID)) as {
        contract_address?: string
      }
    ).contract_address as string
    const contract = (await tronWeb.trx.getContract(
      TronWeb.address.fromHex(address),
    )) as unknown as Record<string, unknown>
    assert.strictEqual(contract.consume_user_resource_percent, 40)
    assert.strictEqual(contract.origin_energy_limit, 5_000_000)
  })

  it('calling an address that holds no code is rejected', async () => {
    const codeless = utils.accounts.generateAccount().address.base58
    const seed = utils.accounts.generateAccount().address.base58
    await nodeCore(node).setCode(parseTronAddress(seed), hexToBytes('0x6001'))

    const built = (await tronWeb.transactionBuilder.triggerSmartContract(
      TronWeb.address.toHex(seed),
      'x()',
      { feeLimit: 100_000_000 },
      [],
      TronWeb.address.toHex(thinBase58),
    )) as unknown as {
      transaction: { raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] } }
    }
    built.transaction.raw_data.contract[0].parameter.value.contract_address =
      TronWeb.address.toHex(codeless)

    const before = await probeState(node)
    const reply = (await post(
      'wallet/broadcasttransaction',
      recompute(built.transaction as never),
    )) as { code?: string; message?: string }
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(messageText(reply.message), 'No contract or not a smart contract')
    assert.deepEqual(await probeState(node), before)
  })

  it('an address whose prefix is not 41 is rejected, never aliased onto 41', async () => {
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      4242,
      thinBase58,
    )) as unknown as {
      raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] }
    }
    const real = String(tx.raw_data.contract[0].parameter.value.to_address)
    // same 20 bytes, different prefix: must not land on the 41 account
    tx.raw_data.contract[0].parameter.value.to_address = `42${real.slice(2)}`

    const before = await probeState(node)
    const reply = (await post('wallet/broadcasttransaction', recompute(tx as never))) as {
      code?: string
      message?: string
    }
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(messageText(reply.message), 'Invalid toAddress')
    assert.deepEqual(await probeState(node), before)
  })

  it('a transaction carrying more than one contract is rejected', async () => {
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      1000,
      thinBase58,
    )) as unknown as { raw_data: { contract: unknown[] } }
    tx.raw_data.contract = [tx.raw_data.contract[0], tx.raw_data.contract[0]]

    const before = await probeState(node)
    const reply = (await post('wallet/broadcasttransaction', recompute(tx as never))) as {
      code?: string
      message?: string
    }
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.match(
      messageText(reply.message),
      /^tx [0-9a-f]{64} contract size should be exactly 1, this is extend feature ,actual :2$/,
    )
    assert.deepEqual(await probeState(node), before)
  })

  it('a deploy onto an address that already holds an account is rejected', async () => {
    const built = (await tronWeb.transactionBuilder.createSmartContract(
      {
        abi: [],
        bytecode: '0x6001600155',
        feeLimit: 100_000_000,
      },
      thinBase58,
    )) as unknown as {
      contract_address: string
      raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] }
      txID: string
    }
    // occupy the address the deploy is about to claim
    const predicted = parseTronAddress(built.contract_address)
    await nodeCore(node).setCode(predicted, hexToBytes('0xdeadbeef'))

    const before = await probeState(node)
    const reply = (await post('wallet/broadcasttransaction', recompute(built as never))) as {
      code?: string
      message?: string
    }
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(
      messageText(reply.message),
      `Trying to create a contract with existing contract address: ${TronWeb.address.fromHex(built.contract_address)}`,
    )
    assert.deepEqual(await probeState(node), before)
    // the squatting code survives untouched
    assert.strictEqual(bytesToHex(await nodeCore(node).getCode(predicted)), '0xdeadbeef')
  })

  it('a memo costs the flat fee, folded into the total', async () => {
    const memoFee = BigInt(config.chainParameters.memoFee)

    // the memo is attached on the wire: TronWeb's own helper for this rides
    // getsignweight, which this node does not serve yet
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      thinBase58,
      1000,
      ownerBase58,
    )) as unknown as Record<string, unknown>
    ;(tx.raw_data as Record<string, unknown>).data = TronWeb.fromUtf8('hello').replace(/^0x/, '')
    const withMemo = recompute(tx)
    nodeCore(node).unlockedAccounts.add(ownerBase58)

    const balanceBefore = await tronWeb.trx.getBalance(ownerBase58)
    const accepted = (await post('wallet/broadcasttransaction', withMemo)) as { result?: boolean }
    assert.isTrue(accepted.result)

    const info = (await tronWeb.trx.getTransactionInfo(withMemo.txID as string)) as unknown as {
      receipt?: Record<string, unknown>
      fee?: number
    }
    // the charge shows up in the total; ResourceReceipt carries no memo field
    assert.isUndefined(info.receipt?.memo_fee)
    // the memo fee is part of the total, and left the sender's balance
    const spent = balanceBefore - (await tronWeb.trx.getBalance(ownerBase58))
    assert.strictEqual(spent, 1000 + (info.fee ?? 0))
    assert.isAtLeast(info.fee ?? 0, Number(memoFee))
    nodeCore(node).unlockedAccounts.delete(ownerBase58)
  })

  it('resource endpoints stay silent about accounts that do not exist', async () => {
    const ghost = utils.accounts.generateAccount().address.base58
    for (const path of ['wallet/getaccount', 'wallet/getaccountresource', 'wallet/getaccountnet']) {
      const reply = await post(path, { address: ghost, visible: true })
      assert.deepEqual(reply, {}, path)
    }
  })

  it('createtransaction runs the same actuator rules as the broadcast path', async () => {
    const build = async (body: Record<string, unknown>): Promise<{ Error?: string }> =>
      (await post('wallet/createtransaction', { visible: true, ...body })) as { Error?: string }

    const contractHolder = utils.accounts.generateAccount().address.base58
    await nodeCore(node).setCode(parseTronAddress(contractHolder), hexToBytes('0x6001'))
    const ghost = utils.accounts.generateAccount().address.base58

    const cases: [Record<string, unknown>, string][] = [
      [
        { owner_address: thinBase58, to_address: thinBase58, amount: 1 },
        'Cannot transfer TRX to yourself.',
      ],
      [
        { owner_address: ghost, to_address: thinBase58, amount: 1 },
        'Validate TransferContract error, no OwnerAccount.',
      ],
    ]
    for (const [body, message] of cases) {
      const reply = await build(body)
      assert.strictEqual(reply.Error, message)
    }

    // a well-formed request still builds
    const good = (await build({
      owner_address: thinBase58,
      to_address: ownerBase58,
      amount: 1,
    })) as Record<string, unknown>
    assert.isDefined(good.txID)
  })

  it('a transaction declaring an unknown permission id is rejected', async () => {
    const tx = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      1000,
      otherBase58,
    )) as unknown as {
      raw_data: { contract: { Permission_id?: number }[] }
    }
    tx.raw_data.contract[0].Permission_id = 5
    // the id is part of raw_data, so the txID has to follow it before signing
    const pb = txJsonToPb(tx as never)
    ;(tx as unknown as Record<string, unknown>).txID = txPbToTxID(pb).replace(/^0x/, '')
    ;(tx as unknown as Record<string, unknown>).raw_data_hex = txPbToRawDataHex(pb)
      .replace(/^0x/, '')
      .toLowerCase()
    const signed = utils.crypto.signTransaction(otherKey, tx as never)

    const before = await probeState(node)
    const reply = (await post('wallet/broadcasttransaction', signed)) as {
      code?: string
      message?: string
    }
    assert.strictEqual(reply.code, 'SIGERROR')
    assert.strictEqual(messageText(reply.message), "permission isn't exit")
    assert.deepEqual(await probeState(node), before)
  })

  /** the same transaction with its address fields written in base58 — the
   *  form a visible=true request must state them in */
  function inVisibleForm(tx: Record<string, unknown>): Record<string, unknown> {
    const clone = JSON.parse(JSON.stringify(tx)) as {
      raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] }
    }
    const value = clone.raw_data.contract[0].parameter.value
    for (const field of ['owner_address', 'to_address']) {
      if (typeof value[field] === 'string') {
        value[field] = TronWeb.address.fromHex(String(value[field]))
      }
    }
    return clone as unknown as Record<string, unknown>
  }

  it('getsignweight reports the permission, weight and signers', async () => {
    const unsigned = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      1000,
      otherBase58,
    )) as unknown as Record<string, unknown>

    const before = (await post('wallet/getsignweight', {
      ...inVisibleForm(unsigned),
      visible: true,
    })) as {
      result?: { code?: string }
      current_weight?: number
      permission?: { threshold?: number; permission_name?: string }
    }
    assert.strictEqual(before.result?.code, 'NOT_ENOUGH_PERMISSION')
    assert.strictEqual(before.permission?.permission_name, 'owner')
    assert.isUndefined(before.current_weight)

    const signed = utils.crypto.signTransaction(otherKey, unsigned as never) as unknown as Record<
      string,
      unknown
    >
    const after = (await post('wallet/getsignweight', {
      ...inVisibleForm(signed),
      visible: true,
    })) as {
      result?: { code?: string }
      current_weight?: number
      approved_list?: string[]
    }
    // ENOUGH_PERMISSION is the first member of the enum, so it is not printed
    assert.isUndefined(after.result?.code)
    assert.strictEqual(after.current_weight, 1)
    assert.deepEqual(after.approved_list, [otherBase58]) // visible=true → base58

    const approved = (await post('wallet/getapprovedlist', signed)) as {
      result?: { code?: string }
      approved_list?: string[]
    }
    // SUCCESS is the first member of the enum, so it is not printed
    assert.isUndefined(approved.result?.code)
    // hex unless visible is asked for
    assert.deepEqual(approved.approved_list, [TronWeb.address.toHex(otherBase58)])
  })

  it('getapprovedlist normalizes a permission failure without Java class names', async () => {
    const unsigned = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      1000,
      otherBase58,
    )) as unknown as Record<string, unknown>
    const changed = JSON.parse(JSON.stringify(unsigned)) as {
      raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] }
    }
    const missingOwner = utils.accounts.generateAccount().address.base58
    changed.raw_data.contract[0].parameter.value.owner_address = TronWeb.address.toHex(missingOwner)

    const reply = (await post('wallet/getapprovedlist', changed)) as {
      result?: { code?: string; message?: string }
    }
    assert.deepEqual(reply.result, {
      code: 'OTHER_ERROR',
      message: 'Account does not exist!',
    })
  })

  it('a throw inside the billed region still refunds', async () => {
    // origin_address is only reachable by hand: TronWeb never emits a bad one
    const built = (await tronWeb.transactionBuilder.createSmartContract(
      { abi: [], bytecode: '0x6001600155', feeLimit: 100_000_000 },
      thinBase58,
    )) as unknown as {
      raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] }
    }
    const newContract = built.raw_data.contract[0].parameter.value.new_contract as Record<
      string,
      unknown
    >
    newContract.origin_address = `42${'11'.repeat(20)}`

    const before = await probeState(node)
    const balanceBefore = await tronWeb.trx.getBalance(thinBase58)
    const reply = (await post('wallet/broadcasttransaction', recompute(built as never))) as {
      code?: string
      message?: string
    }
    // rejected in the broadcast dialect, not as a servlet exception
    assert.strictEqual(reply.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(messageText(reply.message), 'Invalid OriginAddress')
    assert.strictEqual(await tronWeb.trx.getBalance(thinBase58), balanceBefore)
    assert.deepEqual(await probeState(node), before)
  })

  it('a rejected broadcast does not restart the bandwidth recovery window', async () => {
    const spender = utils.accounts.generateAccount().address.base58
    const spenderAddr = parseTronAddress(spender)
    await nodeCore(node).setBalance(spenderAddr, 100_000_000n)
    nodeCore(node).unlockedAccounts.add(spender)

    // spend some free quota with an accepted transfer
    const good = await tronWeb.transactionBuilder.sendTrx(ownerBase58, 1000, spender)
    assert.isTrue(
      (
        (await post('wallet/broadcasttransaction', recompute(good as never))) as {
          result?: boolean
        }
      ).result,
    )
    const usedAfterAccepted = nodeCore(node).getFreeBandwidthUsed(spenderAddr)
    assert.isAbove(usedAfterAccepted, 0)

    // then a rejected one, at a later moment
    clock.advanceMs(6 * 3600 * 1000)
    const decayed = nodeCore(node).getFreeBandwidthUsed(spenderAddr)
    const bad = (await tronWeb.transactionBuilder.sendTrx(
      ownerBase58,
      1000,
      spender,
    )) as unknown as { raw_data: { contract: { parameter: { value: Record<string, unknown> } }[] } }
    bad.raw_data.contract[0].parameter.value.amount = 0
    await post('wallet/broadcasttransaction', recompute(bad as never))

    // the ledger is exactly where the decay left it — the rejection changed
    // neither the byte count nor the moment recovery is measured from
    assert.strictEqual(nodeCore(node).getFreeBandwidthUsed(spenderAddr), decayed)
    clock.advanceMs(18 * 3600 * 1000)
    assert.strictEqual(nodeCore(node).getFreeBandwidthUsed(spenderAddr), 0)
  })

  it('an address form that contradicts visible strips the contract, both ways', async () => {
    const signed = (await tronWeb.trx.sign(
      await tronWeb.transactionBuilder.sendTrx(otherBase58, 1000, ownerBase58),
    )) as unknown as Record<string, unknown>

    // hex addresses declared as visible: the merge drops the contract, the
    // broadcast judges the emptied list, and the reply's id is the packed
    // transaction's — the envelope alone
    const before = await probeState(node)
    const hexAsVisible = (await post('wallet/broadcasttransaction', {
      ...JSON.parse(JSON.stringify(signed)),
      visible: true,
    })) as { code?: string; message?: string; txid?: string }
    assert.strictEqual(hexAsVisible.code, 'CONTRACT_VALIDATE_ERROR')
    // visible=true prints Return.message as the text it holds
    assert.strictEqual(hexAsVisible.message, 'Contract validate error : No contract!')
    assert.notStrictEqual(hexAsVisible.txid, signed.txID)
    assert.deepEqual(await probeState(node), before)

    // base58 addresses without visible: the hex reading refuses them the same way
    const base58Plain = (await post('wallet/broadcasttransaction', {
      ...inVisibleForm(signed),
      visible: false,
    })) as { code?: string; message?: string }
    assert.strictEqual(base58Plain.code, 'CONTRACT_VALIDATE_ERROR')
    assert.strictEqual(messageText(base58Plain.message), 'No contract!')
    assert.deepEqual(await probeState(node), before)

    // the weight endpoint reports the emptied list as its own condition, with
    // the packed transaction echoed
    const weighed = (await post('wallet/getsignweight', {
      ...JSON.parse(JSON.stringify(signed)),
      visible: true,
    })) as {
      result?: { code?: string; message?: string }
      transaction?: { transaction?: { raw_data?: { contract?: unknown[] } } }
    }
    assert.strictEqual(weighed.result?.code, 'OTHER_ERROR')
    assert.strictEqual(weighed.result?.message, 'Invalid transaction: no valid contract')
    assert.deepEqual(weighed.transaction?.transaction?.raw_data?.contract, [])
  })

  it('broadcasthex: invalid and undecodable payloads leave no trace', async () => {
    const before = await probeState(node)
    const invalid = await post('wallet/broadcasthex', { transaction: 'zz-not-hex' })
    assert.strictEqual(
      invalid.Error,
      'exception decoding Hex string: invalid characters encountered in Hex string',
    )
    const garbage = await post('wallet/broadcasthex', { transaction: 'deadbeef' })
    assert.strictEqual(
      garbage.Error,
      'While parsing a protocol message, the input ended unexpectedly in the middle of a field.  This could mean either that the input has been truncated or that an embedded message misreported its own length.',
    )
    // a lower-case 0x prefix decodes, so an empty transaction reaches
    // broadcast validation instead of failing the hex read
    const prefixedEmpty = await post('wallet/broadcasthex', { transaction: '0x' })
    assert.deepInclude(prefixedEmpty, {
      result: false,
      code: 'CONTRACT_VALIDATE_ERROR',
      message: 'Contract validate error : No contract!',
      transaction: '{}',
    })
    assert.deepEqual(await probeState(node), before)
  })
})
