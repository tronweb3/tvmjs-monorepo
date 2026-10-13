import { bytesToHex, hexToBytes } from '@tvmjs/util'
import { TronWeb, utils } from 'tronweb'
import { INT64_MAX } from '../../intBounds.ts'

import { parseTronAddress, toBase58, toTronHex } from './address.ts'
import { CONTRACT_TYPE } from './contractTypes.ts'

import type { Address } from '@tvmjs/util'
import type { ChainParameters } from '../../config.ts'
import type { NodeCore } from '../../core/node.ts'
import type { SignedTronTx, TronContractJSON } from './wallet/types.ts'

/**
 * The operations bitmap a fresh account's active permission carries: every
 * contract type an ordinary account may sign for.
 */
export const DEFAULT_ACTIVE_OPERATIONS =
  '7fff1fc0033ec30f000000000000000000000000000000000000000000000000'

/** `Permission.PermissionType` as declared in `core/Tron.proto` */
export const PERMISSION_TYPE = { Owner: 0, Witness: 1, Active: 2 } as const

export interface PermissionKey {
  /** 41-prefixed hex */
  address: string
  weight: bigint
}

export interface Permission {
  type: 'Owner' | 'Witness' | 'Active'
  id: number
  permission_name: string
  threshold: bigint
  parent_id?: number
  /** 64 hex characters; Active permissions only */
  operations?: string
  keys: PermissionKey[]
}

/**
 * Accounts store their permission set in the account record. The wire states
 * owner, witness and active in three separate fields; the account model here
 * has one list, so the three are told apart by `type` and `id` — the same two
 * values the protobuf carries on every permission anyway.
 */
function storedPermissions(stored: StoredPermission[] | undefined): Permission[] {
  if (stored === undefined || stored.length === 0) return []
  return stored.map((entry) => ({
    type: entry.type === 0 ? 'Owner' : entry.type === 1 ? 'Witness' : 'Active',
    id: entry.id,
    permission_name: entry.permissionName,
    threshold: entry.threshold,
    ...(entry.parentId !== 0 ? { parent_id: entry.parentId } : {}),
    ...(entry.type === 2 ? { operations: bytesToHex(entry.operations).slice(2) } : {}),
    keys: entry.keys.map((key) => ({
      address: `41${bytesToHex(key.address).slice(2)}`,
      weight: key.weight,
    })),
  }))
}

/** the account-record shape the state manager round-trips */
interface StoredPermission {
  type: number
  id: number
  permissionName: string
  threshold: bigint
  parentId: number
  operations: Uint8Array
  keys: { address: Uint8Array; weight: bigint }[]
}

/** the permission set an account carries before it has ever been reshaped */
function defaultPermissions(owner: Address): Permission[] {
  const address = toTronHex(owner)
  return [
    {
      type: 'Owner',
      id: 0,
      permission_name: 'owner',
      threshold: 1n,
      keys: [{ address, weight: 1n }],
    },
    {
      type: 'Active',
      id: 2,
      permission_name: 'active',
      threshold: 1n,
      operations: DEFAULT_ACTIVE_OPERATIONS,
      keys: [{ address, weight: 1n }],
    },
  ]
}

/** only what is stored, with no default synthesis */
export function storedPermissionsOnly(node: NodeCore, owner: Address): Permission[] {
  return storedPermissions(node.storedPermissionsOf(owner) as StoredPermission[] | undefined)
}

/** every permission this account holds, defaults included */
export async function permissionsOf(node: NodeCore, owner: Address): Promise<Permission[]> {
  // an account that does not exist has no permissions to report either way
  if ((await node.getAccount(owner)) === undefined) return defaultPermissions(owner)
  const stored = storedPermissions(
    node.storedPermissionsOf(owner) as StoredPermission[] | undefined,
  )
  return stored.length > 0 ? stored : defaultPermissions(owner)
}

/** the permission a given id names, or undefined when the account has no such id */
export async function permissionById(
  node: NodeCore,
  owner: Address,
  id: number,
): Promise<Permission | undefined> {
  return (await permissionsOf(node, owner)).find((permission) => permission.id === id)
}

