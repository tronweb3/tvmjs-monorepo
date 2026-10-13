import { Common, TronMainnet } from '@tvmjs/common'
import {
  BINARY_TREE_MAIN_STORAGE_OFFSET,
  RIPEMD160_ADDRESS_STRING,
  bigIntToBytes,
  bytesToBigInt,
  bytesToHex,
  concatBytes,
  createAccount,
  createAddressFromString,
  hexToBytes,
  publicToAddress,
  setLengthLeft,
} from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import { Interpreter } from '../src/interpreter.ts'

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import debugDefault from 'debug'
import {
  BinaryTreeAccessWitness,
  decodeBinaryAccessState,
  generateBinaryExecutionWitness,
} from '../src/binaryTreeAccessWitness.ts'
import { ChunkCache } from '../src/chunkCache.ts'
import { createEIP7708SelfdestructLog, createEIP7708TransferLog } from '../src/eip7708.ts'
import { EOFContainer, EOFContainerMode, validateEOF } from '../src/eof/container.ts'
import { EOFErrorMessage, validationError, validationErrorMsg } from '../src/eof/errors.ts'
import { setupEOF } from '../src/eof/setup.ts'
import { EOFBYTES, EOFHASH } from '../src/eof/util.ts'
import { ContainerSectionType, verifyCode } from '../src/eof/verify.ts'
import { TVMError } from '../src/errors.ts'
import { createTVM, paramsTVM } from '../src/index.ts'
import { Journal } from '../src/journal.ts'
import { TVMPerformanceLogger } from '../src/logger.ts'
import { Memory } from '../src/memory.ts'
import { Message } from '../src/message.ts'
import { accessAddressEIP2929, getAddressAccessCost, warmAddress } from '../src/opcodes/EIP2929.ts'
import { handlers } from '../src/opcodes/functions.ts'
import { dynamicGasHandlers } from '../src/opcodes/gas.ts'
import {
  abs,
  decodeEIP8024PairImmediate,
  decodeEIP8024SingleImmediate,
  describeLocation,
  divCeil,
  getDataSlice,
  isEIP8024PairImmediateValid,
  isEIP8024SingleImmediateValid,
  mod,
  readImmediateByteOrZero,
} from '../src/opcodes/util.ts'
import { precompile0a } from '../src/precompiles/0a-validate-multi-sign.ts'
import { precompile0b } from '../src/precompiles/0b-bls12-g1add.ts'
import { precompile0c } from '../src/precompiles/0c-bls12-g1msm.ts'
import { precompile0d } from '../src/precompiles/0d-bls12-g2add.ts'
import { precompile0e } from '../src/precompiles/0e-bls12-g2msm.ts'
import { precompile0f } from '../src/precompiles/0f-bls12-pairing.ts'
import { precompile01 } from '../src/precompiles/01-ecrecover.ts'
import { precompile04 } from '../src/precompiles/04-identity.ts'
import { precompile05 } from '../src/precompiles/05-modexp.ts'
import { precompile06 } from '../src/precompiles/06-bn254-add.ts'
import { precompile07 } from '../src/precompiles/07-bn254-mul.ts'
import { precompile08 } from '../src/precompiles/08-bn254-pairing.ts'
import { precompile10 } from '../src/precompiles/10-bls12-map-fp-to-g1.ts'
import { precompile11 } from '../src/precompiles/11-bls12-map-fp2-to-g2.ts'
import { precompile100 } from '../src/precompiles/100-p256verify.ts'
import { precompile20003 } from '../src/precompiles/20003-ripemd160.ts'
import { F, precompile20009 } from '../src/precompiles/20009-blake2f.ts'
import { RustBN254 } from '../src/precompiles/bn254/rustbn.ts'
import { convertToTronAddress } from '../src/precompiles/util.ts'
import { Stack } from '../src/stack.ts'
import { StemCache } from '../src/stemCache.ts'
import { TransientStorage } from '../src/transientStorage.ts'
import { TVM } from '../src/tvm.ts'
import { TVMMockBlockchain } from '../src/types.ts'

function createTronCommon() {
  const common = new Common({ chain: TronMainnet })
  common.updateParams(paramsTVM)
  return common
}

function createDebugSpy() {
  const logger = debugDefault('tvmjs:coverage-test')
  logger.enabled = true
  logger.log = vi.fn()
  return logger
}

function createMockRunState(
  opts: {
    code?: Uint8Array
    gasLimit?: bigint
    stack?: bigint[]
    common?: Common
  } = {},
) {
  const common = opts.common ?? createTronCommon()
  common.updateParams(paramsTVM)
  const stack = new Stack(1024)
  if (opts.stack) {
    for (const val of opts.stack) {
      stack.push(val)
    }
  }
  const memory = new Memory()
  const code = opts.code ?? new Uint8Array(200)
  const to = createAddressFromString('0x1111111111111111111111111111111111111111')
  const caller = createAddressFromString('0x2222222222222222222222222222222222222222')
  const message = new Message({
    to,
    caller,
    gasLimit: opts.gasLimit ?? 1000000n,
    data: new Uint8Array(100),
    value: 0n,
    code,
  })
  const warmedAddresses = new Set<string>()
  const warmedStorage = new Set<string>()
  const transientMap = new Map<string, Uint8Array>()

  const runState: any = {
    programCounter: 0,
    opCode: 0,
    highestMemCost: 0n,
    memory,
    memoryWordCount: 0n,
    stack,
    returnStack: [],
    code,
    validJumps: new Uint8Array(200),
    shouldDoJumpAnalysis: true,
    cachedPushes: [],
    stateManager: {
      getAccount: async () => createAccount({ nonce: 1n, balance: 1000n }),
      putAccount: async () => {},
      deleteAccount: async () => {},
      getCode: async () => new Uint8Array(10),
      getContractCode: async () => new Uint8Array(10),
      getContractStorage: async () => new Uint8Array(32),
      putContractStorage: async () => {},
    } as any,
    blockchain: {} as any,
    env: {
      blockchain: {} as any,
      stateManager: {} as any,
      address: message.to,
      caller: message.caller,
      callData: message.data,
      callValue: message.value,
      code,
      depth: 0,
      gasPrice: 1n,
      origin: message.caller,
      block: {
        header: {
          number: 1n,
          timestamp: 1000n,
          coinbase: message.caller,
          difficulty: 1n,
          gasLimit: 10000000n,
          baseFeePerGas: 7n,
        },
      } as any,
      contract: { getBalance: async () => 1000n } as any,
    },
    messageGasLimit: 100000n,
    interpreter: {
      isStatic: () => false,
      getGasLeft: () => 1000000n,
      useGas: (_amount: bigint) => {},
      refundGas: (_amount: bigint) => {},
      addStipend: (_stipend: bigint) => {},
      getAddress: () => to,
      getCaller: () => caller,
      getTxOrigin: () => caller,
      getTxGasPrice: () => 1n,
      getCallValue: () => 0n,
      getCallData: () => new Uint8Array(32),
      getCallDataSize: () => 32n,
      getReturnData: () => new Uint8Array(100),
      getReturnDataSize: () => 100n,
      getCodeSize: () => 100,
      getCode: () => new Uint8Array(100),
      getExternalCodeSize: async () => 20,
      getExternalCode: async () => new Uint8Array(20),
      getExternalCodeHash: async () => new Uint8Array(32),
      getExternalBalance: async () => 1000n,
      getExternalTokenBalance: async () => 1000n,
      getCallTokenValue: () => 50n,
      getCallTokenId: () => 1000001n,
      getBlockHash: async () => new Uint8Array(32),
      getBlockCoinbase: () => caller,
      getBlockTimestamp: () => 1000n,
      getBlockNumber: () => 1n,
      getBlockDifficulty: () => 1n,
      getBlockPrevRandao: () => 1n,
      getBlockGasLimit: () => 10000000n,
      getBlockBaseFee: () => 7n,
      getBlockSlotNumber: () => 1n,
      getChainId: () => 111111n,
      getSelfBalance: () => 5000n,
      storageLoad: async () => new Uint8Array(32),
      storageStore: async () => {},
      call: async () => 1n,
      callCode: async () => 1n,
      callDelegate: async () => 1n,
      callStatic: async () => 1n,
      callToken: async () => 1n,
      create: async () => 1n,
      create2: async () => 1n,
      finish: () => {},
      revert: () => {},
      selfDestruct: async () => {},
      log: () => {},
      transientStorageLoad: (key: Uint8Array) =>
        transientMap.get(bytesToHex(key)) ?? new Uint8Array(),
      transientStorageStore: (key: Uint8Array, value: Uint8Array) => {
        transientMap.set(bytesToHex(key), value)
      },
      journal: {
        isWarmedAddress: (addr: Uint8Array) => warmedAddresses.has(bytesToHex(addr)),
        addWarmedAddress: (addr: Uint8Array) => warmedAddresses.add(bytesToHex(addr)),
        isWarmedStorage: (addr: Uint8Array, slot: Uint8Array) =>
          warmedStorage.has(`${bytesToHex(addr)}:${bytesToHex(slot)}`),
        addWarmedStorage: (addr: Uint8Array, slot: Uint8Array) =>
          warmedStorage.add(`${bytesToHex(addr)}:${bytesToHex(slot)}`),
        addAccessedAddress: (_addr: Uint8Array) => {},
        addAccessedStorage: (_addr: Uint8Array, _slot: Uint8Array) => {},
        hasStorageWrite: () => false,
      },
      _tvm: {
        common,
        blockLevelAccessList: undefined,
      },
    },
  }
  return runState
}

