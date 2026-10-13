import { runTronRPCPoc } from './tronRPCClient.ts'

import type { TronNetwork } from '@tvmjs/common'
import type { PrefixedHexString } from '@tvmjs/util'

// cspell:ignore walletsolidity

async function main() {
  const jsonRpcUrl = process.env.TRON_JSON_RPC_URL
  const walletUrl = process.env.TRON_WALLET_URL
  const caller = process.env.TRON_CALLER
  const contract = process.env.TRON_CONTRACT
  const calldata = process.env.TRON_CALLDATA as PrefixedHexString | undefined
  if (
    jsonRpcUrl === undefined ||
    walletUrl === undefined ||
    caller === undefined ||
    contract === undefined ||
    calldata === undefined
  ) {
    console.log('Example skipped (live java-tron endpoint and call parameters required)')
    console.log(
      'Set TRON_JSON_RPC_URL, TRON_WALLET_URL, TRON_CALLER, TRON_CONTRACT, and TRON_CALLDATA.',
    )
    return
  }

  const result = await runTronRPCPoc({
    jsonRpcUrl,
    walletUrl,
    apiKey: process.env.TRON_PRO_API_KEY,
    walletApiPrefix:
      process.env.TRON_WALLET_API_PREFIX === 'walletsolidity' ? 'walletsolidity' : 'wallet',
    network: (process.env.TRON_NETWORK as TronNetwork | undefined) ?? 'mainnet',
    caller,
    contract,
    calldata,
    transactionId: process.env.TRON_TRANSACTION_ID as PrefixedHexString | undefined,
    stateTag:
      process.env.TRON_BLOCK_NUMBER === undefined
        ? 'latest'
        : BigInt(process.env.TRON_BLOCK_NUMBER),
  })
  console.log(
    `Reference block: ${result.blockNumber}; local block: ${result.localBlockNumber} (same snapshot: ${result.blockStable})`,
  )
  console.log(`Local return:  ${result.localReturnValue}`)
  console.log(`Remote return: ${result.remoteReturnValue}`)
  console.log(`Return values match: ${result.returnValueMatches}`)
  console.log(`Local energy used: ${result.localEnergyUsed}`)
  console.log(`Remote energy used: ${result.remoteEnergyUsed ?? 'not reported'}`)
  console.log(`Energy matches: ${result.energyMatches ?? 'not comparable'}`)
  console.log(`RPC transaction: ${result.rpcTransaction?.hash ?? 'none selected'}`)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
