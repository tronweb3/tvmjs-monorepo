import { bytesToHex, createZeroAddress, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'

import {
  isVisible,
  mergeAddressField,
  parseRequestAddress,
  toTronHex,
  tryParseTronAddress,
} from '../address.ts'
import { withVisibleAddresses } from '../visible.ts'
import { deployContract, mergeFieldError, triggerSmartContract } from './builders.ts'
import { addressValueField } from './chain.ts'
import { callArgumentError } from './contractAdapter.ts'
import { currentCycleNumber } from './nodeinfo.ts'
import { abiEntries, printTransaction } from './print.ts'
import { buildInternalTransactions, runtimeErrorText } from './receipt.ts'
import { triggerError } from './types.ts'

import type { Address } from '@tvmjs/util'
import type {
  CallParams,
  CallResult,
  ContractMeta,
  InternalCall,
  NodeCore,
} from '../../../core/node.ts'
import type { HandlerParams, Registry } from '../../registry.ts'

function strip0x(hex: string): string {
  return hex.replace(/^0x/i, '')
}

/**
 * calldata = data | keccak(function_selector)[0..4] ++ parameter
 * (the trigger request fields of the TRON HTTP API)
 */
function buildCallData(params: HandlerParams): Uint8Array {
  // a named function wins over raw data: it is the higher-level statement of
  // what to call, and the servlets overwrite data with it
  const selector =
    typeof params.function_selector === 'string' && params.function_selector !== ''
      ? TronWeb.sha3(params.function_selector, false).slice(0, 8)
      : ''
  if (selector !== '') {
    const parameter = typeof params.parameter === 'string' ? strip0x(params.parameter) : ''
    return hexToBytes(`0x${selector}${parameter}`)
  }
  return typeof params.data === 'string'
    ? hexToBytes(`0x${strip0x(params.data)}`)
    : new Uint8Array()
}

/**
 * Build the transaction before simulation so execution and the response use
 * the same transaction ID. Only the trigger servlet reads `fee_limit`
 * from the request — the constant one never does, so the echo carries none.
 */
async function wouldBeTransaction(
  node: NodeCore,
  params: HandlerParams,
  deploying: boolean,
  carriesFeeLimit: boolean,
): Promise<Record<string, unknown>> {
  // a simulated deployment carries the CreateSmartContract it would have sent,
  // built from the init code with the fixed resource terms the simulation assumes
  if (deploying) {
    const built = deployContract(node, {
      owner_address: params.owner_address,
      visible: params.visible,
      bytecode: params.data,
      consume_user_resource_percent: 100,
      origin_energy_limit: 1,
      call_value: params.call_value,
      token_id: params.token_id,
      call_token_value: params.call_token_value,
    } as HandlerParams) as Record<string, unknown>
    return built
  }
  const built = (await triggerSmartContract(
    node,
    carriesFeeLimit ? params : { ...params, fee_limit: undefined },
    { includeExtraData: !carriesFeeLimit },
  )) as {
    transaction?: Record<string, unknown>
  }
  return built.transaction ?? built
}

interface ConstantCallOutcome {
  transaction?: Record<string, unknown>
  error?: Record<string, unknown>
  energyUsed?: bigint
  returnValue?: Uint8Array
  logs?: [Uint8Array, Uint8Array[], Uint8Array][]
  internalTxs?: InternalCall[]
  /** set when the frame ended in REVERT or a VM exception */
  failure?: string
  /** true only for a REVERT, which alone keeps the success response shape */
  reverted?: boolean
  callParams?: CallParams
}

/**
 * The runtime error text a failed constant call carries: REVERT
 * has its own fixed wording, every other exception reports itself.
 */
function isRevert(result: CallResult): boolean {
  return result.reverted && String(result.execResult.exceptionError?.error ?? '').includes('revert')
}

function constantFailure(result: CallResult): string | undefined {
  if (!result.reverted) return undefined
  return isRevert(result) ? 'REVERT opcode executed' : runtimeErrorText(result)
}

/**
 * The parameter checks the constant-call servlets run before anything is
 * parsed. An empty `contract_address` is how a deployment is simulated, so it
 * is only rejected when there is no init code to run either.
 */
function constantParameterError(params: HandlerParams): string | undefined {
  // presence is read as text, so a field of any JSON type counts as set
  const isSet = (value: unknown): boolean =>
    value !== undefined && value !== null && String(value) !== ''
  if (!isSet(params.owner_address)) return "owner_address isn't set."
  if (!isSet(params.contract_address) && !isSet(params.data)) {
    return 'At least one of contract_address and data must be set.'
  }
  if (!isSet(params.contract_address) && isSet(params.function_selector) && isSet(params.data)) {
    return 'While trying to deploy, function_selector and data can not be both set.'
  }
  return undefined
}

async function runConstant(
  node: NodeCore,
  params: HandlerParams,
  {
    energyLimit,
    carriesFeeLimit = false,
  }: { energyLimit?: bigint; carriesFeeLimit?: boolean } = {},
): Promise<ConstantCallOutcome> {
  const visible = isVisible(params)
  const invalidParameter = constantParameterError(params)
  if (invalidParameter !== undefined) {
    return {
      error: triggerError(invalidParameter, 'OTHER_ERROR', isVisible(params)),
    }
  }
  // the body is merged once the parameter check has passed, so a field of the
  // wrong type is reported after it rather than before
  const merge = mergeFieldError('TriggerSmartContract', params)
  if (merge !== undefined) {
    return {
      error: triggerError(
        String(merge.Error ?? '').replace(/"/g, "'"),
        'OTHER_ERROR',
        isVisible(params),
      ),
    }
  }
  const deploying = String(params.contract_address ?? '') === ''
  let to: Address | undefined
  if (!deploying) {
    // the address is merged as bytes first; whatever survives that is looked up,
    // and anything the store does not answer for is simply not a contract
    try {
      mergeAddressField(
        params,
        'contract_address',
        'protocol.TriggerSmartContract.contract_address',
      )
    } catch (err) {
      return { error: triggerError((err as Error).message, 'OTHER_ERROR', visible) }
    }
    to = tryParseTronAddress(String(params.contract_address ?? ''))
    if (to === undefined || node.getContractMeta(to) === undefined) {
      return { error: triggerError('Smart contract is not exist.', undefined, visible) }
    }
  }
  let caller: Address
  try {
    caller =
      typeof params.owner_address === 'string' && params.owner_address !== ''
        ? parseRequestAddress(params.owner_address, visible)
        : createZeroAddress()
  } catch (err) {
    return { error: triggerError((err as Error).message, 'OTHER_ERROR') }
  }

  // a constant call goes through the same actuator validation a broadcast does;
  // only the execution is read-only
  const invalid = deploying ? undefined : await callArgumentError(node, caller, params)
  if (invalid !== undefined) {
    return { error: triggerError(invalid, undefined, visible) }
  }

  const transaction = await wouldBeTransaction(node, params, deploying, carriesFeeLimit)
  if (typeof transaction.txID !== 'string') return { error: transaction }
  if (carriesFeeLimit) {
    const raw = transaction.raw_data as { fee_limit?: number | bigint | string }
    const feeLimit = BigInt(raw.fee_limit ?? 0)
    if (feeLimit > 0n) {
      const cap = energyLimit ?? node.runtime.maxEnergyLimitForConstant
      const budget = feeLimit / BigInt(node.config.chainParameters.energyFee)
      energyLimit = budget < cap ? budget : cap
    }
  }
  const callParams: CallParams = {
    caller,
    rootTransactionId: hexToBytes(`0x${transaction.txID}`),
    ...(to === undefined ? {} : { to }),
    data: deploying ? hexToBytes(`0x${strip0x(String(params.data ?? ''))}`) : buildCallData(params),
    value: BigInt((params.call_value as string | number) ?? 0),
    tokenId: params.token_id !== undefined ? BigInt(params.token_id as string | number) : undefined,
    tokenValue:
      params.call_token_value !== undefined
        ? BigInt(params.call_token_value as string | number)
        : undefined,
  }
  const result = await node.call({
    ...callParams,
    ...(energyLimit === undefined ? {} : { energyLimit }),
  })
  return {
    transaction,
    energyUsed: result.energyUsed,
    returnValue: result.returnValue,
    logs: result.execResult.logs ?? [],
    internalTxs: result.internalTxs,
    failure: constantFailure(result),
    reverted: isRevert(result),
    callParams,
  }
}

/** binary-search termination gap, one TRX */
const TRX_PRECISION = 1_000_000n

/**
 * Lowest fee limit at which the call still succeeds: probe the ceiling,
 * double the observed cost, then bisect. Reporting the
 * energy a single unconstrained run happened to burn would understate calls
 * that reserve energy for sub-frames.
 */
async function searchRequiredFee(
  node: NodeCore,
  callParams: CallParams,
  energyUsed: bigint,
): Promise<bigint> {
  const energyFee = BigInt(node.config.chainParameters.energyFee)
  const succeeds = async (feeSun: bigint): Promise<boolean> => {
    const attempt = await node.call({ ...callParams, energyLimit: feeSun / energyFee })
    return constantFailure(attempt) === undefined
  }

  // the search starts from the chain's own fee-limit ceiling
  let high = BigInt(node.config.chainParameters.maxFeeLimit)
  let low = energyFee * energyUsed
  const twice = low * 2n
  if (twice < high) {
    if (await succeeds(twice)) {
      high = twice
    } else {
      low = twice
    }
  }
  while (low + TRX_PRECISION < high) {
    const mid = (low + high) / 2n
    if (await succeeds(mid)) {
      high = mid
    } else {
      low = mid
    }
  }
  return high
}

/**
 * Whether the stored ABI marks the called function read-only. The selector is
 * derived from the entry the same way callers derive theirs, so an ABI that
 * does not describe the call leaves it a state-changing one.
 */
function isConstantCall(meta: ContractMeta | undefined, data: Uint8Array): boolean {
  if (meta === undefined || data.length < 4) return false
  const selector = bytesToHex(data.slice(0, 4)).slice(2)
  for (const raw of meta.abi ?? []) {
    const entry = raw as Record<string, unknown>
    if (String(entry.type ?? '').toLowerCase() !== 'function') continue
    const inputs = Array.isArray(entry.inputs) ? entry.inputs : []
    const types = inputs.map((input) => String((input as { type?: unknown }).type ?? '')).join(',')
    if (TronWeb.sha3(`${String(entry.name ?? '')}(${types})`, false).slice(0, 8) !== selector) {
      continue
    }
    const mutability = String(entry.stateMutability ?? '').toLowerCase()
    return entry.constant === true || mutability === 'view' || mutability === 'pure'
  }
  return false
}

export function registerContractHandlers(registry: Registry): void {
  // a call the ABI marks read-only is served here rather than handed back as a
  // transaction to sign
  registry.register(
    'wallet/triggersmartcontract',
    async (node, params) => {
      const built = (await triggerSmartContract(node, params)) as Record<string, unknown>
      if (built.transaction === undefined) return built
      const to = parseRequestAddress(String(params.contract_address ?? ''), isVisible(params))
      return isConstantCall(node.getContractMeta(to), buildCallData(params))
        ? constantResponse(node, params, true)
        : built
    },
    { verbatim: true },
  )

  registry.register('wallet/triggerconstantcontract', constantResponse, { solidity: true })

  async function constantResponse(
    node: NodeCore,
    params: HandlerParams,
    carriesFeeLimit = false,
  ): Promise<Record<string, unknown>> {
    {
      const outcome = await runConstant(node, params, { carriesFeeLimit })
      if (outcome.error !== undefined) return outcome.error
      // on REVERT the raw revert data goes into constant_result
      // a failed frame still reports result.result = true: the call itself was
      // served. The failure shows up as the runtime message plus a FAILED ret
      // on the embedded transaction.
      // only a genuine REVERT keeps the success shape; any other runtime
      // exception is reported as a failed request, with no result to carry
      if (outcome.failure !== undefined && !outcome.reverted) {
        return triggerError(outcome.failure, 'OTHER_ERROR', isVisible(params))
      }
      // the would-be transaction carries an empty result, the one the runtime
      // attached while working out what the call would do
      const transaction = printTransaction({
        ...outcome.transaction,
        ret: outcome.failure === undefined ? [{}] : [{ ret: 'FAILED' }],
      })
      // proto field order: transaction, constant_result, result, energy_used,
      // logs, internal_transactions
      const failure =
        outcome.failure === undefined
          ? undefined
          : isVisible(params)
            ? outcome.failure
            : TronWeb.fromUtf8(outcome.failure).replace(/^0x/, '')
      const response: Record<string, unknown> = {
        // the response embeds the full would-be transaction (ref block,
        // timestamps, txID); the builder produces exactly that
        transaction,
        constant_result: [bytesToHex(outcome.returnValue as Uint8Array).slice(2)],
        result: failure === undefined ? { result: true } : { result: true, message: failure },
        energy_used: Number(outcome.energyUsed),
      }
      const logs = outcome.logs ?? []
      if (logs.length > 0) {
        // log addresses are plain 20-byte hex, which the visible walk turns
        // into base58 the same way it does the 41-prefixed form
        response.logs = withVisibleAddresses(
          logs.map(([address, topics, data]) => ({
            address: bytesToHex(address).slice(2),
            topics: topics.map((topic) => bytesToHex(topic).slice(2)),
            data: bytesToHex(data).slice(2),
          })),
          isVisible(params),
        )
      }
      // Constant calls have no root ID; failed child frames still reject their descendants.
      const internals = buildInternalTransactions('', {
        internalTxs: outcome.internalTxs ?? [],
        reverted: false,
      })
      if (internals !== undefined) {
        response.internal_transactions = withVisibleAddresses(internals, isVisible(params))
      }
      return response
    }
  }

  registry.register(
    'wallet/estimateenergy',
    async (node, params) => {
      const energyFee = BigInt(node.config.chainParameters.energyFee)
      // Estimate from the chain fee ceiling, not the lower read-call cap: a
      // call that exceeds the latter may still have a valid purchasable
      // estimate. The subsequent probes only narrow this successful bound.
      const maximumFee = BigInt(node.config.chainParameters.maxFeeLimit)
      const outcome = await runConstant(node, params, { energyLimit: maximumFee / energyFee })
      if (outcome.error !== undefined) return outcome.error
      if (outcome.failure !== undefined) {
        // a call that cannot succeed has no estimate to give
        return {
          result: {
            code: 'CONTRACT_EXE_ERROR',
            message: TronWeb.fromUtf8(outcome.failure).replace(/^0x/, ''),
          },
        }
      }
      const feeSun = await searchRequiredFee(
        node,
        outcome.callParams as CallParams,
        outcome.energyUsed as bigint,
      )
      return {
        result: { result: true },
        energy_required: Number((feeSun + energyFee - 1n) / energyFee),
      }
    },
    { solidity: true },
  )

  /** the on-chain SmartContract message, shared by both contract queries */
  async function smartContractJSON(
    node: NodeCore,
    address: Address,
  ): Promise<Record<string, unknown> | undefined> {
    const meta = node.getContractMeta(address)
    if (meta === undefined) return undefined
    const code = await node.getCode(address)
    // proto field order, defaults dropped — except the abi, a message field the
    // record always sets, so a contract with none still prints an empty one
    return {
      ...(meta.originAddress !== undefined ? { origin_address: meta.originAddress } : {}),
      contract_address: toTronHex(address),
      ...(meta.abi !== undefined
        ? { abi: meta.abi.length > 0 ? { entrys: abiEntries(meta.abi) } : {} }
        : {}),
      ...(meta.bytecode !== '' ? { bytecode: meta.bytecode } : {}),
      ...(meta.consumeUserResourcePercent !== 0
        ? { consume_user_resource_percent: meta.consumeUserResourcePercent }
        : {}),
      ...(meta.name !== '' ? { name: meta.name } : {}),
      ...(meta.originEnergyLimit !== 0 ? { origin_energy_limit: meta.originEnergyLimit } : {}),
      ...(code.length > 0 || meta.codeHashed === true
        ? { code_hash: utils.ethersUtils.keccak256(code).slice(2) }
        : {}),
      ...(meta.trxHash !== undefined ? { trx_hash: meta.trxHash } : {}),
      ...(meta.version !== undefined && meta.version !== 0 ? { version: meta.version } : {}),
    }
  }

  registry.register(
    'wallet/getcontract',
    async (node, params) => {
      // the value is merged as bytes before the store is consulted, so text the
      // merge cannot read fails there; well-formed bytes of the wrong length
      // simply find nothing
      addressValueField(params, 'value')
      const address = tryParseTronAddress(String(params.value ?? ''))
      if (address === undefined) return {}
      const json = await smartContractJSON(node, address)
      return json === undefined ? {} : withVisibleAddresses(json, isVisible(params))
    },
    // an abi with no entries still prints, so the default-value omission is off
    { verbatim: true },
  )

  registry.register(
    'wallet/getcontractinfo',
    async (node, params) => {
      // the value is merged as bytes before the store is consulted, so text the
      // merge cannot read fails there; well-formed bytes of the wrong length
      // simply find nothing
      addressValueField(params, 'value')
      const address = tryParseTronAddress(String(params.value ?? ''))
      if (address === undefined) return {}
      // the contract record is what decides, not its code: a contract whose
      // runtime code is empty still has a record and still answers
      if (node.getContractMeta(address) === undefined) return {}
      const code = await node.getCode(address)
      const json = await smartContractJSON(node, address)
      const cycle = currentCycleNumber(node)
      return withVisibleAddresses(
        {
          smart_contract: json ?? { contract_address: toTronHex(address) },
          ...(code.length > 0 ? { runtimecode: bytesToHex(code).slice(2) } : {}),
          // the wrapper always sets this one, so it prints even with nothing
          // in it. With dynamic energy off the store never holds a record, so
          // the reply is a fresh state at the current cycle — no usage, no
          // factor, just the cycle it would start counting from
          contract_state: {
            ...(cycle > 0 ? { update_cycle: cycle } : {}),
          },
        },
        isVisible(params),
      )
    },
    // a record whose every field sits at its default still prints, omission off
    { verbatim: true },
  )
}
