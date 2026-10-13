import type { Block } from '@tvmjs/block'
import { createBlock } from '@tvmjs/block'
import { createTx } from '@tvmjs/tx'
import {
  type Address,
  BIGINT_0,
  createAddressFromPrivateKey,
  hexToBytes,
  randomBytes,
} from '@tvmjs/util'
import { utils } from 'tronweb'
import { runBlock } from '../../../src/runBlock.ts'
import type { VM } from '../../../src/vm.ts'
import compiled from './solidityCode/compiled.json' with { type: 'json' }

import type { Types } from 'tronweb'
import { setBalance } from '../utils.ts'

type FunctionFragment = Types.FunctionFragment

interface ContractData {
  // contractName: string
  caller: Address
  // abi: string
  bytecode: Uint8Array
  gasLimit?: bigint
  value?: bigint
  tokenId?: bigint
  tokenValue?: bigint
}

interface TriggerConstantOption {
  caller: Address
  contractAddress: Address
  params?: any[]
  abi?: FunctionFragment
  input?: string
  block?: Block
}

interface TriggerOption extends TriggerConstantOption {
  value?: bigint
  tokenId?: bigint
  tokenValue?: bigint
}

export const PK = `0x${'0'.repeat(63)}1` as const

export async function deployContract(vm: VM, contract: ContractData, opt?: any) {
  const {
    // contractName,
    caller,
    // abi,
    bytecode,
    gasLimit,
    value,
    tokenId,
    tokenValue,
  } = contract

  const txData = {
    value: value ?? 0n,
    gasLimit: gasLimit ?? 1_000_000n,
    gasPrice: 100n,
    data: bytecode,
    nonce: await getAccountNonce(vm, caller),
    tokenId: tokenId ?? BIGINT_0,
    tokenValue: tokenValue ?? BIGINT_0,
  }

  let tx
  if (opt?.pk) {
    tx = createTx(txData, { common: vm.common }).sign(hexToBytes(opt.pk))
  } else {
    if (!opt?.skipBalance) {
      await setBalance(vm, createAddressFromPrivateKey(hexToBytes(PK)), 100_000_000_000n)
    }
    tx = createTx(txData, { common: vm.common }).sign(hexToBytes(PK))
  }

  const block = createBlock(
    {
      header: {
        gasLimit: 1_000_000_000_000n,
      },
      transactions: [tx],
    },
    { common: vm.common },
  )

  await vm.stateManager.checkpoint()
  const result = await runBlock(vm, {
    block,
    rootTransactionIds: [opt?.rootTransactionId ?? randomBytes(32)],
    generate: true,
    skipBlockValidation: true,
    skipBalance: false,
  })

  await vm.stateManager.commit()

  const deploymentResult = result.results[0]

  if (deploymentResult.execResult.exceptionError) {
    throw deploymentResult.execResult.exceptionError
  }

  if (opt?.detail) {
    return deploymentResult
  }

  return deploymentResult.createdAddress!
}

export async function trigger(vm: VM, triggerOption: TriggerOption) {
  const {
    caller,
    contractAddress,
    abi,
    params,
    block = createBlock({}, { common: vm.common }),
    value,
    tokenId,
    tokenValue,
    input,
  } = triggerOption

  const data = (() => {
    if (input) return input
    const iface = new utils.ethersUtils.Interface([abi!])
    return iface.encodeFunctionData(abi!.name, params || [])
  })()

  const txData = {
    block,
    caller,
    to: contractAddress,
    data: hexToBytes(`0x${data.replace(/^0x/, '')}`),
    gasLimit: 1_000_000n,
    gasPrice: 100n,
    nonce: await getAccountNonce(vm, caller),
    value,
    tokenId,
    tokenValue,
  }

  const tx = createTx(txData, { common: vm.common }).sign(hexToBytes(PK))

  const newBlock = createBlock(
    {
      header: {
        gasLimit: 1_000_000_000_000n,
      },
      transactions: [tx],
    },
    { common: vm.common },
  )

  await vm.stateManager.checkpoint()
  const result = await runBlock(vm, {
    block: newBlock,
    generate: true,
    skipBlockValidation: true,
    skipBalance: false,
  })
  await vm.stateManager.commit()

  return result
}

export async function triggerConstant(vm: VM, triggerOption: TriggerConstantOption) {
  const {
    caller,
    contractAddress,
    abi,
    params,
    block = createBlock({}, { common: vm.common }),
    input,
  } = triggerOption

  const data = (() => {
    if (input) return input
    const iface = new utils.ethersUtils.Interface([abi!])
    return iface.encodeFunctionData(abi!.name, params || [])
  })()

  const result = await vm.tvm.runCall({
    block,
    to: contractAddress,
    caller,
    data: hexToBytes(`0x${data.replace(/^0x/, '')}`),
    gasPrice: 100n,
  })

  if (result.execResult.exceptionError) {
    throw result.execResult.exceptionError
  }

  return utils.abi.decodeParamsV2ByABI(abi!, result.execResult.returnValue)
}

export async function getAccount(vm: VM, address: Address) {
  return vm.stateManager.getAccount(address)
}

export async function getAccountNonce(vm: VM, address: Address) {
  const account = await getAccount(vm, address)
  return account?.nonce || 0n
}

export function getCompiledContract(fileName: string, contractName: string) {
  const contract = compiled.contracts.find(
    (item) => item.fileName === fileName && item.contractName === contractName,
  )
  if (!contract) throw new Error(`Missing TRON contract fixture: ${fileName}:${contractName}`)
  return { bytecode: contract.bytecode, abi: contract.abi as FunctionFragment[] }
}

export function setLibraryAddress(
  address: string,
  bytecodeToLink: string,
  positions: Array<{ length: number; start: number }>,
) {
  if (positions) {
    for (const pos of positions) {
      const regexMatch = bytecodeToLink.match(
        new RegExp(`(.{${2 * pos.start}})(.{${2 * pos.length}})(.*)`),
      )
      if (regexMatch) {
        bytecodeToLink = regexMatch[1] + address.replace('0x', '') + regexMatch[3]
      }
    }
  }
  return bytecodeToLink
}