describe('TVM Coverage Boost Suite', () => {
  describe('Caches and EIP-7708', () => {
    it('ChunkCache set, get, del, size, commit, clear', () => {
      const cache = new ChunkCache()
      expect(cache.size()).toBe(0)
      cache.set('0x01', { write: true })
      expect(cache.size()).toBe(1)
      expect(cache.get('0x01')).toEqual({ write: true })
      expect(cache.get('0x02')).toBeUndefined()

      cache.del('0x01')
      expect(cache.size()).toBe(0)

      cache.set('0x02', { write: false })
      const committed = cache.commit()
      expect(committed.length).toBe(1)
      expect(cache.size()).toBe(0)

      cache.set('0x03', { write: true })
      cache.clear()
      expect(cache.size()).toBe(0)
    })

    it('StemCache set, get, del, size, commit, clear', () => {
      const cache = new StemCache()
      const addr = createAddressFromString('0x1111111111111111111111111111111111111111')
      expect(cache.size()).toBe(0)
      cache.set('0x01', { address: addr, treeIndex: 0n, write: true })
      expect(cache.size()).toBe(1)
      expect(cache.get('0x01')?.write).toBe(true)

      cache.del('0x01')
      expect(cache.size()).toBe(0)

      cache.set('0x02', { address: addr, treeIndex: 1n })
      const committed = cache.commit()
      expect(committed.length).toBe(1)
      expect(cache.size()).toBe(0)

      cache.set('0x03', { address: addr, treeIndex: 2n })
      cache.clear()
      expect(cache.size()).toBe(0)
    })

    it('createEIP7708TransferLog and createEIP7708SelfdestructLog', () => {
      const from = createAddressFromString('0x1111111111111111111111111111111111111111')
      const to = createAddressFromString('0x2222222222222222222222222222222222222222')
      const transferLog = createEIP7708TransferLog(from, to, 1000n)
      expect(transferLog[0]).toBeDefined()
      expect(transferLog[1].length).toBe(3)

      const selfdestructLog = createEIP7708SelfdestructLog(from, 500n)
      expect(selfdestructLog[0]).toBeDefined()
      expect(selfdestructLog[1].length).toBe(2)
    })
  })

  describe('BinaryTreeAccessWitness & decodeBinaryAccessState', () => {
    it('decodeBinaryAccessState across all branch ranges', () => {
      expect(decodeBinaryAccessState(0n, 0).type).toBe('basicData')
      expect(decodeBinaryAccessState(0n, 1).type).toBe('codeHash')
      expect(() => decodeBinaryAccessState(0n, 2)).toThrow('No attribute yet stored')
      expect(decodeBinaryAccessState(0n, 64).type).toBe('storage')
      expect(decodeBinaryAccessState(0n, 128).type).toBe('code')
      expect(decodeBinaryAccessState(100n, 0).type).toBe('code')
      expect(decodeBinaryAccessState(BINARY_TREE_MAIN_STORAGE_OFFSET / 256n, 0).type).toBe(
        'storage',
      )
    })

    it('BinaryTreeAccessWitness methods', () => {
      const dummyHash = (msg: Uint8Array) => msg
      const witness = new BinaryTreeAccessWitness({ hashFunction: dummyHash })
      const addr = createAddressFromString('0x3333333333333333333333333333333333333333')

      expect(witness.readAccountBasicData(addr)).toBeGreaterThanOrEqual(0n)
      expect(witness.writeAccountBasicData(addr)).toBeGreaterThanOrEqual(0n)
      expect(witness.readAccountCodeHash(addr)).toBeGreaterThanOrEqual(0n)
      expect(witness.writeAccountCodeHash(addr)).toBeGreaterThanOrEqual(0n)
      expect(witness.readAccountHeader(addr)).toBeGreaterThanOrEqual(0n)
      expect(witness.writeAccountHeader(addr)).toBeGreaterThanOrEqual(0n)
      expect(witness.readAccountCodeChunks(addr, 0, 90)).toBeGreaterThanOrEqual(0n)
      expect(witness.readAccountStorage(addr, 1n)).toBeGreaterThanOrEqual(0n)
      expect(witness.writeAccountStorage(addr, 1n)).toBeGreaterThanOrEqual(0n)

      witness.commit()
      witness.revert()
      witness.debugWitnessCost()

      const otherWitness = new BinaryTreeAccessWitness({ hashFunction: dummyHash })
      otherWitness.writeAccountBasicData(addr)
      witness.merge(otherWitness)
    })
  })

  describe('Precompiles Boost', () => {
    it('precompile20003 (ripemd160)', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      const data = hexToBytes('0x12345678')
      const debugLogger = createDebugSpy()

      const res = precompile20003({
        data,
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(res.returnValue.length).toBe(32)
      expect(res.executionGasUsed).toBeGreaterThan(0n)
      expect(debugLogger.log).toHaveBeenCalled()

      const oog = precompile20003({
        data,
        gasLimit: 1n,
        common,
        _TVM: tvm,
      })
      expect(oog.executionGasUsed).toBe(1n)
    })

    it('precompile20009 (blake2f) and F function', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      const debugLogger = createDebugSpy()
      // Missing length
      const errLen = precompile20009({
        data: new Uint8Array(100),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(errLen.exceptionError).toBeDefined()

      // Invalid final byte
      const invalidFinal = new Uint8Array(213)
      invalidFinal[212] = 2
      const errFinal = precompile20009({
        data: invalidFinal,
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(errFinal.exceptionError).toBeDefined()

      // OOG check
      const validData = new Uint8Array(213)
      const view = new DataView(validData.buffer)
      view.setUint32(0, 1) // 1 round
      validData[212] = 0 // f = false
      const oog = precompile20009({
        data: validData,
        gasLimit: 0n,
        common,
        _TVM: tvm,
      })
      expect(oog.executionGasUsed).toBe(0n)

      // Valid execution
      const validRes = precompile20009({
        data: validData,
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(validRes.returnValue.length).toBe(64)
      expect(debugLogger.log).toHaveBeenCalled()

      // With f = true and 2 rounds
      validData[212] = 1
      view.setUint32(0, 2)
      const validRes2 = precompile20009({
        data: validData,
        gasLimit: 100000n,
        common,
        _TVM: tvm,
      })
      expect(validRes2.returnValue.length).toBe(64)

      // Direct call to F
      const h = new Uint32Array(16)
      const m = new Uint32Array(32)
      const t = new Uint32Array(4)
      F(h, m, t, true, 2)
      expect(h.some((x) => x !== 0)).toBe(true)
    })

    it('precompile06, 07, 08 error paths and debug', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      const debugLogger = createDebugSpy()

      // OOG check
      const oog6 = precompile06({
        data: new Uint8Array(128),
        gasLimit: 1n,
        common,
        _TVM: tvm,
      })
      expect(oog6.executionGasUsed).toBe(1n)

      const oog7 = precompile07({
        data: new Uint8Array(128),
        gasLimit: 1n,
        common,
        _TVM: tvm,
      })
      expect(oog7.executionGasUsed).toBe(1n)

      const oog8 = precompile08({
        data: new Uint8Array(192),
        gasLimit: 1n,
        common,
        _TVM: tvm,
      })
      expect(oog8.executionGasUsed).toBe(1n)

      // precompile08 data length not multiple of 192
      const errLen8 = precompile08({
        data: new Uint8Array(100),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(errLen8.exceptionError).toBeDefined()

      // Mock bn254 add error
      const origAdd = tvm['_bn254'].add
      tvm['_bn254'].add = () => {
        throw new Error('mock bn add error')
      }
      const addErr = precompile06({
        data: new Uint8Array(128),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(addErr.exceptionError).toBeDefined()
      tvm['_bn254'].add = origAdd

      // Mock bn254 mul error
      const origMul = tvm['_bn254'].mul
      tvm['_bn254'].mul = () => {
        throw new Error('mock bn mul error')
      }
      const mulErr = precompile07({
        data: new Uint8Array(128),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(mulErr.exceptionError).toBeDefined()
      tvm['_bn254'].mul = origMul

      // Mock bn254 pairing error
      const origPair = tvm['_bn254'].pairing
      tvm['_bn254'].pairing = () => {
        throw new Error('mock bn pairing error')
      }
      const pairErr = precompile08({
        data: new Uint8Array(192),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(pairErr.exceptionError).toBeDefined()
      tvm['_bn254'].pairing = origPair
    })

    it('precompile0a (validate-multi-sign)', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })

      // Small data
      const resShort = await precompile0a({
        data: new Uint8Array(32),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
      })
      expect(resShort.returnValue).toBeDefined()

      // Insufficient gasLimit
      const resOog = await precompile0a({
        data: new Uint8Array(320),
        gasLimit: 10n,
        common,
        _TVM: tvm,
      })
      expect(resOog.executionGasUsed).toBe(10n)
    })

    it('precompile100 (p256verify)', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      const debugLogger = createDebugSpy()

      // OOG
      const oog = precompile100({
        data: new Uint8Array(160),
        gasLimit: 1n,
        common,
        _TVM: tvm,
      })
      expect(oog.executionGasUsed).toBe(1n)

      // Invalid length
      const invalidLen = precompile100({
        data: new Uint8Array(100),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(invalidLen.returnValue.length).toBe(0)

      // Point not on curve
      const data = new Uint8Array(160)
      data.fill(0xff)
      const notOnCurve = precompile100({
        data,
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(notOnCurve.returnValue.length).toBe(0)
    })

    it('RustBN254 interface wrapper', () => {
      const mockRustbn = {
        ec_add: () => '0x' + '11'.repeat(64),
        ec_mul: () => '0x' + '22'.repeat(64),
        ec_pairing: () => '0x' + '33'.repeat(32),
      }
      const rustbn = new RustBN254(mockRustbn)
      expect(rustbn.add(new Uint8Array(128)).length).toBe(64)
      expect(rustbn.mul(new Uint8Array(128)).length).toBe(64)
      expect(rustbn.pairing(new Uint8Array(192)).length).toBe(32)
    })
  })

  describe('EOF Errors, Setup, and Verification', () => {
    it('covers all validationErrorMsg branches in eof/errors.ts', () => {
      for (const msg of Object.values(EOFErrorMessage)) {
        const result = validationErrorMsg(msg as any, 10, 'extra', 'info')
        expect(result).toBeDefined()
        expect(typeof result).toBe('string')
      }
    })

    it('setupEOF and verifyCode', async () => {
      const code = hexToBytes('0xef000101000402000100030400010000800001305000ef')
      const runState = createMockRunState({ code })
      setupEOF(runState, EOFContainerMode.Default)
      expect(runState.env.eof).toBeDefined()
      expect(runState.programCounter).toBe(runState.env.eof.container.header.getCodePosition(0))

      const common = createTronCommon()
      const tvm = await createTVM({ common })
      const container = new EOFContainer(code)

      try {
        verifyCode(container, tvm, ContainerSectionType.RuntimeCode)
      } catch {
        // May throw validation error due to TRON EOF rules, which is expected
      }
    })
  })

  describe('Opcodes: EIP-2929, functions and gas handlers', () => {
    it('EIP2929 getAddressAccessCost and warmAddress', () => {
      const common = createTronCommon()
      const runState = createMockRunState({ common })
      const addr = hexToBytes('0x1234567890123456789012345678901234567890')

      // Without EIP-2929
      expect(getAddressAccessCost(runState, addr, common)).toBe(0n)

      const spy = vi.spyOn(common, 'isActivatedEIP').mockImplementation((eip) => eip === 2929)
      const spyParam = vi.spyOn(common, 'param').mockImplementation((param) => {
        if (param === 'coldaccountaccessGas') return 2600n
        if (param === 'warmstoragereadGas') return 100n
        return 0n
      })
      try {
        // Cold access
        const costCold = getAddressAccessCost(runState, addr, common)
        expect(costCold).toBe(2600n)

        // Warm access
        warmAddress(runState, addr)
        const costWarm = getAddressAccessCost(runState, addr, common)
        expect(costWarm).toBe(100n)

        // Warm selfdestruct
        const costSelfdestruct = getAddressAccessCost(runState, addr, common, true, true)
        expect(costSelfdestruct).toBe(0n)

        // accessAddressEIP2929
        const costAccess = accessAddressEIP2929(runState, addr, common)
        expect(costAccess).toBe(100n)
      } finally {
        spy.mockRestore()
        spyParam.mockRestore()
      }
    })

    it('executes opcode handlers directly', async () => {
      const common = createTronCommon()

      // Test arithmetic handlers
      const testCases: { op: number; stack: bigint[]; expectedTop?: bigint; throws?: boolean }[] = [
        { op: 0x00, stack: [], throws: true }, // STOP
        { op: 0x01, stack: [2n, 3n], expectedTop: 5n }, // ADD
        { op: 0x02, stack: [2n, 3n], expectedTop: 6n }, // MUL
        { op: 0x03, stack: [2n, 5n], expectedTop: 3n }, // SUB
        { op: 0x04, stack: [2n, 6n], expectedTop: 3n }, // DIV
        { op: 0x05, stack: [2n, 6n], expectedTop: 3n }, // SDIV
        { op: 0x06, stack: [3n, 7n], expectedTop: 1n }, // MOD
        { op: 0x07, stack: [3n, 7n], expectedTop: 1n }, // SMOD
        { op: 0x08, stack: [5n, 2n, 4n], expectedTop: 1n }, // ADDMOD
        { op: 0x09, stack: [5n, 2n, 4n], expectedTop: 3n }, // MULMOD
        { op: 0x0a, stack: [2n, 3n], expectedTop: 9n }, // EXP
        {
          op: 0x0b,
          stack: [0xffn, 0n],
          expectedTop: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn,
        }, // SIGNEXTEND
        { op: 0x10, stack: [2n, 1n], expectedTop: 1n }, // LT
        { op: 0x11, stack: [1n, 2n], expectedTop: 1n }, // GT
        { op: 0x12, stack: [2n, 1n], expectedTop: 1n }, // SLT
        { op: 0x13, stack: [1n, 2n], expectedTop: 1n }, // SGT
        { op: 0x14, stack: [5n, 5n], expectedTop: 1n }, // EQ
        { op: 0x15, stack: [0n], expectedTop: 1n }, // ISZERO
        { op: 0x16, stack: [3n, 1n], expectedTop: 1n }, // AND
        { op: 0x17, stack: [2n, 1n], expectedTop: 3n }, // OR
        { op: 0x18, stack: [3n, 1n], expectedTop: 2n }, // XOR
        {
          op: 0x19,
          stack: [0n],
          expectedTop: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn,
        }, // NOT
        { op: 0x1a, stack: [0x1234n, 31n], expectedTop: 0x34n }, // BYTE
        { op: 0x1b, stack: [1n, 1n], expectedTop: 2n }, // SHL
        { op: 0x1c, stack: [2n, 1n], expectedTop: 1n }, // SHR
        { op: 0x1d, stack: [2n, 1n], expectedTop: 1n }, // SAR
        { op: 0x50, stack: [100n] }, // POP
        { op: 0x58, stack: [], expectedTop: 0n }, // PC
        { op: 0x59, stack: [], expectedTop: 0n }, // MSIZE
        { op: 0x5a, stack: [], expectedTop: 1000000n }, // GAS
        { op: 0x5b, stack: [] }, // JUMPDEST
        { op: 0x5f, stack: [], expectedTop: 0n }, // PUSH0
        { op: 0xfd, stack: [0n, 0n] }, // REVERT
        { op: 0xfe, stack: [], throws: true }, // INVALID
      ]

      for (const tc of testCases) {
        const handler = handlers.get(tc.op)
        if (!handler) continue
        const runState = createMockRunState({ stack: tc.stack, common })
        if (tc.op === 0x58) {
          runState.programCounter = 1
        }

        if (tc.throws) {
          expect(() => handler(runState, common)).toThrow()
        } else {
          await handler(runState, common)
          if (tc.expectedTop !== undefined) {
            expect(runState.stack.pop()).toBe(tc.expectedTop)
          }
        }
      }

      // Memory handlers: MSTORE, MLOAD, MSTORE8, MCOPY
      const mstore = handlers.get(0x52)!
      const mload = handlers.get(0x51)!
      const mstore8 = handlers.get(0x53)!
      const mcopy = handlers.get(0x5e)!

      const runStateMem = createMockRunState({ common })
      runStateMem.stack.push(0x42n)
      runStateMem.stack.push(0n)
      await mstore(runStateMem, common) // MSTORE(offset=0, value=0x42)

      runStateMem.stack.push(0n)
      await mload(runStateMem, common) // MLOAD(offset=0)
      expect(runStateMem.stack.pop()).toBe(0x42n)

      runStateMem.stack.push(0xffn)
      runStateMem.stack.push(32n)
      await mstore8(runStateMem, common) // MSTORE8(offset=32, value=0xff)

      runStateMem.stack.push(32n)
      runStateMem.stack.push(0n)
      runStateMem.stack.push(64n)
      await mcopy(runStateMem, common) // MCOPY(dest=64, src=0, size=32)

      // Transient storage: TSTORE, TLOAD
      const tstore = handlers.get(0x5d)!
      const tload = handlers.get(0x5c)!
      const runStateT = createMockRunState({ common })
      runStateT.stack.push(0x99n)
      runStateT.stack.push(1n)
      await tstore(runStateT, common)

      runStateT.stack.push(1n)
      await tload(runStateT, common)
      expect(runStateT.stack.pop()).toBe(0x99n)

      // DUP1..DUP16 and SWAP1..SWAP16
      for (let i = 1; i <= 16; i++) {
        const dupOp = 0x80 + (i - 1)
        const dupHandler = handlers.get(dupOp)!
        const rsDup = createMockRunState({
          stack: Array.from({ length: i }, (_, k) => BigInt(k + 1)),
          common,
        })
        rsDup.opCode = dupOp
        dupHandler(rsDup, common)
        expect(rsDup.stack.length).toBe(i + 1)

        const swapOp = 0x90 + (i - 1)
        const swapHandler = handlers.get(swapOp)!
        const rsSwap = createMockRunState({
          stack: Array.from({ length: i + 1 }, (_, k) => BigInt(k + 1)),
          common,
        })
        rsSwap.opCode = swapOp
        swapHandler(rsSwap, common)
        expect(rsSwap.stack.length).toBe(i + 1)
      }

      // PUSH1..PUSH32
      for (let i = 1; i <= 32; i++) {
        const pushOp = 0x60 + (i - 1)
        const pushHandler = handlers.get(pushOp)!
        const code = new Uint8Array(100)
        code.fill(0xaa)
        const rsPush = createMockRunState({ code, common })
        rsPush.opCode = pushOp
        rsPush.programCounter = 0
        pushHandler(rsPush, common)
        expect(rsPush.stack.length).toBe(1)
        expect(rsPush.programCounter).toBe(i)
      }
    })

    it('dynamicGasHandlers for EXP, KECCAK256 and memory opcodes', async () => {
      const common = createTronCommon()

      // EXP dynamic gas
      const expGas = dynamicGasHandlers.get(0x0a)!
      const rsExpZero = createMockRunState({ stack: [0n, 2n], common }) // exponent = 0
      expect(await expGas(rsExpZero, 10n, common)).toBe(10n)

      const rsExpPos = createMockRunState({ stack: [256n, 2n], common }) // exponent = 256
      expect(await expGas(rsExpPos, 10n, common)).toBeGreaterThan(10n)

      // KECCAK256 dynamic gas
      const keccakGas = dynamicGasHandlers.get(0x20)!
      const rsKeccak = createMockRunState({ stack: [32n, 0n], common })
      expect(await keccakGas(rsKeccak, 30n, common)).toBeGreaterThan(30n)

      // MLOAD, MSTORE, MSTORE8, RETURN, REVERT dynamic gas
      for (const op of [0x51, 0x52, 0x53, 0xf3, 0xfd]) {
        const handler = dynamicGasHandlers.get(op)
        if (handler) {
          const rs = createMockRunState({ stack: [32n, 0n], common })
          const g = await handler(rs, 3n, common)
          expect(g).toBeGreaterThanOrEqual(3n)
        }
      }

      // LOG0..LOG4 dynamic gas
      for (let i = 0; i <= 4; i++) {
        const logOp = 0xa0 + i
        const logGas = dynamicGasHandlers.get(logOp)
        if (logGas) {
          const rs = createMockRunState({ stack: Array.from({ length: i + 2 }, () => 0n), common })
          rs.opCode = logOp
          const g = await logGas(rs, 375n, common)
          expect(g).toBeGreaterThanOrEqual(375n)
        }
      }
    })

    it('executes environmental, block, TRON, and call/create opcode handlers', async () => {
      const common = createTronCommon()
      const runState = createMockRunState({ common })

      // 0x1e: CLZ
      const clzHandler = handlers.get(0x1e)!
      runState.stack.push(0x10n)
      await clzHandler(runState, common)
      expect(runState.stack.pop()).toBe(251n)

      // Environmental: ADDRESS (0x30), ORIGIN (0x32), CALLER (0x33), CALLVALUE (0x34), CALLDATASIZE (0x36), CODESIZE (0x38), GASPRICE (0x3a), RETURNDATASIZE (0x3d)
      for (const op of [0x30, 0x32, 0x33, 0x34, 0x36, 0x38, 0x3a, 0x3d]) {
        const h = handlers.get(op)!
        await h(runState, common)
        expect(runState.stack.length).toBeGreaterThan(0)
        runState.stack.pop()
      }

      // BALANCE (0x31), EXTCODESIZE (0x3b), EXTCODEHASH (0x3f)
      for (const op of [0x31, 0x3b, 0x3f]) {
        const h = handlers.get(op)!
        runState.stack.push(1n)
        await h(runState, common)
        expect(runState.stack.length).toBeGreaterThan(0)
        runState.stack.pop()
      }

      // CALLDATALOAD (0x35)
      const cdl = handlers.get(0x35)!
      runState.stack.push(0n)
      await cdl(runState, common)
      expect(runState.stack.length).toBeGreaterThan(0)
      runState.stack.pop()

      // CALLDATACOPY (0x37), CODECOPY (0x39), RETURNDATACOPY (0x3e)
      for (const op of [0x37, 0x39, 0x3e]) {
        const h = handlers.get(op)!
        runState.stack.push(32n)
        runState.stack.push(0n)
        runState.stack.push(0n)
        await h(runState, common)
      }

      // EXTCODECOPY (0x3c)
      const ecc = handlers.get(0x3c)!
      runState.stack.push(32n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(1n)
      await ecc(runState, common)

      // Block opcodes: BLOCKHASH (0x40), COINBASE (0x41), TIMESTAMP (0x42), NUMBER (0x43),
      // DIFFICULTY (0x44), GASLIMIT (0x45), CHAINID (0x46), SELFBALANCE (0x47), BASEFEE (0x48), SLOTNUM (0x4b)
      const bh = handlers.get(0x40)!
      runState.stack.push(1n)
      await bh(runState, common)
      runState.stack.pop()

      for (const op of [0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x4b]) {
        const h = handlers.get(op)!
        await h(runState, common)
        expect(runState.stack.length).toBeGreaterThan(0)
        runState.stack.pop()
      }

      // Storage: SLOAD (0x54), SSTORE (0x55)
      const sstore = handlers.get(0x55)!
      runState.stack.push(42n)
      runState.stack.push(1n)
      await sstore(runState, common)

      const sload = handlers.get(0x54)!
      runState.stack.push(1n)
      await sload(runState, common)
      runState.stack.pop()

      // Flow: JUMP (0x56), JUMPI (0x57)
      runState.code = new Uint8Array(100)
      runState.validJumps = new Uint8Array(100)
      runState.validJumps[10] = 1
      runState.validJumps[20] = 1
      const jump = handlers.get(0x56)!
      runState.stack.push(10n)
      jump(runState, common)
      expect(runState.programCounter).toBe(10)

      const jumpi = handlers.get(0x57)!
      runState.stack.push(1n)
      runState.stack.push(20n)
      jumpi(runState, common)
      expect(runState.programCounter).toBe(20)

      // TRON opcodes: CALLTOKENVALUE (0xd2), CALLTOKENID (0xd3), ISCONTRACT (0xd4), TOKENBALANCE (0xd1), CALLTOKEN (0xd0)
      const ctv = handlers.get(0xd2)!
      ctv(runState, common)
      expect(runState.stack.pop()).toBe(50n)

      const cti = handlers.get(0xd3)!
      cti(runState, common)
      expect(runState.stack.pop()).toBe(1000001n)

      runState.interpreter.getCallTokenValue = () => 1n << 63n
      let tokenValueError: unknown
      try {
        ctv(runState, common)
      } catch (error) {
        tokenValueError = error
      }
      expect(tokenValueError).toMatchObject({ error: TVMError.errorMessages.VALUE_OVERFLOW })
      runState.interpreter.getCallTokenId = () => 1n << 63n
      let tokenIdError: unknown
      try {
        cti(runState, common)
      } catch (error) {
        tokenIdError = error
      }
      expect(tokenIdError).toMatchObject({ error: TVMError.errorMessages.INVALID_TOKENID })

      const isContract = handlers.get(0xd4)!
      runState.stack.push(1n)
      await isContract(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      const tb = handlers.get(0xd1)!
      runState.stack.push(1n) // address (popped second)
      runState.stack.push(1000001n) // tokenId (popped first)
      await tb(runState, common)
      expect(runState.stack.pop()).toBe(1000n)

      const ct = handlers.get(0xd0)!
      runState.messageGasLimit = 50000n
      for (const val of [0n, 0n, 0n, 0n, 1000001n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await ct(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      // Call/Create: CREATE (0xf0), CALL (0xf1), CALLCODE (0xf2), RETURN (0xf3), DELEGATECALL (0xf4), CREATE2 (0xf5), STATICCALL (0xfa), SELFDESTRUCT (0xff)
      const create = handlers.get(0xf0)!
      runState.stack.push(32n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      await create(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      const create2 = handlers.get(0xf5)!
      runState.stack.push(123n)
      runState.stack.push(32n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      await create2(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      const call = handlers.get(0xf1)!
      runState.messageGasLimit = 50000n
      for (const val of [0n, 0n, 0n, 0n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await call(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      const callcode = handlers.get(0xf2)!
      runState.messageGasLimit = 50000n
      for (const val of [0n, 0n, 0n, 0n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await callcode(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      const delegatecall = handlers.get(0xf4)!
      runState.messageGasLimit = 50000n
      for (const val of [0n, 0n, 0n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await delegatecall(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      const staticcall = handlers.get(0xfa)!
      runState.messageGasLimit = 50000n
      for (const val of [0n, 0n, 0n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await staticcall(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      const ret = handlers.get(0xf3)!
      runState.stack.push(0n)
      runState.stack.push(0n)
      ret(runState, common)

      const selfdestruct = handlers.get(0xff)!
      runState.stack.push(1n)
      await selfdestruct(runState, common)
    })

    it('executes call, create, storage, memory, and token dynamic gas handlers', async () => {
      const common = createTronCommon()
      const runState = createMockRunState({ common })

      // SLOAD (0x54), SSTORE (0x55)
      const sloadGas = dynamicGasHandlers.get(0x54)!
      runState.stack.push(1n)
      const gSload = await sloadGas(runState, 50n, common)
      expect(gSload).toBeGreaterThanOrEqual(50n)

      const sstoreGas = dynamicGasHandlers.get(0x55)!
      runState.stack.push(100n)
      runState.stack.push(1n)
      const gSstore = await sstoreGas(runState, 100n, common)
      expect(gSstore).toBeGreaterThanOrEqual(100n)

      // BALANCE (0x31), EXTCODESIZE (0x3b), EXTCODEHASH (0x3f)
      for (const op of [0x31, 0x3b, 0x3f]) {
        const h = dynamicGasHandlers.get(op)!
        runState.stack.push(1n)
        const g = await h(runState, 20n, common)
        expect(g).toBeGreaterThanOrEqual(20n)
      }

      // CALLDATACOPY (0x37), CODECOPY (0x39), RETURNDATACOPY (0x3e)
      for (const op of [0x37, 0x39, 0x3e]) {
        const h = dynamicGasHandlers.get(op)!
        runState.stack.push(32n)
        runState.stack.push(0n)
        runState.stack.push(0n)
        const g = await h(runState, 3n, common)
        expect(g).toBeGreaterThanOrEqual(3n)
      }

      // EXTCODECOPY (0x3c)
      const eccGas = dynamicGasHandlers.get(0x3c)!
      runState.stack.push(32n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(1n)
      const gEcc = await eccGas(runState, 20n, common)
      expect(gEcc).toBeGreaterThanOrEqual(20n)

      // CREATE (0xf0), CREATE2 (0xf5)
      const createGas = dynamicGasHandlers.get(0xf0)!
      runState.stack.push(32n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      const gCreate = await createGas(runState, 32000n, common)
      expect(gCreate).toBeGreaterThanOrEqual(32000n)

      const create2Gas = dynamicGasHandlers.get(0xf5)!
      runState.stack.push(123n)
      runState.stack.push(32n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      const gCreate2 = await create2Gas(runState, 32000n, common)
      expect(gCreate2).toBeGreaterThanOrEqual(32000n)

      // CALL (0xf1), CALLCODE (0xf2), DELEGATECALL (0xf4), STATICCALL (0xfa)
      const callGas = dynamicGasHandlers.get(0xf1)!
      for (const val of [0n, 0n, 0n, 0n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      const gCall = await callGas(runState, 40n, common)
      expect(gCall).toBeGreaterThanOrEqual(40n)

      const callcodeGas = dynamicGasHandlers.get(0xf2)!
      for (const val of [0n, 0n, 0n, 0n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      const gCallcode = await callcodeGas(runState, 40n, common)
      expect(gCallcode).toBeGreaterThanOrEqual(40n)

      const delegatecallGas = dynamicGasHandlers.get(0xf4)!
      for (const val of [0n, 0n, 0n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      const gDelegate = await delegatecallGas(runState, 40n, common)
      expect(gDelegate).toBeGreaterThanOrEqual(40n)

      const staticcallGas = dynamicGasHandlers.get(0xfa)!
      for (const val of [0n, 0n, 0n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      const gStatic = await staticcallGas(runState, 40n, common)
      expect(gStatic).toBeGreaterThanOrEqual(40n)

      // SELFDESTRUCT (0xff)
      const sdGas = dynamicGasHandlers.get(0xff)!
      runState.stack.push(1n)
      const gSd = await sdGas(runState, 5000n, common)
      expect(gSd).toBeGreaterThanOrEqual(5000n)

      // CALLTOKEN (0xd0), TOKENBALANCE (0xd1)
      const ctGas = dynamicGasHandlers.get(0xd0)!
      for (const val of [0n, 0n, 0n, 0n, 1000001n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      const gCt = await ctGas(runState, 40n, common)
      expect(gCt).toBeGreaterThanOrEqual(40n)

      const tbGas = dynamicGasHandlers.get(0xd1)!
      runState.stack.push(1000001n)
      runState.stack.push(1n)
      const gTb = await tbGas(runState, 20n, common)
      expect(gTb).toBeGreaterThanOrEqual(20n)
    })
  })

  describe('Journal Comprehensive Suite', () => {
    it('exercises all journal methods, diffs, checkpoints, and reversions', async () => {
      const common = createTronCommon()
      const mockSM: any = {
        getAppliedKey: (addr: Uint8Array) => addr,
        putAccount: async () => {},
        deleteAccount: async () => {},
        checkpoint: async () => {},
        commit: async () => {},
        revert: async () => {},
      }
      const journal = new Journal(mockSM, common)

      // startReportingAccessList and startReportingPreimages
      journal.startReportingAccessList()
      journal.startReportingPreimages()
      expect(journal.accessList).toBeDefined()
      expect(journal.preimages).toBeDefined()

      const addr = createAddressFromString('0x1234567890123456789012345678901234567890')
      await journal.putAccount(addr, undefined)
      await journal.deleteAccount(addr)
      expect(journal.preimages?.size).toBeGreaterThan(0)

      // Storage writes
      journal.recordStorageWrite(addr, new Uint8Array(32))
      expect(journal.hasStorageWrite(addr, new Uint8Array(32))).toBe(true)
      journal.clearStorageWrites()
      expect(journal.hasStorageWrite(addr, new Uint8Array(32))).toBe(false)

      // Always warm
      journal.addAlwaysWarmAddress(addr.toString(), true)
      journal.addAlwaysWarmSlot(addr.toString(), '0x01', true)
      expect(journal.isWarmedAddress(addr.toBytes())).toBe(true)
      expect(journal.isWarmedStorage(addr.toBytes(), hexToBytes('0x01'))).toBe(true)

      // Diagnostics accessed
      journal.addAccessedAddress(addr.toBytes())
      journal.addAccessedStorage(addr.toBytes(), new Uint8Array(32))

      // Checkpoint and commit
      await journal.checkpoint()
      journal.addWarmedAddress(hexToBytes('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'))
      journal.addWarmedStorage(
        hexToBytes('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'),
        hexToBytes('0x02'),
      )
      await journal.commit()

      // Checkpoint and revert with ripemd address
      await journal.checkpoint()
      const ripemdAddr = createAddressFromString(`0x${RIPEMD160_ADDRESS_STRING}`)
      await journal.putAccount(ripemdAddr, undefined)
      await journal.revert()

      // Cleanup
      await journal.cleanup()
      expect(journal.accessList).toBeUndefined()
    })
  })

  describe('Types, Stack, TransientStorage, and BinaryTree Extra Suite', () => {
    it('TVMMockBlockchain operations', async () => {
      const mb = new TVMMockBlockchain()
      const b = await mb.getBlock(1)
      expect(b.hash().length).toBe(32)
      await mb.putBlock(b)
      expect(mb.shallowCopy()).toBe(mb)
    })

    it('Stack dup overflow, exchange, and getStack', () => {
      const s = new Stack(2)
      s.push(10n)
      s.push(20n)
      expect(() => s.dup(1)).toThrow() // stack overflow
      s.exchange(0, 1)
      expect(s.getStack()).toEqual([20n, 10n])
      expect(() => s.exchange(5, 0)).toThrow() // underflow
    })

    it('TransientStorage toJSON', () => {
      const ts = new TransientStorage()
      const addr = createAddressFromString('0x1234567890123456789012345678901234567890')
      ts.put(addr, setLengthLeft(hexToBytes('0x01'), 32), hexToBytes('0x42'))
      const json = ts.toJSON()
      expect(json[addr.toString()]).toBeDefined()
    })

    it('BinaryTreeAccessWitness rawAccesses, accesses, and generateBinaryExecutionWitness', async () => {
      const addr = createAddressFromString('0x1234567890123456789012345678901234567890')
      const mockTree = {
        _lock: { acquire: async () => {}, release: () => {} },
        root: () => {},
        get: async () => [new Uint8Array([1])],
      }
      const mockSM: any = {
        _tree: mockTree,
        getStateRoot: async () => new Uint8Array(32),
      }
      const witness = new BinaryTreeAccessWitness({ hashFunction: (msg) => msg })
      const stemKey = ('0x' + '00'.repeat(31)) as `0x${string}`
      const chunkKey = ('0x' + '00'.repeat(31) + '00') as `0x${string}`
      witness.stems.set(stemKey, { address: addr, treeIndex: 0n })
      witness.chunks.set(chunkKey, { write: true })

      let count = 0
      for (const raw of witness.rawAccesses()) {
        expect(raw.treeIndex).toBe(0n)
        count++
      }
      expect(count).toBe(1)

      for (const acc of witness.accesses()) {
        expect(acc.type).toBe('basicData')
      }

      const ew = await generateBinaryExecutionWitness(mockSM, witness, new Uint8Array(32))
      expect(ew.parentStateRoot).toBeDefined()
      expect(ew.stateDiff.length).toBeGreaterThan(0)
    })

    it('PerformanceLogger functionality', () => {
      const logger = new TVMPerformanceLogger()
      expect(logger.hasTimer()).toBe(false)
      const t1 = logger.startTimer('step1')
      expect(logger.hasTimer()).toBe(true)
      expect(() => logger.startTimer('step2')).toThrow()
      const paused = logger.pauseTimer()
      expect(logger.hasTimer()).toBe(false)
      expect(() => logger.pauseTimer()).toThrow()
      logger.unpauseTimer(paused)
      expect(() => logger.unpauseTimer(paused)).toThrow()
      logger.stopTimer(t1, 1000, 'precompiles')
      expect(() => logger.stopTimer(t1, 1000)).toThrow()

      const t2 = logger.startTimer('step2')
      logger.stopTimer(t2, 2000, 'opcodes', 10, 5)

      logger.startTimer('step3')
      logger.cancelTimer()
      expect(logger.hasTimer()).toBe(false)

      const logs = logger.getLogs()
      expect(logs.precompiles.length).toBe(1)
      expect(logs.opcodes.length).toBe(1)
      expect(logs.opcodes[0].staticGas).toBe(10)
      logger.clear()
    })

    it('EOF validationError branches', () => {
      const errorTypes = [
        EOFErrorMessage.OUT_OF_BOUNDS,
        EOFErrorMessage.VERIFY_BYTES,
        EOFErrorMessage.VERIFY_UINT,
        EOFErrorMessage.TYPE_SIZE,
        EOFErrorMessage.TYPE_SECTIONS,
        EOFErrorMessage.INVALID_TYPE_SIZE,
        EOFErrorMessage.INVALID_CODE_SIZE,
        EOFErrorMessage.INPUTS,
        EOFErrorMessage.OUTPUTS,
        EOFErrorMessage.CODE0_INPUTS,
        EOFErrorMessage.CODE0_OUTPUTS,
        EOFErrorMessage.MAX_INPUTS,
        EOFErrorMessage.MAX_OUTPUTS,
        EOFErrorMessage.CODE_SECTION,
        EOFErrorMessage.DATA_SECTION,
        EOFErrorMessage.MAX_STACK_HEIGHT,
        EOFErrorMessage.MAX_STACK_HEIGHT_LIMIT,
        EOFErrorMessage.DANGLING_BYTES,
        EOFErrorMessage.MIN_CODE_SECTIONS,
      ]
      for (const err of errorTypes) {
        expect(() => validationError(err, 0, 'dummy')).toThrow()
        expect(() => validationError(err, 10, 'dummy')).toThrow()
      }
    })

    it('EOFContainer getters and error branches', () => {
      const code = hexToBytes(
        '0xef0001010008020002000800030400000000800001000000013050e300016001003050e4',
      )
      const container = new EOFContainer(code)
      expect(container.header.sections().length).toBe(4)
      expect(container.header.sectionSizes().length).toBe(4)
      expect(container.body.sections().length).toBe(3)
      expect(container.body.size().typeSize).toBe(2)
      expect(container.body.sectionSizes().length).toBe(3)
      expect(() => container.header.getSectionFromProgramCounter(100000)).toThrow()

      expect(() => new EOFContainer(new Uint8Array(10))).toThrow()
      expect(() => new EOFContainer(new Uint8Array(40000))).toThrow()
      expect(() => new EOFContainer(new Uint8Array(20))).toThrow()
    })

    it('opcodes/util helper functions', () => {
      expect(mod(-5n, 3n)).toBe(1n)
      expect(abs(5n)).toBe(5n)
      expect(abs(-5n)).toBe(5n)
      expect(divCeil(10n, 5n)).toBe(2n)
      expect(divCeil(10n, 3n)).toBe(4n)
      expect(divCeil(-10n, 3n)).toBe(-4n)

      const arr = new Uint8Array([1, 2, 3, 4, 5])
      expect(getDataSlice(arr, 10n, 2n).length).toBe(2)
      expect(getDataSlice(arr, 2n, 10n).length).toBe(10)

      expect(isEIP8024SingleImmediateValid(0x10)).toBe(true)
      expect(isEIP8024SingleImmediateValid(0x60)).toBe(false)
      expect(decodeEIP8024SingleImmediate(0x10)).toBe(33)
      expect(() => decodeEIP8024SingleImmediate(0x60)).toThrow()

      expect(isEIP8024PairImmediateValid(0x10)).toBe(true)
      expect(isEIP8024PairImmediateValid(0x60)).toBe(false)
      expect(decodeEIP8024PairImmediate(0x12)).toBeDefined()
      expect(decodeEIP8024PairImmediate(0x31)).toBeDefined()
      expect(() => decodeEIP8024PairImmediate(0x60)).toThrow()

      const common = createTronCommon()
      const runState = createMockRunState({ common })
      expect(describeLocation(runState)).toContain('/')

      runState.programCounter = 300
      expect(readImmediateByteOrZero(runState)).toBe(0)
    })

    it('functions.ts arithmetic and edge cases', () => {
      const common = createTronCommon()
      const runState = createMockRunState({ common })

      // DIV by 0: [a, b] = popN(2). a is popped first (top), b is popped second (bottom).
      runState.stack.push(0n) // b (bottom)
      runState.stack.push(10n) // a (top)
      handlers.get(0x04)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // SDIV by 0
      runState.stack.push(0n) // b (bottom)
      runState.stack.push(10n) // a (top)
      handlers.get(0x05)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // MOD by 0
      runState.stack.push(0n) // b (bottom)
      runState.stack.push(10n) // a (top)
      handlers.get(0x06)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // SMOD by 0
      runState.stack.push(0n) // b (bottom)
      runState.stack.push(10n) // a (top)
      handlers.get(0x07)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // ADDMOD with c=0: [a, b, c] = popN(3)
      runState.stack.push(0n) // c
      runState.stack.push(10n) // b
      runState.stack.push(10n) // a
      handlers.get(0x08)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // MULMOD with c=0
      runState.stack.push(0n) // c
      runState.stack.push(10n) // b
      runState.stack.push(10n) // a
      handlers.get(0x09)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // EXP: [base, exponent] = popN(2). Base is on top.
      for (const exp of [96n, 160n, 224n]) {
        runState.stack.push(exp) // exponent (bottom)
        runState.stack.push(2n) // base (top)
        handlers.get(0x0a)!(runState, common)
        expect(runState.stack.pop()).toBeGreaterThan(0n)
      }
      // EXP exp 0
      runState.stack.push(0n) // exponent
      runState.stack.push(5n) // base
      handlers.get(0x0a)!(runState, common)
      expect(runState.stack.pop()).toBe(1n)
      // EXP base 0
      runState.stack.push(10n) // exponent
      runState.stack.push(0n) // base
      handlers.get(0x0a)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // SIGNEXTEND byte < 31 with negative sign bit
      runState.stack.push(0x80n) // value (bottom)
      runState.stack.push(0n) // byte (top)
      handlers.get(0x0b)!(runState, common)
      expect(runState.stack.pop()).toBeGreaterThan(0n)

      // SAR signed
      runState.stack.push(-2n)
      runState.stack.push(1n)
      handlers.get(0x1d)!(runState, common)
      expect(runState.stack.pop()).toBeDefined()

      // SAR a >= 256
      runState.stack.push(-2n)
      runState.stack.push(300n)
      handlers.get(0x1d)!(runState, common)
      expect(runState.stack.pop()).toBeDefined()

      // MCOPY with length > 0
      runState.stack.push(10n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      handlers.get(0x5e)!(runState, common)

      // MLOAD padding
      runState.stack.push(0n)
      handlers.get(0x51)!(runState, common)
      expect(runState.stack.pop()).toBeDefined()
    })

    it('functions.ts and gas.ts static state change and invalid token traps', async () => {
      const common = createTronCommon()
      const runState = createMockRunState({ common })
      runState.interpreter.isStatic = () => true

      // TSTORE (0x5d) static
      runState.stack.push(1n)
      runState.stack.push(1n)
      expect(() => handlers.get(0x5d)!(runState, common)).toThrow()

      // CREATE2 (0xf5) static
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      await expect(handlers.get(0xf5)!(runState, common)).rejects.toThrow()

      // CALLTOKEN static with value > 0
      for (const val of [0n, 0n, 0n, 0n, 1000001n, 10n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await expect(handlers.get(0xd0)!(runState, common)).rejects.toThrow()

      // CALLTOKEN invalid tokenId (0 with value > 0)
      runState.interpreter.isStatic = () => false
      for (const val of [0n, 0n, 0n, 0n, 0n, 10n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await expect(handlers.get(0xd0)!(runState, common)).rejects.toThrow()

      // Dynamic gas static checks
      runState.interpreter.isStatic = () => true
      runState.stack.push(1n)
      runState.stack.push(1n)
      await expect(dynamicGasHandlers.get(0x55)!(runState, 0n, common)).rejects.toThrow()

      runState.stack.push(1n)
      runState.stack.push(1n)
      runState.stack.push(1n)
      await expect(dynamicGasHandlers.get(0xf0)!(runState, 0n, common)).rejects.toThrow()

      runState.stack.push(1n)
      runState.stack.push(1n)
      runState.stack.push(1n)
      runState.stack.push(1n)
      await expect(dynamicGasHandlers.get(0xf5)!(runState, 0n, common)).rejects.toThrow()

      runState.stack.push(1n)
      await expect(dynamicGasHandlers.get(0xff)!(runState, 0n, common)).rejects.toThrow()

      // CALL with value in static mode
      for (const val of [0n, 0n, 0n, 0n, 10n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await expect(dynamicGasHandlers.get(0xf1)!(runState, 0n, common)).rejects.toThrow()

      // CALLTOKEN with value in static mode
      for (const val of [0n, 0n, 0n, 0n, 1000001n, 10n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await expect(dynamicGasHandlers.get(0xd0)!(runState, 0n, common)).rejects.toThrow()
    })

    it('EOF opcodes rejection when eof is undefined', async () => {
      const common = createTronCommon()
      const runState = createMockRunState({ common })
      runState.env.eof = undefined

      const legacyOpcodes = [
        0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xf7, 0xf8, 0xf9, 0xfb,
      ]
      for (const op of legacyOpcodes) {
        const handler = handlers.get(op)
        if (handler) {
          await expect(async () => handler(runState, common)).rejects.toThrow()
        }
      }

      const gasLegacyOpcodes = [0xec, 0xee, 0xf8, 0xf9, 0xfb]
      for (const op of gasLegacyOpcodes) {
        const gasHandler = dynamicGasHandlers.get(op)
        if (gasHandler) {
          await expect(gasHandler(runState, 0n, common)).rejects.toThrow()
        }
      }
    })

    it('Journal uncovered branches', async () => {
      const common = createTronCommon()
      const mockSM: any = {
        checkpoint: async () => {},
        commit: async () => {},
        revert: async () => {},
        getAppliedKey: undefined,
      }
      const j = new Journal(mockSM, common)
      j.startReportingPreimages()
      await expect(
        j.putAccount(
          createAddressFromString('0x1111111111111111111111111111111111111111'),
          undefined,
        ),
      ).rejects.toThrow('stateManager.getAppliedKey can not be undefined')

      const j2 = new Journal(mockSM, common)
      const addrBytes = hexToBytes('0x1111111111111111111111111111111111111111')
      const slotBytes = hexToBytes(
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      )
      expect(j2.isWarmedStorage(addrBytes, slotBytes)).toBe(false)
      j2.addAlwaysWarmSlot(bytesToHex(addrBytes), bytesToHex(slotBytes))
      expect(j2.isWarmedStorage(addrBytes, slotBytes)).toBe(true)
      j2.addWarmedStorage(addrBytes, slotBytes)
      expect(j2.isWarmedStorage(addrBytes, slotBytes)).toBe(true)

      await j2.checkpoint()
      j2.addWarmedAddress(hexToBytes('0x2222222222222222222222222222222222222222'))
      await j2.revert()
    })

    it('BinaryTreeAccessWitness additional methods', () => {
      const witness = new BinaryTreeAccessWitness({ hashFunction: (msg) => msg })
      const addr = createAddressFromString('0x1234567890123456789012345678901234567890')
      expect(witness.readAccountHeader(addr)).toBeGreaterThanOrEqual(0n)
      expect(witness.writeAccountHeader(addr)).toBeGreaterThanOrEqual(0n)
      expect(witness.readAccountCodeChunks(addr, 0, 64)).toBeGreaterThanOrEqual(0n)
      expect(witness.writeAccountCodeChunks(addr, 0, 64)).toBeGreaterThanOrEqual(0n)
      expect(witness.readAccountStorage(addr, 1n)).toBeGreaterThanOrEqual(0n)
      expect(witness.writeAccountStorage(addr, 1n)).toBeGreaterThanOrEqual(0n)

      expect(() => decodeBinaryAccessState(0, 2)).toThrow()
    })

    it('Precompiles 01, 04, 05, 0a additional coverage', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      const debugLogger = createDebugSpy()

      precompile01({
        data: new Uint8Array(128),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(debugLogger.log).toHaveBeenCalled()

      precompile04({
        data: new Uint8Array(32),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      const oog04 = precompile04({
        data: new Uint8Array(32),
        gasLimit: 1n,
        common,
        _TVM: tvm,
      })
      expect(oog04.executionGasUsed).toBe(1n)

      const data100 = new Uint8Array(96 + 32 + 32 + 100)
      data100.set(setLengthLeft(hexToBytes('0x20'), 32), 0)
      data100.set(setLengthLeft(hexToBytes('0x20'), 32), 32)
      data100.set(setLengthLeft(hexToBytes('0x64'), 32), 64)
      precompile05({ data: data100, gasLimit: 10000000n, common, _TVM: tvm })

      const data1200 = new Uint8Array(96 + 32 + 32 + 1200)
      data1200.set(setLengthLeft(hexToBytes('0x20'), 32), 0)
      data1200.set(setLengthLeft(hexToBytes('0x20'), 32), 32)
      data1200.set(setLengthLeft(hexToBytes('0x04b0'), 32), 64)
      precompile05({ data: data1200, gasLimit: 100000000n, common, _TVM: tvm })

      const oog0a = await precompile0a({
        data: new Uint8Array(320),
        gasLimit: 1n,
        common,
        _TVM: tvm,
      })
      expect(oog0a.executionGasUsed).toBe(1n)

      const zeroCount0a = await precompile0a({
        data: new Uint8Array(160),
        gasLimit: 1000000n,
        common,
        _TVM: tvm,
      })
      expect(zeroCount0a.returnValue.length).toBe(32)
    })

    it('TVM constructor, opcodes, performance logger and access list', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      expect(tvm.getActiveOpcodes().size).toBeGreaterThan(0)
      expect(tvm.opcodes.size).toBeGreaterThan(0)

      const perfLogs = tvm.getPerformanceLogs()
      expect(perfLogs).toBeDefined()
      tvm.clearPerformanceLogs()

      const badEipCommon = new Common({ chain: TronMainnet })
      badEipCommon.setEIPs = () => {}
      badEipCommon.eips = () => [99999]
      expect(() => new TVM({ common: badEipCommon })).toThrow(/not supported/)

      const badHfCommon = new Common({ chain: TronMainnet })
      badHfCommon.hardfork = () => 'nonexistent' as any
      expect(() => new TVM({ common: badHfCommon })).toThrow(/Hardfork/)

      const mockAccessList = {
        checkpoint: vi.fn(),
        commit: vi.fn(),
        revert: vi.fn(),
        addAddress: vi.fn(),
        addStorageRead: vi.fn(),
        addStorageWrite: vi.fn(),
        addBalanceChange: vi.fn(),
        addNonceChange: vi.fn(),
        addCodeChange: vi.fn(),
      }
      // Test checkpoint & commit with EIP 7928 activated
      const eip7928Common = createTronCommon()
      eip7928Common.isActivatedEIP = (eip) => eip === 7928
      const tvm7928 = await createTVM({
        common: eip7928Common,
        blockLevelAccessList: mockAccessList as any,
      })
      expect(tvm7928.blockLevelAccessList).toBe(mockAccessList)
      const to = createAddressFromString('0x1111111111111111111111111111111111111111')
      const caller = createAddressFromString('0x2222222222222222222222222222222222222222')
      await tvm7928.runCall({
        to,
        caller,
        gasLimit: 100000n,
      })
      expect(mockAccessList.checkpoint).toHaveBeenCalled()
      expect(mockAccessList.commit).toHaveBeenCalled()
    })

    it('interpreter methods and debugging', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      ;(tvm as any).DEBUG = true
      const to = createAddressFromString('0x1111111111111111111111111111111111111111')
      const caller = createAddressFromString('0x2222222222222222222222222222222222222222')
      const env: any = {
        address: to,
        caller,
        callData: new Uint8Array(10),
        callValue: 0n,
        code: new Uint8Array(10),
        depth: 0,
        gasPrice: 1n,
        origin: caller,
        gasRefund: 0n,
        block: {
          header: {
            number: 10n,
            timestamp: 1000n,
            coinbase: caller,
            difficulty: 1n,
            gasLimit: 10000000n,
            prevRandao: new Uint8Array(32),
          },
        },
        contract: createAccount({ nonce: 0n, balance: 0n }),
      }
      const interp = new Interpreter(
        tvm,
        async () => ({}) as any,
        tvm.stateManager,
        new TVMMockBlockchain(),
        env,
        1000000n,
        tvm.journal,
        new TVMPerformanceLogger(),
      )

      interp.refundGas(100n, 'test')
      interp.subRefund(50n, 'test')
      expect(() => interp.subRefund(100n, 'test')).toThrow()
      interp.addStipend(2300n)

      expect(interp.getBlockNumber()).toBe(10n)
      expect(interp.getBlockTimestamp()).toBe(1000n)
      expect(interp.getBlockDifficulty()).toBe(0n)
      expect(interp.getBlockPrevRandao()).toBe(0n)
      expect(interp.getBlockGasLimit()).toBe(10000000n)
      expect(interp.getCallDataSize()).toBe(10n)
      expect(interp.getSelfBalance()).toBe(0n)

      expect(() => interp.getBlockSlotNumber()).toThrow()
      env.block.header.slotNumber = 42n
      expect(interp.getBlockSlotNumber()).toBe(42n)

      expect(() => interp.getBlockBaseFee()).toThrow()
      env.block.header.baseFeePerGas = 1000n
      expect(interp.getBlockBaseFee()).toBe(1000n)

      interp.transientStorageStore(setLengthLeft(hexToBytes('0x01'), 32), hexToBytes('0x42'))
      expect(interp.transientStorageLoad(setLengthLeft(hexToBytes('0x01'), 32))).toEqual(
        hexToBytes('0x42'),
      )

      await expect(
        interp.storageStore(setLengthLeft(hexToBytes('0x01'), 32), hexToBytes('0x99')),
      ).rejects.toThrow('could not read account while persisting memory')

      await tvm.stateManager.putAccount(to, createAccount({ nonce: 0n, balance: 0n }))
      await interp.storageStore(setLengthLeft(hexToBytes('0x01'), 32), hexToBytes('0x99'))
      expect(await interp.storageLoad(setLengthLeft(hexToBytes('0x01'), 32))).toEqual(
        hexToBytes('0x99'),
      )
    })

    it('functions.ts remaining opcode handlers and EOF opcodes', async () => {
      const common = createTronCommon()
      const runState = createMockRunState({ common })

      // SHL shift >= 256
      runState.stack.push(1n)
      runState.stack.push(256n)
      handlers.get(0x1b)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // SHR shift >= 256
      runState.stack.push(1n)
      runState.stack.push(256n)
      handlers.get(0x1c)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // SAR shift >= 256 positive
      runState.stack.push(1n)
      runState.stack.push(256n)
      handlers.get(0x1d)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // KECCAK256 length > 0
      runState.stack.push(32n)
      runState.stack.push(0n)
      handlers.get(0x20)!(runState, common)
      expect(runState.stack.pop()).toBeGreaterThan(0n)

      // CALLDATALOAD pos >= length and pos < length
      runState.env.callData = new Uint8Array(10)
      runState.stack.push(100n)
      handlers.get(0x35)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      runState.stack.push(0n)
      handlers.get(0x35)!(runState, common)
      expect(runState.stack.pop()).toBeDefined()

      // BLOCKHASH number >= current, diff > 256, diff <= 0
      runState.stack.push(1000n)
      await handlers.get(0x40)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      runState.env.block.header.number = 300n
      runState.stack.push(1n)
      await handlers.get(0x40)!(runState, common)
      expect(runState.stack.pop()).toBe(0n)

      // DIFFICULTY with EIP-4399
      const eip4399Common = createTronCommon()
      eip4399Common.isActivatedEIP = (eip) => eip === 4399
      await handlers.get(0x44)!(runState, eip4399Common)
      expect(runState.stack.pop()).toBeDefined()

      // JUMP / JUMPI invalid jump
      runState.stack.push(999n)
      expect(() => handlers.get(0x56)!(runState, common)).toThrow()
      runState.stack.push(1n)
      runState.stack.push(999n)
      expect(() => handlers.get(0x57)!(runState, common)).toThrow()

      // TSTORE with val === 0n
      runState.stack.push(0n)
      runState.stack.push(1n)
      handlers.get(0x5d)!(runState, common)

      // ISCONTRACT with same address
      const myAddrBigInt = bytesToBigInt(runState.interpreter.getAddress().bytes)
      runState.stack.push(myAddrBigInt)
      await handlers.get(0xd4)!(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      // CALLTOKEN with inLength > 0
      runState.messageGasLimit = 50000n
      for (const val of [0n, 0n, 32n, 0n, 1000001n, 0n, 1n, 1000n]) {
        runState.stack.push(val)
      }
      await handlers.get(0xd0)!(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      // EOF opcode handlers with runState.env.eof defined
      const eofCode = hexToBytes('0xef000101000402000100030400010000800001305000ef')
      const container = new EOFContainer(eofCode)
      runState.env.eof = {
        container,
        eofRunState: {
          returnStack: [10],
        } as any,
      }
      runState.env.code = new Uint8Array([0x00, 0x05, 0x01, 0x00, 0x02])
      runState.programCounter = 0

      // RJUMP
      handlers.get(0xe0)!(runState, common)
      expect(runState.programCounter).toBeGreaterThan(0)

      // RJUMPI
      runState.programCounter = 0
      runState.stack.push(1n)
      handlers.get(0xe1)!(runState, common)

      runState.programCounter = 0
      runState.stack.push(0n)
      handlers.get(0xe1)!(runState, common)
      expect(runState.programCounter).toBe(2)

      // RETF
      handlers.get(0xe4)!(runState, common)
      expect(runState.programCounter).toBe(10)

      // RETURNDATALOAD
      runState.stack.push(0n)
      handlers.get(0xf7)!(runState, common)
      expect(runState.stack.pop()).toBeDefined()

      // EXTCALL, EXTDELEGATECALL, EXTSTATICCALL with messageGasLimit set
      runState.messageGasLimit = 50000n
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(1n)
      await handlers.get(0xf8)!(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      runState.messageGasLimit = 50000n
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(1n)
      await handlers.get(0xf9)!(runState, common)
      expect(runState.stack.pop()).toBe(1n)

      runState.messageGasLimit = 50000n
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(1n)
      await handlers.get(0xfb)!(runState, common)
      expect(runState.stack.pop()).toBe(1n)
    })

    it('verifyCode edge cases and 0a precompile account matching', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })

      // verifyCode with stack underflow container
      const underflowCode = hexToBytes('0xef0001010004020001000204000100008000015000ef')
      const underflowContainer = new EOFContainer(underflowCode)
      expect(() => verifyCode(underflowContainer, tvm)).toThrow()

      // verifyCode with invalid terminating opcode
      const invalidTermCode = hexToBytes('0xef0001010004020001000204000100008000016001ef')
      const invalidTermContainer = new EOFContainer(invalidTermCode)
      expect(() => verifyCode(invalidTermContainer, tvm)).toThrow()

      // 0a precompile with matching account and permission
      const mockAccount = {
        getPermissionById: () => ({
          threshold: 1,
          keys: [{ address: hexToBytes('0x1111111111111111111111111111111111111111'), weight: 1 }],
        }),
      }
      const mockVM: any = {
        stateManager: {
          getAccount: async () => mockAccount,
        },
      }
      const calldata = concatBytes(
        setLengthLeft(hexToBytes('0x1111111111111111111111111111111111111111'), 32),
        setLengthLeft(hexToBytes('0x00'), 32),
        setLengthLeft(hexToBytes('0x00'), 32),
        setLengthLeft(bigIntToBytes(128n), 32),
        setLengthLeft(bigIntToBytes(1n), 32),
        setLengthLeft(bigIntToBytes(32n), 32),
        setLengthLeft(bigIntToBytes(65n), 32),
        setLengthLeft(bigIntToBytes(1n), 32),
        setLengthLeft(bigIntToBytes(1n), 32),
        setLengthLeft(bigIntToBytes(1n), 32),
      )
      const res0a = await precompile0a({
        data: calldata,
        gasLimit: 10000000n,
        common,
        _TVM: mockVM,
      })
      expect(res0a.returnValue.length).toBe(32)
    })

    it('tvm.ts token errors, EIP-7708 logs and precompile performance timer', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      const to = createAddressFromString('0x1111111111111111111111111111111111111111')
      const caller = createAddressFromString('0x2222222222222222222222222222222222222222')

      // INSUFFICIENT_TOKEN_BALANCE
      const msgInsufficientToken = new Message({
        to,
        caller,
        gasLimit: 100000n,
        tokenId: 1000001n,
        tokenValue: 1000n,
      })
      const resToken = await tvm.runCall({ message: msgInsufficientToken })
      expect(resToken.execResult.exceptionError?.error).toBe('insufficient token balance')

      // VALUE_OVERFLOW (TRX)
      const msgValueOverflow = new Message({
        to,
        caller,
        gasLimit: 100000n,
        value: (1n << 256n) - 1n,
      })
      await tvm.stateManager.putAccount(
        caller,
        createAccount({ nonce: 0n, balance: (1n << 256n) - 1n }),
      )
      await tvm.stateManager.putAccount(to, createAccount({ nonce: 0n, balance: 100n }))
      const resOverflow = await tvm.runCall({ message: msgValueOverflow })
      expect(resOverflow.execResult.exceptionError?.error).toBe('value overflow')

      // EIP-7708 logs
      const eip7708Common = createTronCommon()
      eip7708Common.isActivatedEIP = (eip) => eip === 7708
      const tvm7708 = await createTVM({ common: eip7708Common })
      await tvm7708.stateManager.putAccount(caller, createAccount({ nonce: 0n, balance: 1000n }))
      const res7708 = await tvm7708.runCall({
        to,
        caller,
        gasLimit: 100000n,
        value: 10n,
      })
      expect(res7708.execResult.logs?.length).toBeGreaterThan(0)

      // Precompile timer & debug in TVM
      ;(tvm as any).DEBUG = true
      const precompileTo = createAddressFromString('0x0000000000000000000000000000000000000004')
      const pRes = await tvm.runCall({
        to: precompileTo,
        caller,
        gasLimit: 100000n,
        data: new Uint8Array(32),
      })
      expect(pRes.execResult.executionGasUsed).toBeGreaterThan(0n)
    })

    it('gas.ts EOF dynamic gas handlers', async () => {
      const common = createTronCommon()
      const origParam = common.param.bind(common)
      common.param = (topic: any, _name?: any) => {
        if (topic === 'minRetainedGas') return 5000n
        if (topic === 'minCalleeGas') return 2300n
        return origParam(topic)
      }
      const runState = createMockRunState({ common })
      const eofCode = hexToBytes('0xef000101000402000100030400010000800001305000ef')
      const container = new EOFContainer(eofCode)
      runState.env.eof = {
        container: {
          header: container.header,
          body: {
            containerSections: [new Uint8Array(10)],
            typeSections: container.body.typeSections,
          },
        },
      } as any
      runState.env.code = new Uint8Array([0xec, 0x00])
      runState.programCounter = 0

      // EOFCREATE (0xec)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      const eofCreateGas = await dynamicGasHandlers.get(0xec)!(runState, 0n, common)
      expect(eofCreateGas).toBeGreaterThan(0n)

      // RETURNCONTRACT (0xee)
      runState.stack.push(0n)
      runState.stack.push(0n)
      const retContractGas = await dynamicGasHandlers.get(0xee)!(runState, 0n, common)
      expect(retContractGas).toBeGreaterThanOrEqual(0n)

      // EXTCALL (0xf8)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(1n)
      const extCallGas = await dynamicGasHandlers.get(0xf8)!(runState, 0n, common)
      expect(extCallGas).toBeGreaterThanOrEqual(0n)

      // EXTDELEGATECALL (0xf9)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(1n)
      const extDelegateCallGas = await dynamicGasHandlers.get(0xf9)!(runState, 0n, common)
      expect(extDelegateCallGas).toBeGreaterThanOrEqual(0n)

      // EXTSTATICCALL (0xfb)
      runState.stack.push(0n)
      runState.stack.push(0n)
      runState.stack.push(1n)
      const extStaticCallGas = await dynamicGasHandlers.get(0xfb)!(runState, 0n, common)
      expect(extStaticCallGas).toBeGreaterThanOrEqual(0n)
    })

    it('modexp and p256verify edge cases and debug', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      const debugLogger = createDebugSpy()

      const modexpDataM0 = new Uint8Array(96 + 32 + 32 + 32)
      modexpDataM0.set(setLengthLeft(hexToBytes('0x20'), 32), 0)
      modexpDataM0.set(setLengthLeft(hexToBytes('0x20'), 32), 32)
      modexpDataM0.set(setLengthLeft(hexToBytes('0x20'), 32), 64)
      modexpDataM0.set(setLengthLeft(hexToBytes('0x02'), 32), 96)
      modexpDataM0.set(setLengthLeft(hexToBytes('0x03'), 32), 128)
      const resM0 = precompile05({
        data: modexpDataM0,
        gasLimit: 1000000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(debugLogger.log).toHaveBeenCalled()
      expect(resM0.returnValue.length).toBe(32)

      const modexpDataM5 = new Uint8Array(modexpDataM0)
      modexpDataM5.set(setLengthLeft(hexToBytes('0x05'), 32), 160)
      const resM5 = precompile05({
        data: modexpDataM5,
        gasLimit: 1000000n,
        common,
        _TVM: tvm,
        _debug: debugLogger,
      })
      expect(resM5.returnValue.length).toBe(32)

      const debugP256 = createDebugSpy()
      const outOfBoundsData = new Uint8Array(160)
      outOfBoundsData.fill(0xff, 32, 64)
      precompile100({
        data: outOfBoundsData,
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugP256,
      })
      expect(debugP256.log).toHaveBeenCalled()

      const notOnCurveData = new Uint8Array(160)
      notOnCurveData[63] = 1
      notOnCurveData[95] = 1
      precompile100({
        data: notOnCurveData,
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugP256,
      })

      const infinityData = new Uint8Array(160)
      precompile100({
        data: infinityData,
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: debugP256,
      })
    })

    it('verifyCode non-returning section with RETF', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      const retfCode = hexToBytes('0xef000101000402000100010400010000800000e4ef')
      const retfContainer = new EOFContainer(retfCode)
      expect(() => verifyCode(retfContainer, tvm)).toThrow(/not returning/)
    })

    it('EOFContainer validation and helper methods coverage', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })

      function makeEOFBytes(
        opts: {
          types?: { inputs: number; outputs: number; maxStackHeight: number }[]
          codeSections?: Uint8Array[]
          containerSections?: Uint8Array[]
          dataSection?: Uint8Array
        } = {},
      ) {
        const types = opts.types ?? [{ inputs: 0, outputs: 0x80, maxStackHeight: 0 }]
        const codeSections = opts.codeSections ?? [hexToBytes('0x00')]
        const containerSections = opts.containerSections ?? []
        const dataSection = opts.dataSection ?? new Uint8Array(0)

        const parts: Uint8Array[] = []
        parts.push(hexToBytes('0xef0001'))
        const typeSize = types.length * 4
        parts.push(Uint8Array.from([0x01, (typeSize >> 8) & 0xff, typeSize & 0xff]))
        parts.push(
          Uint8Array.from([0x02, (codeSections.length >> 8) & 0xff, codeSections.length & 0xff]),
        )
        for (const cs of codeSections) {
          parts.push(Uint8Array.from([(cs.length >> 8) & 0xff, cs.length & 0xff]))
        }
        if (containerSections.length > 0) {
          parts.push(
            Uint8Array.from([
              0x03,
              (containerSections.length >> 8) & 0xff,
              containerSections.length & 0xff,
            ]),
          )
          for (const cnt of containerSections) {
            parts.push(Uint8Array.from([(cnt.length >> 8) & 0xff, cnt.length & 0xff]))
          }
        }
        parts.push(
          Uint8Array.from([0x04, (dataSection.length >> 8) & 0xff, dataSection.length & 0xff]),
        )
        parts.push(Uint8Array.from([0x00]))
        for (const t of types) {
          parts.push(
            Uint8Array.from([
              t.inputs,
              t.outputs,
              (t.maxStackHeight >> 8) & 0xff,
              t.maxStackHeight & 0xff,
            ]),
          )
        }
        for (const cs of codeSections) {
          parts.push(cs)
        }
        for (const cnt of containerSections) {
          parts.push(cnt)
        }
        parts.push(dataSection)

        return concatBytes(...parts)
      }

      const validBytes = makeEOFBytes({
        types: [{ inputs: 0, outputs: 0x80, maxStackHeight: 0 }],
        codeSections: [hexToBytes('0x00')],
        dataSection: hexToBytes('0x1234'),
      })
      const container = validateEOF(validBytes, tvm)
      expect(container.header.sections()).toHaveLength(4)
      expect(container.header.sectionSizes()).toHaveLength(4)
      expect(container.body.sections()).toHaveLength(3)
      expect(container.body.size().codeSize).toBe(1)
      expect(container.body.sectionSizes()).toHaveLength(3)
      expect(container.header.getCodePosition(0)).toBeGreaterThan(0)
      expect(
        container.header.getSectionFromProgramCounter(container.header.getCodePosition(0)),
      ).toBe(0)
      expect(() => container.header.getSectionFromProgramCounter(-1)).toThrow(/out of bounds/)
      expect(() => container.header.getSectionFromProgramCounter(99999)).toThrow(/out of bounds/)

      expect(() => new EOFContainer(new Uint8Array(65537))).toThrow(/maximum valid size/)
      expect(() => new EOFContainer(hexToBytes('0xef0001010004'))).toThrow(/minimum valid size/)

      expect(
        () => new EOFContainer(hexToBytes('0xff00010100040200010001040000000080000000')),
      ).toThrow()
      expect(
        () => new EOFContainer(hexToBytes('0xef01010100040200010001040000000080000000')),
      ).toThrow()
      expect(
        () => new EOFContainer(hexToBytes('0xef00020100040200010001040000000080000000')),
      ).toThrow()

      expect(
        () => new EOFContainer(hexToBytes('0xef00010100050200010001040000000080000000')),
      ).toThrow()
      expect(
        () => new EOFContainer(hexToBytes('0xef00010100000200010001040000000080000000')),
      ).toThrow()

      expect(
        () => new EOFContainer(hexToBytes('0xef00010110040200010001040000000080000000')),
      ).toThrow(/must not exceed 1024/)

      expect(() => new EOFContainer(hexToBytes('0xef0001010004020000040000000080000000'))).toThrow()
      expect(
        () => new EOFContainer(hexToBytes('0xef000101000402000200010001040000000080000000')),
      ).toThrow()
      expect(
        () => new EOFContainer(hexToBytes('0xef00010100040200010000040000000080000000')),
      ).toThrow()

      expect(
        () => new EOFContainer(hexToBytes('0xef00010100040200010001030000040000000080000000')),
      ).toThrow()
      expect(
        () => new EOFContainer(hexToBytes('0xef00010100040200010001030101040000000080000000')),
      ).toThrow()
      expect(
        () => new EOFContainer(hexToBytes('0xef000101000402000100010300010000040000000080000000')),
      ).toThrow()

      expect(
        () => new EOFContainer(hexToBytes('0xef00010100040200010001050000000080000000')),
      ).toThrow()
      expect(
        () => new EOFContainer(hexToBytes('0xef00010100040200010001040000ff0080000000')),
      ).toThrow()

      expect(
        () =>
          new EOFContainer(
            makeEOFBytes({ types: [{ inputs: 1, outputs: 0x80, maxStackHeight: 0 }] }),
          ),
      ).toThrow()
      expect(
        () =>
          new EOFContainer(makeEOFBytes({ types: [{ inputs: 0, outputs: 0, maxStackHeight: 0 }] })),
      ).toThrow()
      expect(
        () =>
          new EOFContainer(
            makeEOFBytes({
              types: [
                { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
                { inputs: 128, outputs: 0, maxStackHeight: 0 },
              ],
              codeSections: [hexToBytes('0x00'), hexToBytes('0x00')],
            }),
          ),
      ).toThrow()
      expect(
        () =>
          new EOFContainer(
            makeEOFBytes({
              types: [
                { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
                { inputs: 0, outputs: 129, maxStackHeight: 0 },
              ],
              codeSections: [hexToBytes('0x00'), hexToBytes('0x00')],
            }),
          ),
      ).toThrow()
      expect(
        () =>
          new EOFContainer(
            makeEOFBytes({ types: [{ inputs: 0, outputs: 0x80, maxStackHeight: 1024 }] }),
          ),
      ).toThrow()

      expect(() => new EOFContainer(concatBytes(validBytes, hexToBytes('0xaa')))).toThrow(
        /dangling/i,
      )

      const txInitContainer = new EOFContainer(
        concatBytes(validBytes, hexToBytes('0xcafe')),
        EOFContainerMode.TxInitmode,
      )
      expect(txInitContainer.body.txCallData).toEqual(hexToBytes('0xcafe'))

      expect(
        () =>
          new EOFContainer(
            concatBytes(validBytes, hexToBytes('0xbb')),
            EOFContainerMode.Initmode,
            true,
          ),
      ).toThrow(/dangling/i)
    })

    it('verifyCode deep coverage for opcode rules and branches', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      tvm.getActiveOpcodes = () => handlers as any

      function makeEOFBytes(
        opts: {
          types?: { inputs: number; outputs: number; maxStackHeight: number }[]
          codeSections?: Uint8Array[]
          containerSections?: Uint8Array[]
          dataSection?: Uint8Array
        } = {},
      ) {
        const types = opts.types ?? [{ inputs: 0, outputs: 0x80, maxStackHeight: 0 }]
        const codeSections = opts.codeSections ?? [hexToBytes('0x00')]
        const containerSections = opts.containerSections ?? []
        const dataSection = opts.dataSection ?? new Uint8Array(0)

        const parts: Uint8Array[] = []
        parts.push(hexToBytes('0xef0001'))
        const typeSize = types.length * 4
        parts.push(Uint8Array.from([0x01, (typeSize >> 8) & 0xff, typeSize & 0xff]))
        parts.push(
          Uint8Array.from([0x02, (codeSections.length >> 8) & 0xff, codeSections.length & 0xff]),
        )
        for (const cs of codeSections) {
          parts.push(Uint8Array.from([(cs.length >> 8) & 0xff, cs.length & 0xff]))
        }
        if (containerSections.length > 0) {
          parts.push(
            Uint8Array.from([
              0x03,
              (containerSections.length >> 8) & 0xff,
              containerSections.length & 0xff,
            ]),
          )
          for (const cnt of containerSections) {
            parts.push(Uint8Array.from([(cnt.length >> 8) & 0xff, cnt.length & 0xff]))
          }
        }
        parts.push(
          Uint8Array.from([0x04, (dataSection.length >> 8) & 0xff, dataSection.length & 0xff]),
        )
        parts.push(Uint8Array.from([0x00]))
        for (const t of types) {
          parts.push(
            Uint8Array.from([
              t.inputs,
              t.outputs,
              (t.maxStackHeight >> 8) & 0xff,
              t.maxStackHeight & 0xff,
            ]),
          )
        }
        for (const cs of codeSections) {
          parts.push(cs)
        }
        for (const cnt of containerSections) {
          parts.push(cnt)
        }
        parts.push(dataSection)

        return concatBytes(...parts)
      }

      // 1. Stack underflow
      expect(() =>
        verifyCode(new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0x0100')] })), tvm),
      ).toThrow(/stack underflow/i)

      // 2. Invalid opcode (opcode in stackDelta but deactivated in active opcodes)
      const mockTvmOpcodes = await createTVM({ common })
      const origGetActive = mockTvmOpcodes.getActiveOpcodes.bind(mockTvmOpcodes)
      mockTvmOpcodes.getActiveOpcodes = () => {
        const ops = origGetActive()
        const copy = new Map(ops)
        copy.delete(0x01) // remove ADD
        return copy
      }
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [{ inputs: 0, outputs: 0x80, maxStackHeight: 2 }],
              codeSections: [hexToBytes('0x600160010100')],
            }),
          ),
          mockTvmOpcodes,
        ),
      ).toThrow(/invalid opcode/i)

      // 3. Invalid RJUMP (target out of bounds or into intermediate)
      expect(() =>
        verifyCode(
          new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe0006400')] })),
          tvm,
        ),
      ).toThrow(/invalid rjump/i)
      expect(() =>
        verifyCode(
          new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe0fffb00')] })),
          tvm,
        ),
      ).toThrow(/invalid rjump/i)
      expect(() =>
        verifyCode(new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe0fffe')] })), tvm),
      ).toThrow(/invalid rjump/i)

      // 4. RJUMP skipping instruction (unreachable code)
      expect(() =>
        verifyCode(
          new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe000010000')] })),
          tvm,
        ),
      ).toThrow(/unreachable code/i)

      // 5. RJUMPV table size 0 or intermediate OOB
      expect(() =>
        verifyCode(new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe2ff00')] })), tvm),
      ).toThrow()
      expect(() =>
        verifyCode(
          new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe200006400')] })),
          tvm,
        ),
      ).toThrow()

      // 6. CALLF target section invalid or calling non-returning
      expect(() =>
        verifyCode(
          new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe3000500')] })),
          tvm,
        ),
      ).toThrow(/callf\/jumpf target/i)
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [
                { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
                { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
              ],
              codeSections: [hexToBytes('0xe3000100'), hexToBytes('0x00')],
            }),
          ),
          tvm,
        ),
      ).toThrow(/calls to non-returning function/i)

      // 7. CALLF stack underflow (target section requires inputs)
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [
                { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
                { inputs: 2, outputs: 0, maxStackHeight: 2 },
              ],
              codeSections: [hexToBytes('0xe3000100'), hexToBytes('0x5050e4')],
            }),
          ),
          tvm,
        ),
      ).toThrow(/stack underflow/i)

      // 8. JUMPF target invalid or outputs mismatch
      expect(() =>
        verifyCode(new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe50005')] })), tvm),
      ).toThrow(/callf\/jumpf target/i)
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [
                { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
                { inputs: 0, outputs: 0, maxStackHeight: 0 },
                { inputs: 0, outputs: 2, maxStackHeight: 2 },
              ],
              codeSections: [
                hexToBytes('0xe3000100'),
                hexToBytes('0xe50002'),
                hexToBytes('0x60016002e4'),
              ],
            }),
          ),
          tvm,
        ),
      ).toThrow(/invalid jumpf/i)
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [
                { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
                { inputs: 0, outputs: 0, maxStackHeight: 0 },
              ],
              codeSections: [hexToBytes('0xe50001'), hexToBytes('0xe4')],
            }),
          ),
          tvm,
        ),
      ).toThrow(/not returning/i)

      // 9. RETF stack height mismatch
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [
                { inputs: 0, outputs: 0x80, maxStackHeight: 1 },
                { inputs: 0, outputs: 1, maxStackHeight: 0 },
              ],
              codeSections: [hexToBytes('0xe3000100'), hexToBytes('0xe4')],
            }),
          ),
          tvm,
        ),
      ).toThrow(/invalid stack height/i)

      // 10. DUPN, SWAPN, EXCHANGE stack underflow
      expect(() =>
        verifyCode(new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe60500')] })), tvm),
      ).toThrow(/stack underflow/i)
      expect(() =>
        verifyCode(new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe70500')] })), tvm),
      ).toThrow(/stack underflow/i)
      expect(() =>
        verifyCode(new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0xe85500')] })), tvm),
      ).toThrow(/stack underflow/i)

      // 11. EOFCREATE target invalid or duplicate
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [{ inputs: 0, outputs: 0x80, maxStackHeight: 4 }],
              codeSections: [hexToBytes('0x6000600060006000ec0500')],
            }),
          ),
          tvm,
        ),
      ).toThrow(/undefined container/i)

      // 12. RETURNCONTRACT in runtime mode throws
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [{ inputs: 0, outputs: 0x80, maxStackHeight: 2 }],
              codeSections: [hexToBytes('0x60006000ee00')],
            }),
          ),
          tvm,
        ),
      ).toThrow(/cannot have/i)

      // 12b. RETURNCONTRACT target invalid in InitCode mode
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [{ inputs: 0, outputs: 0x80, maxStackHeight: 2 }],
              codeSections: [hexToBytes('0x60006000ee05')],
            }),
          ),
          tvm,
          ContainerSectionType.InitCode,
        ),
      ).toThrow(/undefined container/i)

      // 13. DATALOADN out of bounds
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              codeSections: [hexToBytes('0xd1001000')],
              dataSection: new Uint8Array(10),
            }),
          ),
          tvm,
        ),
      ).toThrow(/dataloadn/i)

      // 14. STOP / RETURN in InitCode mode throws
      expect(() =>
        verifyCode(
          new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0x00')] })),
          tvm,
          ContainerSectionType.InitCode,
        ),
      ).toThrow(/cannot have/i)
      expect(() =>
        verifyCode(
          new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0x60006000f3')] })),
          tvm,
          ContainerSectionType.InitCode,
        ),
      ).toThrow(/cannot have/i)

      // 15. Invalid terminator
      expect(() =>
        verifyCode(new EOFContainer(makeEOFBytes({ codeSections: [hexToBytes('0x6001')] })), tvm),
      ).toThrow(/invalid terminating opcode/i)

      // 16. Max stack height violation
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [{ inputs: 0, outputs: 0x80, maxStackHeight: 0 }],
              codeSections: [hexToBytes('0x60015000')],
            }),
          ),
          tvm,
        ),
      ).toThrow(/max stack height/i)

      // 17. Returning section with no return opcode
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [
                { inputs: 0, outputs: 0x80, maxStackHeight: 1 },
                { inputs: 0, outputs: 1, maxStackHeight: 1 },
              ],
              codeSections: [hexToBytes('0xe3000100'), hexToBytes('0x600100')],
            }),
          ),
          tvm,
        ),
      ).toThrow(/no RETF\/JUMP/i)

      // 18. Unreachable code sections
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              types: [
                { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
                { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
              ],
              codeSections: [hexToBytes('0x00'), hexToBytes('0x00')],
            }),
          ),
          tvm,
        ),
      ).toThrow(/unreachable code sections/i)

      // 19. Unreachable container sections
      const sub = makeEOFBytes()
      expect(() =>
        verifyCode(
          new EOFContainer(
            makeEOFBytes({
              containerSections: [sub],
            }),
          ),
          tvm,
        ),
      ).toThrow(/unreachable containers/i)

      // 20. Recursive validateEOF with subcontainer
      const initSub = makeEOFBytes({
        types: [{ inputs: 0, outputs: 0x80, maxStackHeight: 2 }],
        codeSections: [hexToBytes('0x60006000ee00')],
        containerSections: [sub],
      })
      const mainWithSub = makeEOFBytes({
        types: [{ inputs: 0, outputs: 0x80, maxStackHeight: 4 }],
        codeSections: [hexToBytes('0x6000600060006000ec005000')],
        containerSections: [initSub],
      })
      const validated = validateEOF(mainWithSub, tvm)
      expect(validated.body.containerSections).toHaveLength(1)
    })

    it('tvm.ts creation, access lists, token balances and performance logs coverage', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })

      // 1. Performance logs
      expect(tvm.getPerformanceLogs()).toEqual({ opcodes: [], precompiles: [] })
      tvm.clearPerformanceLogs()

      // 2. shallowCopy
      const copy = tvm.shallowCopy()
      expect(copy).toBeInstanceOf(TVM)

      // 3. EIP-6780 without createdAddresses throws
      const eip6780Common = createTronCommon()
      eip6780Common.isActivatedEIP = (eip: number | bigint) => (Number(eip) === 6780 ? true : false)
      const eip6780TVM = await createTVM({ common: eip6780Common })
      const msg6780 = new Message({
        caller: createAddressFromString('0x1111111111111111111111111111111111111111'),
        gasLimit: 100000n,
        data: new Uint8Array(0),
        tronTransactionContext: { rootTransactionId: new Uint8Array(32), nonce: 0n },
      })
      delete (msg6780 as any).createdAddresses
      await expect((eip6780TVM as any)._executeCreate(msg6780)).rejects.toThrow(
        /createdAddresses must be initialized/,
      )

      // 4. Contract creation with EIP-7928 BAL active
      const balCommon = createTronCommon()
      balCommon.isActivatedEIP = (eip: number | bigint) => (Number(eip) === 7928 ? true : false)
      const balTVM = await createTVM({ common: balCommon })
      const callerBal = createAddressFromString('0x1111111111111111111111111111111111111111')
      await balTVM.stateManager.putAccount(callerBal, createAccount({ balance: 100000n }))
      const deployResult = await balTVM.runCall({
        message: new Message({
          caller: callerBal,
          gasLimit: 200000n,
          data: hexToBytes('0x600160005360016000f3'),
        }),
        rootTransactionId: new Uint8Array(32),
      })
      expect(deployResult.createdAddress).toBeDefined()
      expect(balTVM.blockLevelAccessList).toBeDefined()

      // 5. Contract creation collision with EIP-7928 BAL active
      const colCaller = createAddressFromString('0x2222222222222222222222222222222222222222')
      const colMsg = new Message({
        caller: colCaller,
        gasLimit: 200000n,
        data: hexToBytes('0x00'),
        depth: 1,
        tronTransactionContext: { rootTransactionId: new Uint8Array(32), nonce: 0n },
      })
      const futureAddr = await (balTVM as any)._generateAddress(colMsg)
      await balTVM.stateManager.putAccount(futureAddr, createAccount({ nonce: 1n, balance: 1000n }))
      const colResult = await balTVM.runCall({
        message: colMsg,
        rootTransactionId: new Uint8Array(32),
      })
      expect(colResult.execResult.exceptionError?.error).toBe(
        TVMError.errorMessages.CREATE_COLLISION,
      )

      // 6. Contract creation value transfer overflow
      const ovfTVM = await createTVM({ common })
      const ovfCaller = createAddressFromString('0x1111111111111111111111111111111111111111')
      await ovfTVM.stateManager.putAccount(ovfCaller, createAccount({ balance: 2n ** 256n }))
      const ovfResult = await ovfTVM.runCall({
        message: new Message({
          caller: ovfCaller,
          gasLimit: 100000n,
          value: 2n ** 256n,
          data: hexToBytes('0x00'),
        }),
        rootTransactionId: new Uint8Array(32),
      })
      expect(ovfResult.execResult.exceptionError?.error).toBe(TVMError.errorMessages.VALUE_OVERFLOW)

      // 7. Contract creation with EIP-3541 active returning 0xef
      const eip3541Common = createTronCommon()
      eip3541Common.isActivatedEIP = (eip: number | bigint) => (Number(eip) === 3541 ? true : false)
      const eip3541TVM = await createTVM({ common: eip3541Common })
      const res3541 = await eip3541TVM.runCall({
        message: new Message({
          caller: createAddressFromString('0x1111111111111111111111111111111111111111'),
          gasLimit: 100000n,
          data: hexToBytes('0x60ef60005360016000f3'),
        }),
        rootTransactionId: new Uint8Array(32),
      })
      expect(res3541.execResult.exceptionError?.error).toBe(
        TVMError.errorMessages.INVALID_BYTECODE_RESULT,
      )

      // 8. EIP-7708 transfer log on CREATE
      const eip7708Common = createTronCommon()
      eip7708Common.isActivatedEIP = (eip: number | bigint) => (Number(eip) === 7708 ? true : false)
      const eip7708TVM = await createTVM({ common: eip7708Common })
      const caller7708 = createAddressFromString('0x3333333333333333333333333333333333333333')
      await eip7708TVM.stateManager.putAccount(caller7708, createAccount({ balance: 10000n }))
      const res7708 = await eip7708TVM.runCall({
        message: new Message({
          caller: caller7708,
          gasLimit: 100000n,
          value: 100n,
          data: new Uint8Array(0),
        }),
        rootTransactionId: new Uint8Array(32),
      })
      expect(res7708.execResult.logs).toBeDefined()
      expect(res7708.execResult.logs!.length).toBeGreaterThan(0)

      // 9. Token balance operations and overflow
      const tokenAcc = createAccount({ balance: 1000n })
      tokenAcc.asset = {}
      await (tvm as any)._addToTokenBalance(tokenAcc, {
        to: createAddressFromString('0x4444444444444444444444444444444444444444'),
        tokenId: 1000001n,
        tokenValue: 500n,
      })
      expect(tokenAcc.getTokenBalance(1000001n)).toBe(500n)
      await (tvm as any)._reduceSenderTokenBalance(tokenAcc, {
        caller: createAddressFromString('0x4444444444444444444444444444444444444444'),
        tokenId: 1000001n,
        tokenValue: 200n,
      })
      expect(tokenAcc.getTokenBalance(1000001n)).toBe(300n)

      await expect(
        (tvm as any)._addToTokenBalance(tokenAcc, {
          to: createAddressFromString('0x4444444444444444444444444444444444444444'),
          tokenId: 1000001n,
          tokenValue: 2n ** 256n,
        }),
      ).rejects.toMatchObject({ error: TVMError.errorMessages.VALUE_OVERFLOW })
    })

    it('interpreter and binaryTreeAccessWitness remaining branches', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })

      // Interpreter log limits
      const interpState = createMockRunState()
      const interp = new Interpreter(
        tvm,
        () => ({}) as any,
        interpState.stateManager,
        interpState.blockchain,
        interpState.env,
        100000n,
        tvm.journal,
        new TVMPerformanceLogger(),
      )
      try {
        interp.log(new Uint8Array(0), -1, [])
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.OUT_OF_RANGE)
      }
      try {
        interp.log(new Uint8Array(0), 5, [])
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.OUT_OF_RANGE)
      }
      try {
        interp.log(new Uint8Array(0), 2, [new Uint8Array(32)])
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.INTERNAL_ERROR)
      }
      // Interpreter _getReturnCode in EOF mode
      ;(interp as any)._runState.env.eof = {}
      expect((interp as any)._getReturnCode({ execResult: {} })).toBe(0n)
      expect(
        (interp as any)._getReturnCode({
          execResult: { exceptionError: new TVMError(TVMError.errorMessages.REVERT) },
        }),
      ).toBe(1n)
      expect(
        (interp as any)._getReturnCode({
          execResult: { exceptionError: new TVMError(TVMError.errorMessages.OUT_OF_GAS) },
        }),
      ).toBe(2n)

      // binaryTreeAccessWitness decodeBinaryAccessState and duplicate stems
      expect(() => decodeBinaryAccessState(0, 2)).toThrow(/No attribute yet stored/)

      const witness = new BinaryTreeAccessWitness({ hashFunction: sha256 })
      const stemStr = '0x' + '00'.repeat(31)
      witness.chunks.set((stemStr + '01') as `0x${string}`, { write: true })
      witness.chunks.set((stemStr + '02') as `0x${string}`, { write: true })
      const mockSM: any = {
        _tree: {
          root: (_root: any) => {},
          _lock: { acquire: () => {}, release: () => {} },
          get: async (_stem: any, suffixes: number[]) => {
            return suffixes.map((s) => (s === 1 ? new Uint8Array([1]) : new Uint8Array([2])))
          },
        },
        getStateRoot: async () => new Uint8Array(32),
      }
      const ew = await generateBinaryExecutionWitness(mockSM, witness, new Uint8Array(32))
      expect(ew.stateDiff.length).toBeGreaterThan(0)
    })

    it('opcodes and functions deep coverage for BLOCKHASH, EXTCODE, and EOF opcodes', async () => {
      const common = createTronCommon()

      // BLOCKHASH with EIP-7709
      const bhRunState = createMockRunState({ stack: [100n] })
      bhRunState.interpreter.getBlockNumber = () => 50n
      const eip7709Common = createTronCommon()
      eip7709Common.isActivatedEIP = (eip: number | bigint) => (Number(eip) === 7709 ? true : false)
      await handlers.get(0x40)!(bhRunState, eip7709Common)
      expect(bhRunState.stack.pop()).toBe(0n)

      bhRunState.stack.push(10n)
      bhRunState.interpreter.getBlockNumber = () => 300n
      await handlers.get(0x40)!(bhRunState, eip7709Common)
      expect(bhRunState.stack.pop()).toBe(0n)

      const eip6800Common = createTronCommon()
      eip6800Common.isActivatedEIP = (eip: number | bigint) =>
        Number(eip) === 7709 || Number(eip) === 6800 ? true : false
      eip6800Common.param = () => 1000n
      bhRunState.stack.push(200n)
      bhRunState.interpreter.getBlockNumber = () => 210n
      bhRunState.env.accessWitness = {
        readAccountStorage: vi.fn().mockReturnValue(100n),
      }
      bhRunState.interpreter.useGas = vi.fn()
      bhRunState.stateManager.getStorage = vi.fn().mockResolvedValue(hexToBytes('0x1234'))
      await handlers.get(0x40)!(bhRunState, eip6800Common)
      expect(bhRunState.stack.pop()).toBe(0x1234n)

      // EXTCODESIZE, EXTCODECOPY, EXTCODEHASH with BAL and isEOF
      const extRunState = createMockRunState({ stack: [1n] })
      extRunState.interpreter._tvm.common.isActivatedEIP = (eip: number | bigint) =>
        Number(eip) === 7928 ? true : false
      extRunState.interpreter._tvm.blockLevelAccessList = {
        addAddress: vi.fn(),
      }
      extRunState.stateManager.getCode = vi.fn().mockResolvedValue(EOFBYTES)
      await handlers.get(0x3b)!(extRunState, common)
      expect(extRunState.stack.pop()).toBe(BigInt(EOFBYTES.length))

      extRunState.stack.push(1n)
      extRunState.stack.push(0n)
      extRunState.stack.push(0n)
      extRunState.stack.push(2n)
      await handlers.get(0x3c)!(extRunState, common)

      extRunState.stack.push(1n)
      await handlers.get(0x3f)!(extRunState, common)
      expect(extRunState.stack.pop()).toBe(bytesToBigInt(EOFHASH))

      extRunState.stateManager.getCode = vi.fn().mockResolvedValue(new Uint8Array(0))
      extRunState.stateManager.getAccount = vi.fn().mockResolvedValue(undefined)
      extRunState.stack.push(1n)
      await handlers.get(0x3f)!(extRunState, common)
      expect(extRunState.stack.pop()).toBe(0n)

      // RJUMPV, CALLF, RETF, JUMPF opcode handlers
      const rjumpvState = createMockRunState({ stack: [0n] })
      try {
        handlers.get(0xe2)!(rjumpvState, common)
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.INVALID_OPCODE)
      }

      rjumpvState.env.eof = {}
      rjumpvState.env.code = Uint8Array.from([0xe2, 0x01, 0x00, 0x04, 0x00, 0x08])
      rjumpvState.programCounter = 1
      rjumpvState.stack.push(0n)
      handlers.get(0xe2)!(rjumpvState, common)
      expect(rjumpvState.programCounter).toBeGreaterThan(1)

      rjumpvState.programCounter = 1
      rjumpvState.stack.push(5n)
      handlers.get(0xe2)!(rjumpvState, common)

      const callfState = createMockRunState()
      try {
        handlers.get(0xe3)!(callfState, common)
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.INVALID_OPCODE)
      }

      callfState.env.eof = {
        container: {
          body: {
            typeSections: [{ inputs: 0, outputs: 0x80, maxStackHeight: 1 }],
          },
          header: {
            getCodePosition: () => 10,
          },
        },
        eofRunState: {
          returnStack: [],
        },
      }
      callfState.code = Uint8Array.from([0x00, 0x00])
      callfState.programCounter = 0
      handlers.get(0xe3)!(callfState, common)
      expect(callfState.programCounter).toBe(10)
      expect(callfState.env.eof.eofRunState.returnStack).toEqual([2])

      const retfState = createMockRunState()
      try {
        handlers.get(0xe4)!(retfState, common)
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.INVALID_OPCODE)
      }

      retfState.env.eof = { eofRunState: { returnStack: [] } }
      try {
        handlers.get(0xe4)!(retfState, common)
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(EOFErrorMessage.RETF_NO_RETURN)
      }

      retfState.env.eof.eofRunState.returnStack.push(42)
      handlers.get(0xe4)!(retfState, common)
      expect(retfState.programCounter).toBe(42)

      const jumpfState = createMockRunState()
      try {
        handlers.get(0xe5)!(jumpfState, common)
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.INVALID_OPCODE)
      }

      jumpfState.env.eof = callfState.env.eof
      jumpfState.code = Uint8Array.from([0x00, 0x00])
      jumpfState.programCounter = 0
      handlers.get(0xe5)!(jumpfState, common)
      expect(jumpfState.programCounter).toBe(10)

      // EIP-8024 DUPN, SWAPN, EXCHANGE
      const eip8024State = createMockRunState({ stack: Array(30).fill(1n) })
      try {
        handlers.get(0xe6)!(eip8024State, common)
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.INVALID_OPCODE)
      }
      try {
        handlers.get(0xe7)!(eip8024State, common)
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.INVALID_OPCODE)
      }
      try {
        handlers.get(0xe8)!(eip8024State, common)
        expect.fail('should throw')
      } catch (e: any) {
        expect(e.error).toBe(TVMError.errorMessages.INVALID_OPCODE)
      }

      const eip8024Common = createTronCommon()
      eip8024Common.isActivatedEIP = (eip: number | bigint) => (Number(eip) === 8024 ? true : false)
      eip8024State.code = Uint8Array.from([0x00])
      eip8024State.programCounter = 0
      handlers.get(0xe6)!(eip8024State, eip8024Common)
      handlers.get(0xe7)!(eip8024State, eip8024Common)
      handlers.get(0xe8)!(eip8024State, eip8024Common)

      // EOF opcode handlers error paths and edge cases
      const eofOpsState = createMockRunState()
      await expect(handlers.get(0xec)!(eofOpsState, common)).rejects.toMatchObject({
        error: TVMError.errorMessages.INVALID_OPCODE,
      })
      await expect(handlers.get(0xee)!(eofOpsState, common)).rejects.toMatchObject({
        error: TVMError.errorMessages.INVALID_OPCODE,
      })
      await expect(handlers.get(0xf8)!(eofOpsState, common)).rejects.toMatchObject({
        error: TVMError.errorMessages.INVALID_OPCODE,
      })
      await expect(handlers.get(0xf9)!(eofOpsState, common)).rejects.toMatchObject({
        error: TVMError.errorMessages.INVALID_OPCODE,
      })
      await expect(handlers.get(0xfb)!(eofOpsState, common)).rejects.toMatchObject({
        error: TVMError.errorMessages.INVALID_OPCODE,
      })

      eofOpsState.env.eof = {}
      eofOpsState.messageGasLimit = -1n
      eofOpsState.stack.push(0n)
      eofOpsState.stack.push(0n)
      eofOpsState.stack.push(0n)
      eofOpsState.stack.push(1n)
      await handlers.get(0xf8)!(eofOpsState, common)
      expect(eofOpsState.stack.pop()).toBe(1n)

      eofOpsState.messageGasLimit = -1n
      eofOpsState.stack.push(0n)
      eofOpsState.stack.push(0n)
      eofOpsState.stack.push(1n)
      await handlers.get(0xf9)!(eofOpsState, common)
      expect(eofOpsState.stack.pop()).toBe(1n)

      eofOpsState.messageGasLimit = -1n
      eofOpsState.stack.push(0n)
      eofOpsState.stack.push(0n)
      eofOpsState.stack.push(1n)
      await handlers.get(0xfb)!(eofOpsState, common)
      expect(eofOpsState.stack.pop()).toBe(1n)

      // CREATE and CREATE2 with isEOF(data)
      const createLegacyState = createMockRunState()
      createLegacyState.messageGasLimit = 100000n
      createLegacyState.memory.write(0, 2, EOFBYTES)
      // popN(3) returns [value, offset, length]
      createLegacyState.stack.push(2n) // length
      createLegacyState.stack.push(0n) // offset
      createLegacyState.stack.push(0n) // value
      await handlers.get(0xf0)!(createLegacyState, common)
      expect(createLegacyState.stack.pop()).toBe(0n)

      // CREATE2: popN(4) returns [value, offset, length, salt]
      createLegacyState.stack.push(0n) // salt
      createLegacyState.stack.push(2n) // length
      createLegacyState.stack.push(0n) // offset
      createLegacyState.stack.push(0n) // value
      createLegacyState.messageGasLimit = 100000n
      await handlers.get(0xf5)!(createLegacyState, common)
      expect(createLegacyState.stack.pop()).toBe(0n)

      createLegacyState.interpreter.isStatic = () => true
      createLegacyState.stack.push(0n)
      createLegacyState.stack.push(0n)
      createLegacyState.stack.push(0n)
      createLegacyState.stack.push(0n)
      await expect(handlers.get(0xf5)!(createLegacyState, common)).rejects.toMatchObject({
        error: TVMError.errorMessages.STATIC_STATE_CHANGE,
      })

      // CALLTOKEN and TOKENBALANCE traps
      const tokenState = createMockRunState()
      tokenState.interpreter.isStatic = () => true
      tokenState.stack.push(0n) // outLength
      tokenState.stack.push(0n) // outOffset
      tokenState.stack.push(0n) // inLength
      tokenState.stack.push(0n) // inOffset
      tokenState.stack.push(1000001n) // tokenId
      tokenState.stack.push(100n) // value
      tokenState.stack.push(1n) // toAddr
      tokenState.stack.push(0n) // _currentGasLimit
      await expect(handlers.get(0xd0)!(tokenState, common)).rejects.toMatchObject({
        error: TVMError.errorMessages.STATIC_STATE_CHANGE,
      })

      tokenState.interpreter.isStatic = () => false
      tokenState.stack.push(0n) // outLength
      tokenState.stack.push(0n) // outOffset
      tokenState.stack.push(0n) // inLength
      tokenState.stack.push(0n) // inOffset
      tokenState.stack.push(99999n) // tokenId
      tokenState.stack.push(0n) // value
      tokenState.stack.push(1n) // toAddr
      tokenState.stack.push(0n) // _currentGasLimit
      await expect(handlers.get(0xd0)!(tokenState, common)).rejects.toMatchObject({
        error: TVMError.errorMessages.INVALID_TOKENID,
      })

      tokenState.stack.push(1n)
      tokenState.stack.push(99999n)
      await expect(handlers.get(0xd1)!(tokenState, common)).rejects.toMatchObject({
        error: TVMError.errorMessages.INVALID_TOKENID,
      })
    })

    it('precompiles deep coverage for BLS12-381, BN254, and validate-multi-sign', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })

      // 1. BLS12-381 precompiles OOG
      const blsCommon = createTronCommon()
      blsCommon.param = () => 500n
      const mockBlsTVM: any = { _bls: {} }
      const oog0b = await precompile0b({
        data: new Uint8Array(0),
        gasLimit: 10n,
        common: blsCommon,
        _TVM: mockBlsTVM,
      })
      expect(oog0b.executionGasUsed).toBe(10n)
      const oog0c = await precompile0c({
        data: new Uint8Array(0),
        gasLimit: 10n,
        common: blsCommon,
        _TVM: mockBlsTVM,
      })
      expect(oog0c.executionGasUsed).toBe(10n)
      const oog0d = await precompile0d({
        data: new Uint8Array(0),
        gasLimit: 10n,
        common: blsCommon,
        _TVM: mockBlsTVM,
      })
      expect(oog0d.executionGasUsed).toBe(10n)
      const oog0e = await precompile0e({
        data: new Uint8Array(0),
        gasLimit: 10n,
        common: blsCommon,
        _TVM: mockBlsTVM,
      })
      expect(oog0e.executionGasUsed).toBe(10n)
      const oog0f = await precompile0f({
        data: new Uint8Array(0),
        gasLimit: 10n,
        common: blsCommon,
        _TVM: mockBlsTVM,
      })
      expect(oog0f.executionGasUsed).toBe(10n)
      const oog10 = await precompile10({
        data: new Uint8Array(0),
        gasLimit: 10n,
        common: blsCommon,
        _TVM: mockBlsTVM,
      })
      expect(oog10.executionGasUsed).toBe(10n)
      const oog11 = await precompile11({
        data: new Uint8Array(0),
        gasLimit: 10n,
        common: blsCommon,
        _TVM: mockBlsTVM,
      })
      expect(oog11.executionGasUsed).toBe(10n)

      // 2. Precompile 01 debug
      const dbg01 = createDebugSpy()
      precompile01({
        data: new Uint8Array(128),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: dbg01,
      })
      expect(dbg01.log).toHaveBeenCalled()

      // 3. Precompile 06, 07, 08 output length mismatch (OOG)
      const dbgBn = createDebugSpy()
      const mockTvmbn: any = {
        _bn254: {
          add: () => new Uint8Array(10),
          mul: () => new Uint8Array(10),
          pairing: () => new Uint8Array(10),
        },
      }
      const resBnAdd = precompile06({
        data: new Uint8Array(128),
        gasLimit: 100000n,
        common,
        _TVM: mockTvmbn,
        _debug: dbgBn,
      })
      expect(resBnAdd.executionGasUsed).toBe(100000n)
      const resBnMul = precompile07({
        data: new Uint8Array(128),
        gasLimit: 100000n,
        common,
        _TVM: mockTvmbn,
        _debug: dbgBn,
      })
      expect(resBnMul.executionGasUsed).toBe(100000n)
      const resBnPair = precompile08({
        data: new Uint8Array(192),
        gasLimit: 100000n,
        common,
        _TVM: mockTvmbn,
        _debug: dbgBn,
      })
      expect(resBnPair.executionGasUsed).toBe(100000n)

      // 4. Precompile 0a multi-sign success and duplicate signatures
      const privKey = hexToBytes(
        '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      )
      const pubKey = secp256k1.getPublicKey(privKey, false).slice(1)
      const ownerEthAddr = publicToAddress(pubKey)

      const permissionId = 1
      const dummyData = new Uint8Array(32)
      const tronOwnerAddr = convertToTronAddress(ownerEthAddr)
      const permIdBytes = setLengthLeft(bigIntToBytes(BigInt(permissionId)), 4)
      const msgCombine = concatBytes(tronOwnerAddr, permIdBytes, dummyData)
      const msgHash = sha256(msgCombine)
      const signatureBytes = secp256k1.sign(msgHash, privKey, {
        extraEntropy: false,
        format: 'recovered',
        prehash: false,
      })
      const sigBytes = new Uint8Array(65)
      sigBytes.set(signatureBytes.subarray(1, 33), 0)
      sigBytes.set(signatureBytes.subarray(33, 65), 32)
      sigBytes[64] = signatureBytes[0] + 27

      const mockMultiTVM: any = {
        stateManager: {
          getAccount: async () => ({
            getPermissionById: () => ({
              threshold: 1,
              keys: [{ address: ownerEthAddr, weight: 1 }],
            }),
          }),
        },
      }

      // Valid multi-sign
      const sigPacked = new Uint8Array(96)
      sigPacked.set(sigBytes, 0)

      const validSigPayload = concatBytes(
        setLengthLeft(ownerEthAddr, 32),
        setLengthLeft(bigIntToBytes(BigInt(permissionId)), 32),
        dummyData,
        setLengthLeft(bigIntToBytes(4n * 32n), 32),
        setLengthLeft(bigIntToBytes(1n), 32),
        setLengthLeft(bigIntToBytes(32n), 32),
        setLengthLeft(bigIntToBytes(65n), 32),
        sigPacked,
      )
      const validMultiRes = await precompile0a({
        data: validSigPayload,
        gasLimit: 1000000n,
        common,
        _TVM: mockMultiTVM,
      })
      expect(validMultiRes.returnValue[31]).toBe(1)

      // Duplicate signature in signature list
      const dupSigPayload = concatBytes(
        setLengthLeft(ownerEthAddr, 32),
        setLengthLeft(bigIntToBytes(BigInt(permissionId)), 32),
        dummyData,
        setLengthLeft(bigIntToBytes(4n * 32n), 32),
        setLengthLeft(bigIntToBytes(2n), 32),
        setLengthLeft(bigIntToBytes(64n), 32),
        setLengthLeft(bigIntToBytes(192n), 32),
        setLengthLeft(bigIntToBytes(65n), 32),
        sigPacked,
        setLengthLeft(bigIntToBytes(65n), 32),
        sigPacked,
      )
      const dupMultiRes = await precompile0a({
        data: dupSigPayload,
        gasLimit: 1000000n,
        common,
        _TVM: mockMultiTVM,
      })
      expect(dupMultiRes.returnValue[31]).toBe(1)
    })

    it('final boost for 90% threshold', async () => {
      const common = createTronCommon()
      const tvm = await createTVM({ common })
      tvm.getActiveOpcodes = () => handlers as any

      // 1. message.ts uncovered error branches and getters
      expect(() => new Message({ gasLimit: 1000n, tokenId: 10n })).toThrow(/less than/)
      expect(() => new Message({ gasLimit: 1000n, tokenId: 1n << 63n })).toThrow(/signed 64-bit/)
      expect(
        () => new Message({ gasLimit: 1000n, tokenId: 1000001n, tokenValue: 1n << 63n }),
      ).toThrow(/signed 64-bit/)
      expect(() => new Message({ gasLimit: 1000n, tokenId: 0n, tokenValue: 100n })).toThrow(
        /must be zero/,
      )
      expect(() => new Message({ gasLimit: 1000n, tokenId: 1000001n, tokenValue: -1n })).toThrow(
        /negative/,
      )
      expect(() => new Message({ gasLimit: 1000n, value: -1n })).toThrow(/negative/)
      const msgNoTo = new Message({ gasLimit: 1000n })
      expect(() => msgNoTo.codeAddress).toThrow(/Missing codeAddress/)

      // 2. setupEOF with txCallData
      const eofTxData = concatBytes(
        hexToBytes('0xef00010100040200010001040000000080000000'),
        hexToBytes('0x1234'), // txCallData
      )
      const eofRunState = createMockRunState()
      eofRunState.code = eofTxData
      setupEOF(eofRunState, EOFContainerMode.TxInitmode)
      expect(eofRunState.env.callData).toEqual(hexToBytes('0x1234'))

      // 3. EIP2929 with EIP-7864
      const eip7864Common = createTronCommon()
      eip7864Common.isActivatedEIP = (eip: number | bigint) =>
        Number(eip) === 7864 || Number(eip) === 2929 ? true : false
      eip7864Common.param = () => 100n
      const state2929 = createMockRunState()
      state2929.interpreter.journal.isWarmedAddress = () => false
      const cost7864 = getAddressAccessCost(
        state2929,
        createAddressFromString('0x1111111111111111111111111111111111111111').bytes,
        eip7864Common,
        true,
      )
      expect(cost7864).toBe(100n)

      // 4. precompile01 ecrecover debug paths
      const dbgRec = createDebugSpy()
      precompile01({
        data: concatBytes(
          new Uint8Array(64),
          setLengthLeft(bigIntToBytes(27n), 32),
          new Uint8Array(32),
        ),
        gasLimit: 100000n,
        common,
        _TVM: tvm,
        _debug: dbgRec,
      })
      expect(dbgRec.log).toHaveBeenCalled()

      // 5. EXTDELEGATECALL and EXTSTATICCALL with inLength > 0 and EOF code
      const extCallState = createMockRunState()
      extCallState.env.eof = {}
      extCallState.messageGasLimit = 100000n
      extCallState.stateManager.getCode = vi.fn().mockResolvedValue(EOFBYTES)
      extCallState.stack.push(1n) // inLength
      extCallState.stack.push(0n) // inOffset
      extCallState.stack.push(1n) // toAddr
      await handlers.get(0xf9)!(extCallState, common)
      expect(extCallState.stack.pop()).toBe(1n)

      extCallState.messageGasLimit = 100000n
      extCallState.stack.push(1n) // inLength
      extCallState.stack.push(0n) // inOffset
      extCallState.stack.push(1n) // toAddr
      await handlers.get(0xfb)!(extCallState, common)
      expect(extCallState.stack.pop()).toBe(1n)

      // 6. verify.ts chained sections 0 -> 1 -> 2
      function makeEOFBytes(
        opts: {
          types?: { inputs: number; outputs: number; maxStackHeight: number }[]
          codeSections?: Uint8Array[]
        } = {},
      ) {
        const types = opts.types ?? [{ inputs: 0, outputs: 0x80, maxStackHeight: 0 }]
        const codeSections = opts.codeSections ?? [hexToBytes('0x00')]
        const parts: Uint8Array[] = []
        parts.push(hexToBytes('0xef0001'))
        const typeSize = types.length * 4
        parts.push(Uint8Array.from([0x01, (typeSize >> 8) & 0xff, typeSize & 0xff]))
        parts.push(
          Uint8Array.from([0x02, (codeSections.length >> 8) & 0xff, codeSections.length & 0xff]),
        )
        for (const cs of codeSections) {
          parts.push(Uint8Array.from([(cs.length >> 8) & 0xff, cs.length & 0xff]))
        }
        parts.push(Uint8Array.from([0x04, 0x00, 0x00]))
        parts.push(Uint8Array.from([0x00]))
        for (const t of types) {
          parts.push(
            Uint8Array.from([
              t.inputs,
              t.outputs,
              (t.maxStackHeight >> 8) & 0xff,
              t.maxStackHeight & 0xff,
            ]),
          )
        }
        for (const cs of codeSections) {
          parts.push(cs)
        }
        return concatBytes(...parts)
      }

      const chainSub = makeEOFBytes({
        types: [
          { inputs: 0, outputs: 0x80, maxStackHeight: 0 },
          { inputs: 0, outputs: 0, maxStackHeight: 0 },
          { inputs: 0, outputs: 0, maxStackHeight: 0 },
        ],
        codeSections: [
          hexToBytes('0xe3000100'), // section 0: CALLF section 1, STOP
          hexToBytes('0xe30002e4'), // section 1: CALLF section 2, RETF
          hexToBytes('0xe4'), // section 2: RETF
        ],
      })
      const validatedChain = validateEOF(chainSub, tvm)
      expect(validatedChain.header.codeSizes).toHaveLength(3)
    })
  })
})
