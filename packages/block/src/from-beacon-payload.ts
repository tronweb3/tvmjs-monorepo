import { bigIntToHex } from '@tvmjs/util'

import { rejectRemovedHeaderFields } from './helpers.ts'

import type { NumericString, PrefixedHexString } from '@tvmjs/util'
import type { ExecutionPayload } from './types.ts'

type BeaconWithdrawal = {
  index: PrefixedHexString
  validator_index: PrefixedHexString
  address: PrefixedHexString
  amount: PrefixedHexString
}

// Payload JSON that one gets using the beacon apis
// curl localhost:5052/eth/v2/beacon/blocks/56610 | jq .data.message.body.execution_payload
export type BeaconPayloadJSON = {
  parent_hash: PrefixedHexString
  fee_recipient: PrefixedHexString
  state_root: PrefixedHexString
  receipts_root: PrefixedHexString
  logs_bloom: PrefixedHexString
  prev_randao: PrefixedHexString
  block_number: NumericString
  gas_limit: NumericString
  gas_used: NumericString
  timestamp: NumericString
  extra_data: PrefixedHexString
  base_fee_per_gas: NumericString
  block_hash: PrefixedHexString
  transactions: PrefixedHexString[]
  withdrawals?: BeaconWithdrawal[]
  requests_hash?: PrefixedHexString
}

/**
 * Converts a beacon block execution payload JSON object {@link BeaconPayloadJSON} to the {@link ExecutionPayload} data needed to construct a {@link Block}.
 * The JSON data can be retrieved from a consensus layer (CL) client on this Beacon API `/eth/v2/beacon/blocks/[block number]`
 */
export function executionPayloadFromBeaconPayload(payload: BeaconPayloadJSON): ExecutionPayload {
  rejectRemovedHeaderFields(payload)
  const executionPayload: ExecutionPayload = {
    parentHash: payload.parent_hash,
    feeRecipient: payload.fee_recipient,
    stateRoot: payload.state_root,
    receiptsRoot: payload.receipts_root,
    logsBloom: payload.logs_bloom,
    prevRandao: payload.prev_randao,
    blockNumber: bigIntToHex(BigInt(payload.block_number)),
    gasLimit: bigIntToHex(BigInt(payload.gas_limit)),
    gasUsed: bigIntToHex(BigInt(payload.gas_used)),
    timestamp: bigIntToHex(BigInt(payload.timestamp)),
    extraData: payload.extra_data,
    baseFeePerGas: bigIntToHex(BigInt(payload.base_fee_per_gas)),
    blockHash: payload.block_hash,
    transactions: payload.transactions,
  }

  if (payload.withdrawals !== undefined && payload.withdrawals !== null) {
    executionPayload.withdrawals = payload.withdrawals.map((wd) => ({
      index: bigIntToHex(BigInt(wd.index)),
      validatorIndex: bigIntToHex(BigInt(wd.validator_index)),
      address: wd.address,
      amount: bigIntToHex(BigInt(wd.amount)),
    }))
  }
  if (payload.requests_hash !== undefined && payload.requests_hash !== null) {
    executionPayload.requestsHash = payload.requests_hash
  }

  return executionPayload
}
