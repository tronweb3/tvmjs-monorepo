import { account as account0 } from './accounts/0x0000000000000000000000000000000000000000.ts'
import { account as account1 } from './accounts/0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.ts'
import { account as account3 } from './accounts/0x7b0f34615564cd976fea815d9691cc102f4058d6.ts'
import { account as account2 } from './accounts/0x580992b51e3925e23280efb93d3047c82f17e038.ts'
import { account as account4 } from './accounts/0xbe862ad9abfe6f22bcb087716c7d89a26051f74c.ts'
import { account as account5 } from './accounts/0xcad621da75a66c7a8f4ff86d30a2bf981bfc8fdd.ts'
import { account as account6 } from './accounts/0xccafdd642118e5536024675e776d32413728dd07.ts'
import { account as account7 } from './accounts/0xd8da6bf26964af9d7eed9e03e53415d37aa96045.ts'
import { block as previousBlock } from './blocks/block0x7a11f.ts'
import { block as currentBlock } from './blocks/block0x7a120.ts'
import { tx } from './transactions/0xed1960aa7d0d7b567c946d94331dddb37a1c67f51f30bf51f256ea40db88cfb0.ts'

const accounts: Record<string, Record<string, unknown>> = {
  '0x0000000000000000000000000000000000000000': account0,
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': account1,
  '0x580992b51e3925e23280efb93d3047c82f17e038': account2,
  '0x7b0f34615564cd976fea815d9691cc102f4058d6': account3,
  '0xbe862ad9abfe6f22bcb087716c7d89a26051f74c': account4,
  '0xcad621da75a66c7a8f4ff86d30a2bf981bfc8fdd': account5,
  '0xccafdd642118e5536024675e776d32413728dd07': account6,
  '0xd8da6bf26964af9d7eed9e03e53415d37aa96045': account7,
}

export type SupportedMethods =
  | 'eth_getProof'
  | 'eth_getStorageAt'
  | 'eth_getCode'
  | 'eth_getBlockByNumber'
  | 'eth_getTransactionByHash'

const getProofValues = async (params: [address: string, _: [], blockTag: bigint | string]) => {
  const [address, _slot, blockTag] = params
  const account = accounts[address]
  if (account !== undefined) {
    const result = account[blockTag.toString()]
    if (result === undefined)
      throw new Error(`Missing account fixture for ${address} at ${blockTag}`)
    return result
  }
  return {
    address,
    balance: '0x0',
    codeHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    nonce: '0x0',
    storageHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    storageProof: [],
  }
}

const getBlockValues = async (params: [blockTag: string, _: boolean]) => {
  const [blockTag, _] = params
  if (blockTag.slice(0, 2) !== '0x')
    return {
      number: 'latest',
      stateRoot: '0x2ffb7ec5bbe8616c24a222737f0817f389d00ab9268f9574e0b7dfe251fbfa05',
    }
  if (blockTag === '0x7a120') return currentBlock
  if (blockTag === '0x7a11f') return previousBlock
  throw new Error(`Missing block fixture for ${blockTag}`)
}

const getTransactionData = async (params: [txHash: string]) => {
  const [txHash] = params
  if (txHash !== tx.hash) throw new Error(`Missing transaction fixture for ${txHash}`)
  return tx
}

export const getValues = async (
  method: SupportedMethods,
  id: number,
  params: any,
): Promise<{ id: number; result: unknown }> => {
  switch (method) {
    case 'eth_getProof':
      return {
        id,
        result: await getProofValues(params),
      }

    case 'eth_getBlockByNumber':
      return {
        id,
        result: await getBlockValues(params),
      }

    case 'eth_getTransactionByHash':
      return {
        id,
        result: await getTransactionData(params),
      }

    case 'eth_getCode': {
      let code = '0x'
      if (params[0] !== '0xd8da6bf26964af9d7eed9e03e53415d37aa96045') {
        code = '0xab'
      }
      return {
        id,
        result: code,
      }
    }
    case 'eth_getStorageAt':
      return {
        id,
        result: '0xabcd',
      }

    default:
      throw new Error(`${method} not supported in tests`)
  }
}