/** the account record shape, built from the wire form */
export function toStoredPermissions(permissions: Permission[]): StoredPermission[] {
  return permissions.map((permission) => ({
    type: PERMISSION_TYPE[permission.type],
    id: permission.id,
    permissionName: permission.permission_name,
    threshold: permission.threshold,
    parentId: permission.parent_id ?? 0,
    operations: hexToBytes(`0x${permission.operations ?? ''}`),
    keys: permission.keys.map((key) => ({
      address: parseTronAddress(key.address).bytes,
      weight: key.weight,
    })),
  }))
}

/** r || s || v, the only signature length the recovery accepts */
const SIGNATURE_BYTES = 65

/** the weight a key carries in a permission, 0 when it is not a member */
function weightOf(permission: Permission, signerBase58: string): bigint {
  for (const key of permission.keys) {
    if (toBase58Loose(key.address) === signerBase58) return key.weight
  }
  return 0n
}

function toBase58Loose(address: string): string {
  return address.startsWith('T') ? address : toBase58(parseTronAddress(address))
}

/**
 * Whether the permission's operations bitmap grants this contract type. The
 * type's enum value is its bit position, little-endian within each byte.
 */
function grantsContract(permission: Permission, contractType: string): boolean | string {
  const operations = permission.operations ?? ''
  if (operations.length !== 64) {
    return `operations size must 32, actual: ${Math.floor(operations.length / 2)}`
  }
  const typeValue = CONTRACT_TYPE[contractType]
  if (typeValue === undefined) return false
  const byte = Number.parseInt(operations.slice((typeValue >> 3) * 2, (typeValue >> 3) * 2 + 2), 16)
  return (byte & (1 << (typeValue % 8))) !== 0
}

/**
 * Which exception the failure corresponds to. `setup` covers the ones raised
 * while resolving the permission, before it is attached to the reply; the rest
 * come from weighing the signatures against it.
 */
export type WeightErrorKind = 'setup' | 'permission' | 'signature-format' | 'compute-address'

export interface WeightOutcome {
  /** the wire message of the first failure, absent when the signatures check out */
  error?: string
  errorKind?: WeightErrorKind
  currentWeight: bigint
  permission?: Permission
  approvedList: string[]
}

/**
 * Resolve the permission a transaction declares, check that it may carry this
 * contract type, and sum the weights of the keys that signed it. Shared by the
 * broadcast path and by getsignweight / getapprovedlist, which report exactly
 * what the broadcast path would compute.
 */
