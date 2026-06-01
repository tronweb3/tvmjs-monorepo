import { sha256 } from '@noble/hashes/sha2.js'
import type { Permission } from '@tvmjs/util'
import { Address, bigIntToBytes, bytesToHex, concatBytes, setLengthLeft } from '@tvmjs/util'

import { TVMError } from '../errors.ts'
import { OOGResult } from '../tvm.ts'
import type { ExecResult } from '../types.ts'
import { DataWord } from './dataWord.ts'
import type { PrecompileInput } from './types.ts'
import { convertToTronAddress, extractBytesArray, recoverAddrBySign } from './util.ts'

export async function precompile0a(opts: PrecompileInput): Promise<ExecResult> {
  const rawData = opts.data
  const vm = opts._TVM

  const ENGERYPERSIGN = opts.common.param('validatemultisignGas')
  const MAX_SIZE = 5
  const cnt = Math.max(Math.floor((Math.floor(rawData.length / DataWord.WORD_SIZE) - 5) / 5), 0)
  const gasUsed = BigInt(cnt) * ENGERYPERSIGN

  if (opts.gasLimit < gasUsed) {
    return OOGResult(opts.gasLimit)
  }
  try {
    const words = DataWord.parseArray(rawData)

    const addr = words[0].getLast20Bytes()
    const permissionId = words[1].intValueSafe()
    const data = words[2].data

    const tronAddr = convertToTronAddress(addr)
    // permission id must be 4 bytes
    const permissionIdBytes = setLengthLeft(bigIntToBytes(BigInt(permissionId)), 4)
    const combine = concatBytes(tronAddr, permissionIdBytes, data)

    const hash = sha256(combine)

    const signatures = extractBytesArray(
      words,
      words[3].intValueSafe() / DataWord.WORD_SIZE,
      rawData,
    )

    if (signatures.length === 0 || signatures.length > MAX_SIZE) {
      return {
        executionGasUsed: gasUsed,
        returnValue: new Uint8Array(DataWord.WORD_SIZE),
      }
    }

    const address = new Address(addr)
    const account = await vm.stateManager.getAccount(address)

    if (account) {
      try {
        const permission = account.getPermissionById(permissionId)
        if (permission) {
          let totalWeight = 0
          const executedSignList = new Set()
          const executedAddrList = new Set()
          for (const sign of signatures) {
            const signHexStr = bytesToHex(sign)
            if (executedSignList.has(signHexStr)) {
              continue
            }
            const recoveredAddr = recoverAddrBySign(sign, hash)
            if (executedAddrList.has(bytesToHex(recoveredAddr))) {
              continue
            }

            const weight = getWeight(permission, recoveredAddr)
            if (weight === 0) {
              return {
                executionGasUsed: gasUsed,
                returnValue: new Uint8Array(DataWord.WORD_SIZE),
              }
            }

            totalWeight += weight
            executedAddrList.add(bytesToHex(recoveredAddr))
            executedSignList.add(signHexStr)
          }

          if (totalWeight >= permission.threshold) {
            const returnValue = new Uint8Array(DataWord.WORD_SIZE)
            returnValue[DataWord.WORD_SIZE - 1] = 1
            return {
              executionGasUsed: gasUsed,
              returnValue,
            }
          }
        }
      } catch {
        // ignore
      }
    }

    const returnData = new Uint8Array(DataWord.WORD_SIZE)

    return {
      executionGasUsed: gasUsed,
      returnValue: returnData,
    }
  } catch {
    return {
      executionGasUsed: opts.gasLimit,
      returnValue: new Uint8Array(),
      exceptionError: new TVMError(TVMError.errorMessages.UNKNOWN),
    }
  }
}

function getWeight(permission: Permission, address: Uint8Array) {
  const keys = permission.keys
  for (const key of keys) {
    if (DataWord.equalAddressByteArray(key.address, address)) {
      return key.weight
    }
  }
  return 0
}
