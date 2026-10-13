import type { StateManagerInterface } from '@tvmjs/common'
import {
  Account,
  bigIntToBytes,
  bytesToBigInt,
  bytesToHex,
  createAddressFromString,
  hexToBytes,
  setLengthLeft,
} from '@tvmjs/util'
import type { PrefixedHexString } from '@tvmjs/util'
import rawInputs from './testdata/javaTronExecutionInputs.json' with { type: 'json' }

export interface ReferenceAccount {
  address: PrefixedHexString
  balance: string
  tokens: Record<string, string>
  storage: Record<string, string>
  code?: PrefixedHexString
}

export interface ReferenceCase {
  name: string
  code: PrefixedHexString
  energyLimit: string
  accounts: ReferenceAccount[]
}

export const referenceInputs = rawInputs as Omit<typeof rawInputs, 'cases' | 'context'> & {
  cases: ReferenceCase[]
  context: Omit<
    typeof rawInputs.context,
    'contract' | 'caller' | 'rootTransactionId' | 'observe'
  > & {
    contract: PrefixedHexString
    caller: PrefixedHexString
    rootTransactionId: PrefixedHexString
    observe: PrefixedHexString[]
  }
}

export interface ReferenceResult {
  name: string
  energy: string
  error: string | null
  returnValue: string
  stack: string[]
  logs: { address: string; topics: string[]; data: string }[]
  accounts: Record<string, unknown>
}

const word = (value: string) => setLengthLeft(bigIntToBytes(BigInt(value)), 32)

// Both source-level TVM tests and VM consumers of the built package use this helper.
// Describe only observed output, without coupling it to a particular Stack class instance.
interface ObservedExecution {
  executionGasUsed: bigint
  exceptionError?: { error: string }
  returnValue: Uint8Array
  createdAddresses?: Set<string>
  logs?: [Uint8Array, Uint8Array[], Uint8Array][]
  runState?: { stack: { getStack(): bigint[] } }
}

export async function initializeReferenceState(
  state: StateManagerInterface,
  vector: ReferenceCase,
) {
  for (const input of vector.accounts) {
    const address = createAddressFromString(input.address)
    const account = new Account(0n, BigInt(input.balance))
    account.asset = Object.fromEntries(
      Object.entries(input.tokens).map(([id, balance]) => [id, BigInt(balance)]),
    )
    await state.putAccount(address, account)
    const code = input.address === referenceInputs.context.contract ? vector.code : input.code
    if (code !== undefined) await state.putCode(address, hexToBytes(code))
    for (const [slot, value] of Object.entries(input.storage)) {
      if (BigInt(value) !== 0n)
        await state.putStorage(address, word(slot), bigIntToBytes(BigInt(value)))
    }
  }
}

/** Compare execution state only: account nonce and transaction-envelope fees are library metadata. */
export async function captureReferenceResult(
  state: StateManagerInterface,
  vector: ReferenceCase,
  result: ObservedExecution,
): Promise<ReferenceResult> {
  const error = result.exceptionError?.error ?? null
  const addresses = new Set<string>(referenceInputs.context.observe)
  if (error === null) for (const address of result.createdAddresses ?? []) addresses.add(address)
  const accounts: Record<string, unknown> = {}
  for (const value of addresses) {
    const address = createAddressFromString(value)
    const account = await state.getAccount(address)
    if (account === undefined) {
      accounts[value] = { exists: false }
      continue
    }
    const storage: Record<string, string> = {}
    for (const slot of referenceInputs.context.storageSlots) {
      storage[slot] = bytesToBigInt(await state.getStorage(address, word(slot))).toString()
    }
    accounts[value] = {
      exists: true,
      balance: account.balance.toString(),
      code: bytesToHex(await state.getCode(address)),
      tokens: Object.fromEntries(
        referenceInputs.context.tokenIds.map((id) => [
          id,
          account.getTokenBalance(BigInt(id)).toString(),
        ]),
      ),
      storage,
    }
  }
  return {
    name: vector.name,
    energy: result.executionGasUsed.toString(),
    error,
    returnValue: bytesToHex(result.returnValue),
    stack:
      error === null
        ? result.runState!.stack.getStack().map((value) => bytesToHex(word(value.toString())))
        : [],
    logs: (result.logs ?? []).map(([address, topics, data]) => ({
      address: bytesToHex(address),
      topics: topics.map((topic) => bytesToHex(topic)),
      data: bytesToHex(data),
    })),
    accounts,
  }
}
