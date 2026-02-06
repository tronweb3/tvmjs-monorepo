import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Block } from '@tvmjs/block'
import { createBlock } from '@tvmjs/block'
import { createTx } from '@tvmjs/tx'
import { type Address, BIGINT_0, createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'
// @ts-expect-error missing types
import wrapper from 'solc/wrapper'
import { utils } from 'tronweb'
import { runBlock } from '../../../src/runBlock.ts'
import type { VM } from '../../../src/vm.ts'

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
  abi: FunctionFragment
  block?: Block
}

interface TriggerOption extends TriggerConstantOption {}

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
    tx = createTx(txData).sign(hexToBytes(opt.pk))
  } else {
    if (!opt?.skipBalance) {
      await setBalance(vm, createAddressFromPrivateKey(hexToBytes(PK)), 100_000_000_000n)
    }
    tx = createTx(txData).sign(hexToBytes(PK))
  }

  const block = createBlock({
    header: {
      gasLimit: 1_000_000_000_000n,
    },
    transactions: [tx],
  })

  await vm.stateManager.checkpoint()
  const result = await runBlock(vm, {
    block,
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
  const { caller, contractAddress, abi, params, block = createBlock({}) } = triggerOption

  const iface = new utils.ethersUtils.Interface([abi])

  const data = iface.encodeFunctionData(abi.name, params || [])

  const txData = {
    block,
    caller,
    to: contractAddress,
    data: hexToBytes(`0x${data.replace(/^0x/, '')}`),
    gasLimit: 1_000_000_000n,
    gasPrice: 100n,
    nonce: await getAccountNonce(vm, caller),
  }

  const tx = createTx(txData).sign(hexToBytes(PK))

  const newBlock = createBlock({
    header: {
      gasLimit: 1_000_000_000_000n,
    },
    transactions: [tx],
  })

  await vm.stateManager.checkpoint()
  const result = await runBlock(vm, {
    block: newBlock,
    generate: true,
    skipBlockValidation: true,
    skipBalance: true,
  })
  await vm.stateManager.commit()

  return result
}

export async function triggerConstant(vm: VM, triggerOption: TriggerConstantOption) {
  const { caller, contractAddress, abi, params, block = createBlock({}) } = triggerOption

  const iface = new utils.ethersUtils.Interface([abi])

  const data = iface.encodeFunctionData(abi.name, params || [])

  const result = await vm.evm.runCall({
    block,
    to: contractAddress,
    caller,
    data: hexToBytes(`0x${data.replace(/^0x/, '')}`),
  })

  if (result.execResult.exceptionError) {
    throw result.execResult.exceptionError
  }

  return utils.abi.decodeParamsV2ByABI(abi, result.execResult.returnValue)
}

export async function getAccount(vm: VM, address: Address) {
  return vm.stateManager.getAccount(address)
}

export async function getAccountNonce(vm: VM, address: Address) {
  const account = await getAccount(vm, address)
  return account?.nonce || 0n
}

export async function compileSol(fileName: string, contractName: string) {
  const content = readFileSync(join(__dirname, 'solidityCode', fileName), 'utf-8')
  const solcInput = {
    language: 'Solidity',
    sources: {
      [fileName]: {
        content,
      },
      // If more contracts were to be compiled, they should have their own entries here
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode'],
        },
      },
    },
  }

  const DEFAULT_SOLIDITY_PATH = 'soljson.js'
  const DEFAULT_SOLIDITY_URL =
    'https://tronprotocol.github.io/solc-bin/wasm/soljson-v0.8.11%2Bcommit.b01f3284.js'
  const solcFilePath = join(__dirname, DEFAULT_SOLIDITY_PATH)
  if (!existsSync(solcFilePath)) {
    try {
      const safePath = solcFilePath.replace(/'/g, "'\\''")
      execSync(`curl -sSL -o '${safePath}' ${DEFAULT_SOLIDITY_URL}`)
    } catch (err) {
      throw new Error(`Failed to download solc from ${DEFAULT_SOLIDITY_URL}: ${err}`)
    }
  }
  const soljson = (await import(solcFilePath)).default
  const solc = wrapper(soljson)
  const output = JSON.parse(solc.compile(JSON.stringify(solcInput)))

  let compileError = ''
  if (output.errors) {
    for (const error of output.errors) {
      if (error.severity === 'error') {
        compileError = error.formattedMessage
      }
    }
  }

  if (compileError) {
    throw new Error(compileError)
  }

  const bytecodeInst = output.contracts[fileName][contractName].evm.bytecode
  const bytecode: string = bytecodeInst.object

  return { bytecode, abi: output.contracts[fileName][contractName].abi }
}

export function setLibraryAddress(
  address: string,
  bytecodeToLink: string,
  positions: Array<{ length: number; start: number }>,
) {
  if (positions) {
    for (const pos of positions) {
      const regpos = bytecodeToLink.match(
        new RegExp(`(.{${2 * pos.start}})(.{${2 * pos.length}})(.*)`),
      )
      if (regpos) {
        bytecodeToLink = regpos[1] + address.replace('0x', '') + regpos[3]
      }
    }
  }
  return bytecodeToLink
}
