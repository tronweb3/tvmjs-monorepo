import { utils } from 'tronweb'

import { boolParam, parseTronAddress, toTronHex } from '../address.ts'
import { checkSignatureWeight, permissionById } from '../permission.ts'
import { omitDefaults } from '../proto.ts'
import { withVisibleAddresses } from '../visible.ts'
import { requireRawData } from './broadcast.ts'
import { transactionId, transactionToPb } from './encode.ts'
import { packTransaction } from './pack.ts'
import { formatTransaction, printTransaction } from './print.ts'

import type { Address } from '@tvmjs/util'
import type { NodeCore } from '../../../core/node.ts'
import type { Registry } from '../../registry.ts'
import type { Permission } from '../permission.ts'
import type { SignedTronTx } from './types.ts'

const { txPbToTxID, txPbToRawDataHex } = utils.transaction

/** the reply carries no transaction echo past this point */
const TOO_MANY_SIGNATURES = 'too many signatures'

/** the wording this endpoint uses for a malformed operations bitmap */
const OPERATIONS_SIZE = 'operations size must be 32'

/**
 * The weight endpoints report what the broadcast path would compute, but with
 * their own wording: the same condition reads "permission isn't exit" when a
 * transaction is rejected and "Permission for this, does not exist!" when it is
 * merely inspected.
 */
interface Inspection {
  code: string
  message?: string
  permission?: Permission
  currentWeight: bigint
  approvedList: string[]
}

async function inspect(node: NodeCore, tx: SignedTronTx): Promise<Inspection> {
  requireRawData(tx)
  // contracts that do not merge under the request's wire form are dropped, and
  // the inspection — echo included — works on what survived
  packTransaction(tx, boolParam((tx as SignedTronTx & { visible?: unknown }).visible))
  tx.visible = false
  // the same cap the broadcast path enforces (totalSignNum)
  if ((tx.signature ?? []).length > node.config.chainParameters.totalSignNum) {
    // checked before anything else, and the reply carries no transaction echo
    return {
      code: 'OTHER_ERROR',
      message: TOO_MANY_SIGNATURES,
      currentWeight: 0n,
      approvedList: [],
    }
  }
  const contract = tx.raw_data?.contract?.[0]
  if (contract === undefined) {
    return {
      code: 'OTHER_ERROR',
      message: 'Invalid transaction: no valid contract',
      currentWeight: 0n,
      approvedList: [],
    }
  }
  let owner: Address
  try {
    owner = parseTronAddress(String(contract.parameter?.value?.owner_address ?? ''))
  } catch {
    return {
      code: 'PERMISSION_ERROR',
      message: 'Account does not exist!',
      currentWeight: 0n,
      approvedList: [],
    }
  }
  if ((await node.getAccount(owner)) === undefined) {
    return {
      code: 'PERMISSION_ERROR',
      message: 'Account does not exist!',
      currentWeight: 0n,
      approvedList: [],
    }
  }
  const permissionId = contract.Permission_id ?? 0
  const permission = await permissionById(node, owner, permissionId)
  if (permission === undefined) {
    return {
      code: 'PERMISSION_ERROR',
      message: 'Permission for this, does not exist!',
      currentWeight: 0n,
      approvedList: [],
    }
  }
  const outcome = await checkSignatureWeight(node, owner, contract, tx, transactionId(tx))
  if (outcome.error !== undefined) {
    // the inspection endpoints exclaim where the broadcast path states
    const message =
      outcome.error === 'Permission type is error'
        ? 'Permission type is wrong!'
        : outcome.error === 'Permission denied'
          ? 'Permission denied!'
          : outcome.error
    const code =
      outcome.errorKind === 'signature-format'
        ? 'SIGNATURE_FORMAT_ERROR'
        : outcome.errorKind === 'compute-address'
          ? 'COMPUTE_ADDRESS_ERROR'
          : 'PERMISSION_ERROR'
    return {
      code,
      message,
      // the permission joins the reply before the signatures are weighed, so
      // only the failures raised while resolving it leave it out
      ...(outcome.errorKind === 'setup' ? {} : { permission }),
      currentWeight: 0n,
      approvedList: [],
    }
  }

  return {
    code:
      outcome.currentWeight >= permission.threshold ? 'ENOUGH_PERMISSION' : 'NOT_ENOUGH_PERMISSION',
    permission,
    currentWeight: outcome.currentWeight,
    approvedList: outcome.approvedList,
  }
}

/** the first member of each enum is its default, and defaults are not printed */
const DEFAULT_SIGN_WEIGHT_CODE = 'ENOUGH_PERMISSION'