export async function checkSignatureWeight(
  node: NodeCore,
  owner: Address,
  contract: TronContractJSON,
  tx: SignedTronTx,
  txId: string,
): Promise<WeightOutcome> {
  const permissionId = contract.Permission_id ?? 0
  const permission = await permissionById(node, owner, permissionId)
  const approvedList: string[] = []
  if (permission === undefined) {
    return { error: "permission isn't exit", errorKind: 'setup', currentWeight: 0n, approvedList }
  }
  if (permissionId !== 0) {
    if (permission.type !== 'Active') {
      return {
        error: 'Permission type is error',
        errorKind: 'setup',
        currentWeight: 0n,
        permission,
        approvedList,
      }
    }
    const granted = grantsContract(permission, contract.type)
    if (typeof granted === 'string') {
      return { error: granted, errorKind: 'setup', currentWeight: 0n, permission, approvedList }
    }
    if (!granted) {
      return {
        error: 'Permission denied',
        errorKind: 'setup',
        currentWeight: 0n,
        permission,
        approvedList,
      }
    }
  }

  const signatures = tx.signature ?? []
  if (signatures.length > permission.keys.length) {
    return {
      error: `Signature count is ${signatures.length} more than key counts of permission : ${permission.keys.length}`,
      errorKind: 'permission',
      currentWeight: 0n,
      permission,
      approvedList,
    }
  }

  let currentWeight = 0n
  const seen = new Set<string>()
  for (const raw of signatures) {
    const hex = String(raw).replace(/^0x/i, '')
    const byteLength = Math.floor(hex.length / 2)
    if (byteLength < SIGNATURE_BYTES) {
      return {
        error: `Signature size is ${byteLength}`,
        errorKind: 'signature-format',
        currentWeight,
        permission,
        approvedList,
      }
    }
    // anything past the 65th byte is dropped rather than rejected
    const signature = hex.slice(0, SIGNATURE_BYTES * 2)
    // past 34 the byte is an Ethereum chain-id encoding, which this chain
    // does not use — reading it as one accepts signatures the chain refuses
    const stated = Number.parseInt(signature.slice(128, 130), 16)
    const header = stated < 27 ? stated + 27 : stated
    if (header < 27 || header > 34) {
      return {
        error: `Header byte out of range: ${header}`,
        errorKind: 'compute-address',
        currentWeight,
        permission,
        approvedList,
      }
    }
    // 31..34 name the compressed form of the same four ids
    if ((header >= 31 ? header - 4 : header) - 27 > 1) {
      return {
        error: 'Could not recover public key from signature',
        errorKind: 'compute-address',
        currentWeight,
        permission,
        approvedList,
      }
    }
    let signer: string
    try {
      // recover against the id the node derived, not the one the client sent
      signer = TronWeb.address.fromHex(utils.crypto.ecRecover(txId, signature))
    } catch (err) {
      return {
        error: (err as Error).message,
        errorKind: 'compute-address',
        currentWeight,
        permission,
        approvedList,
      }
    }
    const weight = weightOf(permission, signer)
    if (weight === 0n) {
      return {
        error: `${txId} is signed by ${signer} but it is not contained of permission.`,
        errorKind: 'permission',
        currentWeight,
        permission,
        approvedList,
      }
    }
    if (seen.has(signer)) {
      return {
        error: `${signer} has signed twice!`,
        errorKind: 'permission',
        currentWeight,
        permission,
        approvedList,
      }
    }
    seen.add(signer)
    approvedList.push(signer)
    currentWeight += weight
  }
  return { currentWeight, permission, approvedList }
}

/**
 * The rules one permission must satisfy, in the order the actuator applies
 * them. Returns the wire message of the first failure.
 */
export function permissionError(
  permission: Permission,
  totalSignNum: number,
  availableContractTypes = AVAILABLE_CONTRACT_TYPES,
): string | undefined {
  if (permission.keys.length > totalSignNum) {
    return `number of keys in permission should not be greater than ${totalSignNum}`
  }
  if (permission.keys.length === 0) return "key's count should be greater than 0"
  if (permission.type === 'Witness' && permission.keys.length !== 1) {
    return "Witness permission's key count should be 1"
  }
  if (permission.threshold <= 0) return "permission's threshold should be greater than 0"
  if (permission.permission_name !== '' && permission.permission_name.length > 32) {
    return "permission's name is too long"
  }
  if ((permission.parent_id ?? 0) !== 0) return "permission's parent should be owner"

  const seen = new Set(permission.keys.map((key) => key.address.toLowerCase()))
  if (seen.size !== permission.keys.length) {
    return `address should be distinct in permission ${permission.type}`
  }
  let weightSum = 0n
  for (const key of permission.keys) {
    try {
      parseTronAddress(key.address)
    } catch {
      return 'key is not a validate address'
    }
    if (key.weight <= 0n) return "key's weight should be greater than 0"
    weightSum += key.weight
    // the sum is added as signed 64-bit integers, which cannot hold more
    if (weightSum > INT64_MAX) return 'long overflow'
  }
  if (weightSum < permission.threshold) {
    return `sum of all key's weight should not be less than threshold in permission ${permission.type}`
  }

  const operations = permission.operations ?? ''
  if (permission.type !== 'Active') {
    return operations === '' ? undefined : `${permission.type} permission needn't operations`
  }
  if (operations.length !== 64) return 'operations size must 32'
  // a bit may only name a contract type the chain's bitmap holds
  for (let bit = 0; bit < 256; bit += 1) {
    const byte = Number.parseInt(operations.slice((bit >> 3) * 2, (bit >> 3) * 2 + 2), 16)
    if ((byte & (1 << (bit % 8))) !== 0 && !availableContractTypes.has(bit)) {
      return `${bit} isn't a validate ContractType`
    }
  }
  return undefined
}

