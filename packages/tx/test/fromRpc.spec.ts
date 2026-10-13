import { TronMainnet, createCustomCommon } from '@tvmjs/common'
import { bytesToHex, randomBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import {
  TransactionType,
  createTx,
  createTxFromJSONRPCProvider,
  createTxFromRPC,
} from '../src/index.ts'
import { normalizeTxParams } from '../src/util/general.ts'

import { optimismTxData } from './testData/optimismTx.ts'
import { rpcTxData } from './testData/rpcTx.ts'
import { v0txData } from './testData/v0tx.ts'

import type { TypedTxData } from '../src/index.ts'

const txTypes = [
  TransactionType.Legacy,
  TransactionType.AccessListEIP2930,
  TransactionType.FeeMarketEIP1559,
]

// The bundled RPC envelope uses chain ID 1; its execution profile remains TRON.
const common = createCustomCommon({ chainId: 1 }, TronMainnet)

describe('[fromJSONRPCProvider]', () => {
  it('should work', async () => {
    const provider = 'https://my.json.rpc.provider.com:8545'

    const realFetch = fetch
    //@ts-expect-error -- Typescript doesn't like us to replace global values

    fetch = async (_url: string, req: any) => {
      const json = JSON.parse(req.body)
      assert.strictEqual(_url, provider)
      assert.strictEqual(json.method, 'eth_getTransactionByHash')
      if (json.params[0] === '0xed1960aa7d0d7b567c946d94331dddb37a1c67f51f30bf51f256ea40db88cfb0') {
        return {
          ok: true,
          status: 200,
          json: () => {
            return {
              result: rpcTxData,
            }
          },
        }
      } else {
        return {
          ok: true,
          status: 200,
          json: () => {
            return {
              result: null, // This is the value Infura returns if no transaction is found matching the provided hash
            }
          },
        }
      }
    }

    try {
      const txHash = '0xed1960aa7d0d7b567c946d94331dddb37a1c67f51f30bf51f256ea40db88cfb0'
      const tx = await createTxFromJSONRPCProvider(provider, txHash, { common })
      assert.strictEqual(
        bytesToHex(tx.hash()),
        txHash,
        'generated correct tx from transaction RPC data',
      )
      try {
        await createTxFromJSONRPCProvider(provider, bytesToHex(randomBytes(32)), { common })
        assert.fail('should throw')
      } catch (err: any) {
        assert.include(err.message, 'No data returned from provider')
      }
    } finally {
      //@ts-expect-error -- Assigning to a global function
      fetch = realFetch
    }
  })
})

describe('[normalizeTxParams]', () => {
  it('should work', () => {
    const normedTx = normalizeTxParams(rpcTxData)
    const tx = createTx(normedTx, { common })
    assert.strictEqual(normedTx.gasLimit, 21000n, 'correctly converted "gas" to "gasLimit"')
    assert.strictEqual(
      bytesToHex(tx.hash()),
      rpcTxData.hash,
      'converted normed tx data to transaction object',
    )
  })
})

describe('fromRPC: interpret v/r/s values of 0x0 as undefined for Optimism system txs', () => {
  it('should work', async () => {
    for (const txType of txTypes) {
      const tx = await createTxFromRPC({ ...optimismTxData, type: txType } as TypedTxData)
      assert.isUndefined(tx.v)
      assert.isUndefined(tx.s)
      assert.isUndefined(tx.r)
    }
  })
})

// This test ensures that "normal" txs of non-legacy type are correctly decoded if the
// `v` value is 0. This is the case in ~50% of the EIP2930 and EIP1559 txs
// The `v` value is either 0 or 1 there.
describe('fromRPC: ensure `v="0x0"` is correctly decoded for signed txs', () => {
  it('should work', async () => {
    for (const txType of txTypes) {
      if (txType === TransactionType.Legacy) {
        // legacy tx cannot have v=0
        continue
      }
      const common = createCustomCommon({ chainId: 0x10f2c }, TronMainnet)
      const tx = await createTxFromRPC({ ...v0txData, type: txType } as TypedTxData, { common })
      assert.isTrue(tx.isSigned())
      assert.strictEqual(tx.v, 0n)
    }
  })
})
