import { bytesToHex } from '@tvmjs/util'

import { parseBalance } from './balance.ts'
import { temporaryAccountsOptions } from './development/admin.ts'
import { blockReference, transactionHash } from './development/debug.ts'
import { storageWord } from './development/tre.ts'
import { decodeAddress } from './dialect/tre/decode.ts'
import { isVisible, toBase58, toTronHex } from './dialect/tron/address.ts'
import {
  MERGED_MESSAGE,
  MESSAGE_FIELDS,
  MESSAGE_FIELD_TYPES,
  SELF_FORMAT_FIELDS,
} from './dialect/tron/mergedFields.ts'
import { parseBytes, parseInteger } from './input.ts'
import { INT32_MAX, INT32_MIN, INT64_MAX, INT64_MIN } from './intBounds.ts'
import { requestKeyed } from './lookup.ts'
import { InvalidParamsError } from './provider.ts'

import type { HandlerParams, RegisteredMethod } from './dialect/registry.ts'
import type { ProviderParams } from './rpc.ts'

/** Field formats for routes that decode these fields inside their handlers. */
const HANDLER_SELF_FORMAT_FIELDS: typeof SELF_FORMAT_FIELDS = requestKeyed({
  'wallet/deploycontract': SELF_FORMAT_FIELDS.CreateSmartContract,
  'wallet/triggersmartcontract': SELF_FORMAT_FIELDS.TriggerSmartContract,
  'wallet/triggerconstantcontract': SELF_FORMAT_FIELDS.TriggerSmartContract,
  'wallet/estimateenergy': SELF_FORMAT_FIELDS.TriggerSmartContract,
  'wallet/getaccountresource': { address: 'address' },
  'wallet/getReward': { address: 'address' },
  'wallet/getBrokerage': { address: 'address' },
  'wallet/getcontract': { value: 'address' },
  'wallet/getcontractinfo': { value: 'address' },
  'wallet/getmarketorderbyaccount': { value: 'address' },
})

/** Integer fields parsed inside the smart-contract handlers rather than a merged message. */
const HANDLER_SELF_INTEGER_FIELDS: Readonly<Record<string, readonly string[]>> = requestKeyed({
  'wallet/deploycontract': [
    'call_value',
    'call_token_value',
    'token_id',
    'consume_user_resource_percent',
    'origin_energy_limit',
    'fee_limit',
  ],
  'wallet/triggersmartcontract': ['call_value', 'call_token_value', 'token_id', 'fee_limit'],
  'wallet/triggerconstantcontract': ['call_value', 'call_token_value', 'token_id', 'fee_limit'],
  'wallet/estimateenergy': ['call_value', 'call_token_value', 'token_id', 'fee_limit'],
})

function addressInput(value: unknown, visible: boolean): unknown {
  if (value === undefined || value === null || value === '') return value
  if (typeof value !== 'string') throw new InvalidParamsError('invalid address')
  const address = decodeAddress(value)
  return visible ? toBase58(address) : toTronHex(address)
}

/** Normalize declared fields in the owned request snapshot, including nested messages. */
function messageInput(
  params: HandlerParams,
  message: string,
  visible: boolean,
  formats = SELF_FORMAT_FIELDS[message],
  path = '',
): HandlerParams {
  for (const [key, value] of Object.entries(params)) {
    const label = path === '' ? key : `${path}.${key}`
    const kind = MESSAGE_FIELDS[message]?.[key]
    if (value !== undefined && (kind === 'int32' || kind === 'int64')) {
      params[key] = parseInteger(value, label, {
        min: kind === 'int32' ? INT32_MIN : INT64_MIN,
        max: kind === 'int32' ? INT32_MAX : INT64_MAX,
      })
      continue
    }
    if (formats?.[key] === 'address') {
      params[key] =
        MESSAGE_FIELDS[message]?.[key] === 'bytes[]' && Array.isArray(value)
          ? value.map((entry) => addressInput(entry, visible))
          : addressInput(value, visible)
      continue
    }
    const nestedMessage = MESSAGE_FIELD_TYPES[message]?.[key]
    if (nestedMessage === undefined) continue
    const normalize = (entry: unknown, entryPath: string): unknown =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? messageInput(entry as HandlerParams, nestedMessage, visible, undefined, entryPath)
        : entry
    params[key] = Array.isArray(value)
      ? value.map((entry, index) => normalize(entry, `${label}[${index}]`))
      : normalize(value, label)
  }
  return params
}

function handlerIntegerInput(method: string, params: HandlerParams): HandlerParams {
  const fields = HANDLER_SELF_INTEGER_FIELDS[method]
  if (fields === undefined) return params
  for (const field of fields) {
    if (params[field] === undefined) continue
    params[field] = parseInteger(params[field], field, { min: INT64_MIN, max: INT64_MAX })
  }
  return params
}

/** Normalize only a resolved definition, so every registered alias inherits its input rules. */
export function requestInput(
  { name: method }: RegisteredMethod,
  input: ProviderParams | undefined,
): HandlerParams {
  input = structuredClone(input)
  if (method === 'admin/temporary-accounts-generation') {
    return temporaryAccountsOptions(input === undefined ? {} : input)
  }
  if (Array.isArray(input)) {
    const params = input
    switch (method) {
      case 'tre_setAccountBalance':
        params[1] = parseBalance(params[1], 'balance')
        break
      case 'tre_setAccountCode':
        params[1] = bytesToHex(parseBytes(params[1], 'code'))
        break
      case 'tre_setAccountStorageAt':
        params[1] = bytesToHex(storageWord(params[1], 'slot'))
        params[2] = bytesToHex(storageWord(params[2], 'value'))
        break
      case 'debug_traceTransaction':
        params[0] = transactionHash(params[0])
        break
      case 'debug_storageRangeAt':
        params[0] = blockReference(params[0])
        params[1] = Number(parseInteger(params[1], 'txIndex', { max: 0n }))
        params[4] = Number(
          parseInteger(params[4], 'limit', { min: 1n, max: BigInt(Number.MAX_SAFE_INTEGER) }),
        )
        break
    }
    return params as unknown as HandlerParams
  }
  const params = handlerIntegerInput(method, (input ?? {}) as HandlerParams)
  const message = MERGED_MESSAGE[method]
  const formats = SELF_FORMAT_FIELDS[message] ?? HANDLER_SELF_FORMAT_FIELDS[method]
  return messageInput(params, message, isVisible(params), formats)
}