function weightResult(code: string, message?: string): Record<string, unknown> {
  return {
    ...(code === DEFAULT_SIGN_WEIGHT_CODE ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  }
}

/** the permission is a message, so its defaults — id 0, type Owner — drop out */
function printPermission(permission: Permission): Record<string, unknown> {
  const { type, ...rest } = permission as Permission & Record<string, unknown>
  const pruned = omitDefaults(rest) as Record<string, unknown>
  return type === 'Owner' ? pruned : { type, ...pruned }
}

/** signatures are cut to their declared length before the echo is built */
const PER_SIGN_LENGTH = 65

/**
 * The transaction echo both endpoints embed. Its id and raw bytes are derived
 * from the raw_data that arrived, not copied from the request — a client that
 * edits a field and asks again is asking exactly for that recomputation.
 */
function transactionExtention(tx: SignedTronTx, visible: boolean): Record<string, unknown> {
  // the echo is the message, not the request: `visible` belongs to the request
  const { visible: _visible, ...body } = tx as SignedTronTx & Record<string, unknown>
  if (Array.isArray(body.signature)) {
    body.signature = body.signature.map((entry) =>
      String(entry)
        .replace(/^0x/i, '')
        .slice(0, PER_SIGN_LENGTH * 2),
    )
  }
  let txid = String(tx.txID ?? '')
  let rawDataHex = String((body as { raw_data_hex?: unknown }).raw_data_hex ?? '')
  let echoed: Record<string, unknown> = printTransaction({ ...body })
  try {
    const pb = transactionToPb(tx) as never
    txid = txPbToTxID(pb).replace(/^0x/, '')
    rawDataHex = txPbToRawDataHex(pb).replace(/^0x/, '').toLowerCase()
    echoed = printTransaction({
      ...body,
      raw_data_hex: rawDataHex,
      txID: txid,
    })
  } catch {
    // an unparseable raw_data leaves the supplied id as the best answer
  }
  const printed = omitDefaults(formatTransaction(echoed, visible)) as Record<string, unknown>
  // this echo keeps its empties: the contract list, raw_data_hex and the id
  // stay on the wire even when the packed transaction holds nothing
  const rawData = (printed.raw_data ?? {}) as Record<string, unknown>
  if (!Array.isArray(rawData.contract)) rawData.contract = []
  printed.raw_data = rawData
  printed.raw_data_hex = rawDataHex
  printed.txID = txid
  return {
    transaction: printed,
    txid,
    result: { result: true },
  }
}

export function registerSignWeightHandlers(registry: Registry): void {
  // the reply is assembled here rather than printed from a message, so its
  // empty submessages stay on the wire
  registry.register(
    'wallet/getsignweight',
    async (node, params) => {
      const tx = params as unknown as SignedTronTx
      const visible = boolParam(params.visible)
      const seen = await inspect(node, tx)
      const message = seen.message?.replace(
        /^operations size must 32, actual: \d+$/,
        OPERATIONS_SIZE,
      )
      const response: Record<string, unknown> = {}
      if (seen.permission !== undefined) response.permission = printPermission(seen.permission)
      // hex on the wire; the visible walker turns it into base58 when asked
      if (seen.approvedList.length > 0) {
        response.approved_list = seen.approvedList.map((a) => toTronHex(parseTronAddress(a)))
      }
      if (seen.currentWeight > 0) response.current_weight = seen.currentWeight
      response.result = weightResult(seen.code, message)
      if (message !== TOO_MANY_SIGNATURES) response.transaction = transactionExtention(tx, visible)
      return withVisibleAddresses(response, visible)
    },
    { verbatim: true },
  )

  registry.register(
    'wallet/getapprovedlist',
    async (node, params) => {
      const tx = params as unknown as SignedTronTx
      const visible = boolParam(params.visible)
      const seen = await inspect(node, tx)
      // this endpoint has no permission branch of its own: `api.proto` gives it
      // only SUCCESS / SIGNATURE_FORMAT_ERROR / COMPUTE_ADDRESS_ERROR / OTHER_ERROR,
      // so a permission failure arrives as the wrapped exception
      const response: Record<string, unknown> = {}
      if (seen.approvedList.length > 0) {
        response.approved_list = seen.approvedList.map((a) => toTronHex(parseTronAddress(a)))
      }
      response.result =
        seen.message === undefined
          ? {}
          : seen.code === 'PERMISSION_ERROR'
            ? {
                code: 'OTHER_ERROR',
                message: seen.message,
              }
            : { code: seen.code, message: seen.message }
      if (seen.message !== TOO_MANY_SIGNATURES)
        response.transaction = transactionExtention(tx, visible)
      return withVisibleAddresses(response, visible)
    },
    { verbatim: true },
  )
}
