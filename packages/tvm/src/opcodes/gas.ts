import {
  BIGINT_0,
  BIGINT_1,
  BIGINT_3,
  BIGINT_31,
  BIGINT_32,
  BIGINT_64,
  bigIntToBytes,
  setLengthLeft,
} from '@tvmjs/util'

import { EOFErrorMessage } from '../eof/errors.ts'
import { TVMError } from '../errors.ts'

import { accessAddressEIP2929 } from './EIP2929.ts'
import {
  createAddressFromStackBigInt,
  divCeil,
  maxCallGas,
  setLengthLeftStorage,
  subMemUsage,
  trap,
  updateSstoreGas,
} from './util.ts'

import type { Common } from '@tvmjs/common'
import type { RunState } from '../interpreter.ts'

const EXTCALL_TARGET_MAX = BigInt(2) ** BigInt(8 * 20) - BigInt(1)

/**
 * Check the complete caller cost before forwarding the remaining version-0 Energy.
 */
function setCallGasLimit(runState: RunState, gas: bigint, requestedGas: bigint): bigint {
  const gasLeft = runState.interpreter.getGasLeft()
  if (gas > gasLeft) {
    trap(TVMError.errorMessages.OUT_OF_GAS)
  }
  runState.messageGasLimit = maxCallGas(requestedGas, gasLeft - gas)
  return gas
}

/**
 * This file returns the dynamic parts of opcodes which have dynamic gas
 * These are not pure functions: some edit the size of the memory
 * These functions are therefore not read-only
 */

// The dynamic gas handler methods take a runState and a gas BN
// The gas BN is necessary, since the base fee needs to be included,
// to calculate the max call gas for the call opcodes correctly.
export interface AsyncDynamicGasHandler {
  (runState: RunState, gas: bigint, common: Common): Promise<bigint>
}

export interface SyncDynamicGasHandler {
  (runState: RunState, gas: bigint, common: Common): bigint
}