/**
 * The contract types a permission may name. This is not every type the
 * protocol declares — the chain keeps its own bitmap, born with the types
 * below and widened by the proposals that turned each later feature on. A bit
 * outside it is refused however well-formed the mask is.
 *
 * `ShieldedTransferContract` (51) is absent from every chain: no proposal
 * ever added it. `MarketSellAssetContract` (52)
 * and `MarketCancelOrderContract` (53) wait on `getAllowMarketTransaction`,
 * which is 0 on mainnet.
 */
const BASE_CONTRACT_TYPES = '7fff1fc0037e0000000000000000000000000000000000000000000000000000'

function baseContractTypes(): Set<number> {
  const bits = new Set<number>()
  for (let bit = 0; bit < 256; bit += 1) {
    const byte = Number.parseInt(BASE_CONTRACT_TYPES.slice((bit >> 3) * 2, (bit >> 3) * 2 + 2), 16)
    if ((byte & (1 << (bit % 8))) !== 0) bits.add(bit)
  }
  return bits
}

const AVAILABLE_CONTRACT_TYPES: ReadonlySet<number> = new Set([
  ...baseContractTypes(),
  CONTRACT_TYPE.ClearABIContract,
  CONTRACT_TYPE.UpdateBrokerageContract,
  CONTRACT_TYPE.FreezeBalanceV2Contract,
  CONTRACT_TYPE.UnfreezeBalanceV2Contract,
  CONTRACT_TYPE.WithdrawExpireUnfreezeContract,
  CONTRACT_TYPE.DelegateResourceContract,
  CONTRACT_TYPE.UnDelegateResourceContract,
  CONTRACT_TYPE.CancelAllUnfreezeV2Contract,
])

/**
 * Contract-operation bits enabled by this node's feature configuration.
 * The built-in producer has change-delegation enabled from genesis; the other
 * additions follow the corresponding proposal state.
 */
export function availableContractTypes(
  params: Pick<ChainParameters, 'unfreezeDelayDays' | 'allowCancelAllUnfreezeV2'>,
): ReadonlySet<number> {
  const enabled = new Set(baseContractTypes())
  enabled.add(CONTRACT_TYPE.UpdateBrokerageContract)
  enabled.add(CONTRACT_TYPE.ClearABIContract)
  if (params.unfreezeDelayDays > 0) {
    enabled.add(CONTRACT_TYPE.FreezeBalanceV2Contract)
    enabled.add(CONTRACT_TYPE.UnfreezeBalanceV2Contract)
    enabled.add(CONTRACT_TYPE.WithdrawExpireUnfreezeContract)
    enabled.add(CONTRACT_TYPE.DelegateResourceContract)
    enabled.add(CONTRACT_TYPE.UnDelegateResourceContract)
  }
  if (params.allowCancelAllUnfreezeV2 === 1) {
    enabled.add(CONTRACT_TYPE.CancelAllUnfreezeV2Contract)
  }
  return enabled
}

/**
 * Normalise a permission's `type` as the protobuf merge would: the enum accepts
 * its name or its number, and an omitted field is the zero value — which for
 * `PermissionType` is `Owner`.
 */
export function permissionTypeOf(value: unknown): 'Owner' | 'Witness' | 'Active' | undefined {
  if (value === undefined || value === null || value === 0 || value === '0') return 'Owner'
  if (value === 1 || value === '1' || value === 'Witness') return 'Witness'
  if (value === 2 || value === '2' || value === 'Active') return 'Active'
  if (value === 'Owner') return 'Owner'
  return undefined
}