export const dynamicGasHandlers: Map<number, AsyncDynamicGasHandler | SyncDynamicGasHandler> =
  new Map<number, AsyncDynamicGasHandler>([
    [
      /* EXP */
      0x0a,
      async function (runState, gas, common): Promise<bigint> {
        const [_base, exponent] = runState.stack.peek(2)
        if (exponent === BIGINT_0) {
          return gas
        }
        let byteLength = exponent.toString(2).length / 8
        if (byteLength > Math.trunc(byteLength)) {
          byteLength = Math.trunc(byteLength) + 1
        }
        if (byteLength < 1 || byteLength > 32) {
          trap(TVMError.errorMessages.OUT_OF_RANGE)
        }
        const expPricePerByte = common.param('expByteGas')
        gas += BigInt(byteLength) * expPricePerByte
        return gas
      },
    ],
    [
      /* KECCAK256 */
      0x20,
      async function (runState, gas, common): Promise<bigint> {
        const [offset, length] = runState.stack.peek(2)
        gas += subMemUsage(runState, offset, length, common)
        gas += common.param('keccak256WordGas') * divCeil(length, BIGINT_32)
        return gas
      },
    ],
    [
      /* BALANCE */
      0x31,
      async function (runState, gas): Promise<bigint> {
        const address = createAddressFromStackBigInt(runState.stack.peek()[0])
        runState.interpreter.journal.addAccessedAddress(address.bytes)
        return gas
      },
    ],
    [
      /* CALLDATACOPY */
      0x37,
      async function (runState, gas, common): Promise<bigint> {
        const [memOffset, _dataOffset, dataLength] = runState.stack.peek(3)

        gas += subMemUsage(runState, memOffset, dataLength, common)
        if (dataLength !== BIGINT_0) {
          gas += common.param('copyGas') * divCeil(dataLength, BIGINT_32)
        }
        return gas
      },
    ],
    [
      /* CODECOPY */
      0x39,
      async function (runState, gas, common): Promise<bigint> {
        const [memOffset, _codeOffset, dataLength] = runState.stack.peek(3)

        gas += subMemUsage(runState, memOffset, dataLength, common)
        if (dataLength !== BIGINT_0) {
          gas += common.param('copyGas') * divCeil(dataLength, BIGINT_32)

          if (
            (common.isActivatedEIP(6800) || common.isActivatedEIP(7864)) &&
            runState.env.chargeCodeAccesses === true
          ) {
            const contract = runState.interpreter.getAddress()
            let codeEnd = _codeOffset + dataLength
            const codeSize = runState.interpreter.getCodeSize()
            if (codeEnd > codeSize) {
              codeEnd = codeSize
            }

            gas += runState.env.accessWitness!.readAccountCodeChunks(
              contract,
              Number(_codeOffset),
              Number(codeEnd),
            )
          }
        }
        return gas
      },
    ],
    [
      /* EXTCODESIZE */
      0x3b,
      async function (runState, gas): Promise<bigint> {
        const address = createAddressFromStackBigInt(runState.stack.peek()[0])
        runState.interpreter.journal.addAccessedAddress(address.bytes)
        return gas
      },
    ],
    [
      /* EXTCODECOPY */
      0x3c,
      async function (runState, gas, common): Promise<bigint> {
        const [addressBigInt, memOffset, _codeOffset, dataLength] = runState.stack.peek(4)
        const address = createAddressFromStackBigInt(addressBigInt)
        runState.interpreter.journal.addAccessedAddress(address.bytes)
        gas += subMemUsage(runState, memOffset, dataLength, common)
        gas += common.param('copyGas') * divCeil(dataLength, BIGINT_32)
        return gas
      },
    ],
    [
      /* RETURNDATACOPY */
      0x3e,
      async function (runState, gas, common): Promise<bigint> {
        const [memOffset, returnDataOffset, dataLength] = runState.stack.peek(3)

        if (returnDataOffset + dataLength > runState.interpreter.getReturnDataSize()) {
          // For an EOF contract, the behavior is changed (see EIP 7069)
          // RETURNDATACOPY in that case does not throw OOG when reading out-of-bounds
          if (runState.env.eof === undefined) {
            trap(TVMError.errorMessages.OUT_OF_GAS)
          }
        }

        gas += subMemUsage(runState, memOffset, dataLength, common)

        if (dataLength !== BIGINT_0) {
          gas += common.param('copyGas') * divCeil(dataLength, BIGINT_32)
        }
        return gas
      },
    ],
    [
      /* EXTCODEHASH */
      0x3f,
      async function (runState, gas): Promise<bigint> {
        const address = createAddressFromStackBigInt(runState.stack.peek()[0])
        runState.interpreter.journal.addAccessedAddress(address.bytes)
        return gas
      },
    ],
    [
      /* MLOAD */
      0x51,
      async function (runState, gas, common): Promise<bigint> {
        const pos = runState.stack.peek()[0]
        gas += subMemUsage(runState, pos, BIGINT_32, common)
        return gas
      },
    ],
    [
      /* MSTORE */
      0x52,
      async function (runState, gas, common): Promise<bigint> {
        const offset = runState.stack.peek()[0]
        gas += subMemUsage(runState, offset, BIGINT_32, common)
        return gas
      },
    ],
    [
      /* MSTORE8 */
      0x53,
      async function (runState, gas, common): Promise<bigint> {
        const offset = runState.stack.peek()[0]
        gas += subMemUsage(runState, offset, BIGINT_1, common)
        return gas
      },
    ],
    [
      /* SLOAD */
      0x54,
      async function (runState, gas): Promise<bigint> {
        const key = setLengthLeft(bigIntToBytes(runState.stack.peek()[0]), 32)
        runState.interpreter.journal.addAccessedStorage(
          runState.interpreter.getAddress().bytes,
          key,
        )
        return gas
      },
    ],
    [
      /* SSTORE */
      0x55,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.interpreter.isStatic()) {
          trap(TVMError.errorMessages.STATIC_STATE_CHANGE)
        }
        const [key, value] = runState.stack.peek(2)
        const keyBytes = setLengthLeft(bigIntToBytes(key), 32)
        const currentStorage = await runState.interpreter.storageLoad(keyBytes)
        runState.interpreter.journal.addAccessedStorage(
          runState.interpreter.getAddress().bytes,
          keyBytes,
        )
        // A zero written earlier in this transaction still exists in java-tron's row cache.
        // Only an absent slot's first nonzero write incurs the set cost.
        gas += updateSstoreGas(
          setLengthLeftStorage(currentStorage),
          value === BIGINT_0 ? new Uint8Array() : bigIntToBytes(value),
          common,
          runState.interpreter.journal.hasStorageWrite(runState.interpreter.getAddress(), keyBytes),
        )
        return gas
      },
    ],
    [
      /* MCOPY */
      0x5e,
      async function (runState, gas, common): Promise<bigint> {
        const [dst, src, length] = runState.stack.peek(3)
        const wordsCopied = (length + BIGINT_31) / BIGINT_32
        gas += BIGINT_3 * wordsCopied
        gas += subMemUsage(runState, src, length, common)
        gas += subMemUsage(runState, dst, length, common)
        return gas
      },
    ],
    [
      /* LOG */
      0xa0,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.interpreter.isStatic()) {
          trap(TVMError.errorMessages.STATIC_STATE_CHANGE)
        }

        const [memOffset, memLength] = runState.stack.peek(2)

        const topicsCount = runState.opCode - 0xa0

        if (topicsCount < 0 || topicsCount > 4) {
          trap(TVMError.errorMessages.OUT_OF_RANGE)
        }

        gas += subMemUsage(runState, memOffset, memLength, common)
        gas +=
          common.param('logTopicGas') * BigInt(topicsCount) + memLength * common.param('logDataGas')
        return gas
      },
    ],
    /* EOFCREATE */
    [
      0xec,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.env.eof === undefined) {
          // Opcode not available in legacy contracts
          trap(TVMError.errorMessages.INVALID_OPCODE)
        }
        // Note: TX_CREATE_COST is in the base fee (this is 32000 and same as CREATE / CREATE2)

        // Note: in `gas.ts` programCounter is not yet incremented (which it is in `functions.ts`)
        // So have to manually add to programCounter here to get the right container index

        // Read container index
        const containerIndex = runState.env.code[runState.programCounter + 1]

        // Pop stack values
        const [_value, _salt, inputOffset, inputSize] = runState.stack.peek(4)

        // Expand memory
        gas += subMemUsage(runState, inputOffset, inputSize, common)

        // Read container
        const container = runState.env.eof!.container.body.containerSections[containerIndex]

        // Charge for hashing cost
        gas += common.param('keccak256WordGas') * divCeil(BigInt(container.length), BIGINT_32)

        const gasLeft = runState.interpreter.getGasLeft() - gas
        runState.messageGasLimit = maxCallGas(gasLeft, gasLeft)

        return gas
      },
    ],
    /* RETURNCONTRACT */
    [
      0xee,
      async function (runState, gas, common): Promise<bigint> {
        // Pop stack values
        const [auxDataOffset, auxDataSize] = runState.stack.peek(2)

        // Expand memory
        gas += subMemUsage(runState, auxDataOffset, auxDataSize, common)

        return gas
      },
    ],
    [
      /* CREATE */
      0xf0,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.interpreter.isStatic()) {
          trap(TVMError.errorMessages.STATIC_STATE_CHANGE)
        }
        const [_value, offset, length] = runState.stack.peek(3)

        gas += subMemUsage(runState, offset, length, common)

        let gasLimit = BigInt(runState.interpreter.getGasLeft()) - gas
        gasLimit = maxCallGas(gasLimit, gasLimit)

        runState.messageGasLimit = gasLimit
        return gas
      },
    ],
    [
      /* CALL */
      0xf1,
      async function (runState, gas, common): Promise<bigint> {
        const [requestedGas, toAddr, value, inOffset, inLength, outOffset, outLength] =
          runState.stack.peek(7)
        const toAddress = createAddressFromStackBigInt(toAddr)

        if (runState.interpreter.isStatic() && value !== BIGINT_0) {
          trap(TVMError.errorMessages.STATIC_STATE_CHANGE)
        }
        runState.interpreter.journal.addAccessedAddress(toAddress.bytes)
        gas += subMemUsage(runState, inOffset, inLength, common)
        gas += subMemUsage(runState, outOffset, outLength, common)

        if (value !== BIGINT_0) {
          gas += common.param('callValueTransferGas')
          // TRON checks existence, including accounts with zero TRX and token balances.
          if ((await runState.stateManager.getAccount(toAddress)) === undefined) {
            gas += common.param('callNewAccountGas')
          }
        }

        return setCallGasLimit(runState, gas, requestedGas)
      },
    ],
    [
      /* CALLCODE */
      0xf2,
      async function (runState, gas, common): Promise<bigint> {
        const [requestedGas, toAddr, value, inOffset, inLength, outOffset, outLength] =
          runState.stack.peek(7)
        const toAddress = createAddressFromStackBigInt(toAddr)
        runState.interpreter.journal.addAccessedAddress(toAddress.bytes)
        gas += subMemUsage(runState, inOffset, inLength, common)
        gas += subMemUsage(runState, outOffset, outLength, common)

        if (value !== BIGINT_0) {
          gas += common.param('callValueTransferGas')
        }

        return setCallGasLimit(runState, gas, requestedGas)
      },
    ],
    [
      /* RETURN */
      0xf3,
      async function (runState, gas, common): Promise<bigint> {
        const [offset, length] = runState.stack.peek(2)
        gas += subMemUsage(runState, offset, length, common)
        return gas
      },
    ],
    [
      /* DELEGATECALL */
      0xf4,
      async function (runState, gas, common): Promise<bigint> {
        const [requestedGas, toAddr, inOffset, inLength, outOffset, outLength] =
          runState.stack.peek(6)
        const toAddress = createAddressFromStackBigInt(toAddr)
        runState.interpreter.journal.addAccessedAddress(toAddress.bytes)
        gas += subMemUsage(runState, inOffset, inLength, common)
        gas += subMemUsage(runState, outOffset, outLength, common)

        return setCallGasLimit(runState, gas, requestedGas)
      },
    ],
    [
      /* CREATE2 */
      0xf5,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.interpreter.isStatic()) {
          trap(TVMError.errorMessages.STATIC_STATE_CHANGE)
        }

        const [_value, offset, length, _salt] = runState.stack.peek(4)

        gas += subMemUsage(runState, offset, length, common)

        gas += common.param('keccak256WordGas') * divCeil(length, BIGINT_32)
        let gasLimit = runState.interpreter.getGasLeft() - gas
        gasLimit = maxCallGas(gasLimit, gasLimit)
        runState.messageGasLimit = gasLimit
        return gas
      },
    ],
    /* EXTCALL */
    [
      0xf8,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.env.eof === undefined) {
          // Opcode not available in legacy contracts
          trap(TVMError.errorMessages.INVALID_OPCODE)
        }
        // Charge WARM_STORAGE_READ_COST (100) -> done in accessAddressEIP2929

        // Peek stack values
        const [toAddr, inOffset, inLength, value] = runState.stack.peek(4)

        // If value is nonzero and in static mode, throw:
        if (runState.interpreter.isStatic() && value !== BIGINT_0) {
          trap(TVMError.errorMessages.STATIC_STATE_CHANGE)
        }

        // If value > 0, charge CALL_VALUE_COST
        if (value > BIGINT_0) {
          gas += common.param('callValueTransferGas')
        }

        // Check if the target address > 20 bytes
        if (toAddr > EXTCALL_TARGET_MAX) {
          trap(EOFErrorMessage.INVALID_EXTCALL_TARGET)
        }

        // Charge for memory expansion
        gas += subMemUsage(runState, inOffset, inLength, common)

        const toAddress = createAddressFromStackBigInt(toAddr)
        // Charge to make address warm (2600 gas)
        // (in case if address is already warm, this charges the 100 gas)
        gas += accessAddressEIP2929(runState, toAddress.bytes, common)

        // Charge account creation cost if value is nonzero
        if (value > BIGINT_0) {
          const account = await runState.stateManager.getAccount(toAddress)
          const deadAccount = account === undefined || account.isEmpty()

          if (deadAccount) {
            gas += common.param('callNewAccountGas')
          }
        }

        const minRetainedGas = common.param('minRetainedGas')
        const minCalleeGas = common.param('minCalleeGas')

        const currentGasAvailable = runState.interpreter.getGasLeft() - gas
        const reducedGas = currentGasAvailable / BIGINT_64
        // Calculate the gas limit for the callee
        // (this is the gas available for the next call frame)
        let gasLimit: bigint
        if (reducedGas < minRetainedGas) {
          gasLimit = currentGasAvailable - minRetainedGas
        } else {
          gasLimit = currentGasAvailable - reducedGas
        }

        if (
          runState.env.depth >= Number(common.param('stackLimit')) ||
          runState.env.contract.balance < value ||
          gasLimit < minCalleeGas
        ) {
          // Note: this is a hack, TODO: get around this hack and clean this up
          // This special case will ensure that the actual EXT*CALL is being ran,
          // But, the code in `function.ts` will note that `runState.messageGasLimit` is set to a negative number
          // This special number signals that `1` should be put on the stack (per spec)
          gasLimit = -BIGINT_1
        }

        runState.messageGasLimit = gasLimit

        return gas
      },
    ],
    /* EXTDELEGATECALL */
    [
      0xf9,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.env.eof === undefined) {
          // Opcode not available in legacy contracts
          trap(TVMError.errorMessages.INVALID_OPCODE)
        }
        // Charge WARM_STORAGE_READ_COST (100) -> done in accessAddressEIP2929

        // Peek stack values
        const [toAddr, inOffset, inLength] = runState.stack.peek(3)

        // Check if the target address > 20 bytes
        if (toAddr > EXTCALL_TARGET_MAX) {
          trap(EOFErrorMessage.INVALID_EXTCALL_TARGET)
        }

        // Charge for memory expansion
        gas += subMemUsage(runState, inOffset, inLength, common)

        const toAddress = createAddressFromStackBigInt(toAddr)
        // Charge to make address warm (2600 gas)
        // (in case if address is already warm, this charges the 100 gas)
        gas += accessAddressEIP2929(runState, toAddress.bytes, common)

        const minRetainedGas = common.param('minRetainedGas')
        const minCalleeGas = common.param('minCalleeGas')

        const currentGasAvailable = runState.interpreter.getGasLeft() - gas
        const reducedGas = currentGasAvailable / BIGINT_64
        // Calculate the gas limit for the callee
        // (this is the gas available for the next call frame)
        let gasLimit: bigint
        if (reducedGas < minRetainedGas) {
          gasLimit = currentGasAvailable - minRetainedGas
        } else {
          gasLimit = currentGasAvailable - reducedGas
        }

        if (runState.env.depth >= Number(common.param('stackLimit')) || gasLimit < minCalleeGas) {
          // Note: this is a hack, TODO: get around this hack and clean this up
          // This special case will ensure that the actual EXT*CALL is being ran,
          // But, the code in `function.ts` will note that `runState.messageGasLimit` is set to a negative number
          // This special number signals that `1` should be put on the stack (per spec)
          gasLimit = -BIGINT_1
        }

        runState.messageGasLimit = gasLimit

        return gas
      },
    ],
    [
      /* STATICCALL */
      0xfa,
      async function (runState, gas, common): Promise<bigint> {
        const [requestedGas, toAddr, inOffset, inLength, outOffset, outLength] =
          runState.stack.peek(6)
        const toAddress = createAddressFromStackBigInt(toAddr)
        runState.interpreter.journal.addAccessedAddress(toAddress.bytes)
        gas += subMemUsage(runState, inOffset, inLength, common)
        gas += subMemUsage(runState, outOffset, outLength, common)

        return setCallGasLimit(runState, gas, requestedGas)
      },
    ],
    /* EXTSTATICCALL */
    [
      0xfb,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.env.eof === undefined) {
          // Opcode not available in legacy contracts
          trap(TVMError.errorMessages.INVALID_OPCODE)
        }
        // Charge WARM_STORAGE_READ_COST (100) -> done in accessAddressEIP2929

        // Peek stack values
        const [toAddr, inOffset, inLength] = runState.stack.peek(3)

        // Check if the target address > 20 bytes
        if (toAddr > EXTCALL_TARGET_MAX) {
          trap(EOFErrorMessage.INVALID_EXTCALL_TARGET)
        }

        // Charge for memory expansion
        gas += subMemUsage(runState, inOffset, inLength, common)

        const toAddress = createAddressFromStackBigInt(toAddr)
        // Charge to make address warm (2600 gas)
        // (in case if address is already warm, this charges the 100 gas)
        gas += accessAddressEIP2929(runState, toAddress.bytes, common)

        const minRetainedGas = common.param('minRetainedGas')
        const minCalleeGas = common.param('minCalleeGas')

        const currentGasAvailable = runState.interpreter.getGasLeft() - gas
        const reducedGas = currentGasAvailable / BIGINT_64
        // Calculate the gas limit for the callee
        // (this is the gas available for the next call frame)
        let gasLimit: bigint
        if (reducedGas < minRetainedGas) {
          gasLimit = currentGasAvailable - minRetainedGas
        } else {
          gasLimit = currentGasAvailable - reducedGas
        }

        if (runState.env.depth >= Number(common.param('stackLimit')) || gasLimit < minCalleeGas) {
          // Note: this is a hack, TODO: get around this hack and clean this up
          // This special case will ensure that the actual EXT*CALL is being ran,
          // But, the code in `function.ts` will note that `runState.messageGasLimit` is set to a negative number
          // This special number signals that `1` should be put on the stack (per spec)
          gasLimit = -BIGINT_1
        }

        runState.messageGasLimit = gasLimit

        return gas
      },
    ],
    [
      /* REVERT */
      0xfd,
      async function (runState, gas, common): Promise<bigint> {
        const [offset, length] = runState.stack.peek(2)
        gas += subMemUsage(runState, offset, length, common)
        return gas
      },
    ],
    [
      /* SELFDESTRUCT */
      0xff,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.interpreter.isStatic()) {
          trap(TVMError.errorMessages.STATIC_STATE_CHANGE)
        }
        const beneficiary = createAddressFromStackBigInt(runState.stack.peek()[0])
        runState.interpreter.journal.addAccessedAddress(beneficiary.bytes)
        // java-tron getSuicideCost3 charges for a missing beneficiary even at zero balance.
        if ((await runState.stateManager.getAccount(beneficiary)) === undefined) {
          gas += common.param('callNewAccountGas')
        }
        return gas
      },
    ],
    // TRON - opcode
    // 0xd0: CALLTOKEN
    [
      0xd0,
      async function (runState, gas, common): Promise<bigint> {
        const [requestedGas, toAddr, value, _tokenId, inOffset, inLength, outOffset, outLength] =
          runState.stack.peek(8)
        const toAddress = createAddressFromStackBigInt(toAddr)

        if (runState.interpreter.isStatic() && value !== BIGINT_0) {
          trap(TVMError.errorMessages.STATIC_STATE_CHANGE)
        }
        runState.interpreter.journal.addAccessedAddress(toAddress.bytes)
        gas += subMemUsage(runState, inOffset, inLength, common)
        gas += subMemUsage(runState, outOffset, outLength, common)

        if (value !== BIGINT_0) {
          gas += common.param('callValueTransferGas')
          // TRON checks existence, including accounts with zero TRX and token balances.
          if ((await runState.stateManager.getAccount(toAddress)) === undefined) {
            gas += common.param('callNewAccountGas')
          }
        }

        return setCallGasLimit(runState, gas, requestedGas)
      },
    ],
    // 0xd1: TOKENBALANCE
    [
      0xd1,
      async function (runState, gas): Promise<bigint> {
        const [_tokenId, addressWord] = runState.stack.peek(2)
        const address = createAddressFromStackBigInt(addressWord)
        runState.interpreter.journal.addAccessedAddress(address.bytes)
        return gas
      },
    ],
    [
      0xd4,
      async function (runState, gas): Promise<bigint> {
        const address = createAddressFromStackBigInt(runState.stack.peek()[0])
        runState.interpreter.journal.addAccessedAddress(address.bytes)
        return gas
      },
    ],
  ])

// Set the range [0xa0, 0xa4] to the LOG handler
const logDynamicFunc = dynamicGasHandlers.get(0xa0)!
for (let i = 0xa1; i <= 0xa4; i++) {
  dynamicGasHandlers.set(i, logDynamicFunc)
}
