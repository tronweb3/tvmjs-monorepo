import { createBlock } from '@tvmjs/block'
import { Common, Mainnet, TronMainnet } from '@tvmjs/common'
import { TransactionType, createTx } from '@tvmjs/tx'
import {
  Account,
  Address,
  type BALJSONBlockAccessList,
  CLRequestType,
  bytesToHex,
  createAddressFromString,
  hexToBytes,
  intToBytes,
  setLengthLeft,
} from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import { buildBlock } from '../../src/buildBlock.ts'
import { createVM } from '../../src/constructors.ts'
import { consumeBal } from '../../src/consumeBal.ts'
import { emitTVMProfile } from '../../src/emitTVMProfile.ts'
import { accumulateRequests } from '../../src/requests.ts'
import {
  accumulateParentBlockHash,
  calculateMinerReward,
  encodeReceipt,
  rewardAccount,
  runBlock,
} from '../../src/runBlock.ts'
import { generateTxReceipt, runTx } from '../../src/runTx.ts'
import { setupVM } from './utils.ts'

describe('VM Coverage Boost Suite', () => {
  const privateKey = hexToBytes(
    '0xe331b6d69882b4cb4ea581d88e0b604039a3de5967688d3dcffdd2270c0fd109',
  )

  describe('consumeBal.ts', () => {
    it('handles empty account changes, balance, nonce, code, and storage changes', async () => {
      const vm = await setupVM()
      const addrHex = '0x1111111111111111111111111111111111111111' as const
      const addr = createAddressFromString(addrHex)

      // 1. empty account changes
      await consumeBal(vm, [
        {
          address: addrHex,
          storageReads: [],
          balanceChanges: [],
          nonceChanges: [],
          codeChanges: [],
          storageChanges: [],
        },
      ])

      // 2. with changes
      const bal: BALJSONBlockAccessList = [
        {
          address: addrHex,
          storageReads: [],
          balanceChanges: [{ blockAccessIndex: '0x00', postBalance: '0x1000' }],
          nonceChanges: [{ blockAccessIndex: '0x00', postNonce: '0x05' }],
          codeChanges: [{ blockAccessIndex: '0x00', newCode: '0x6001600201' }],
          storageChanges: [
            {
              slot: '0x01',
              slotChanges: [{ blockAccessIndex: '0x00', postValue: '0x09' }],
            },
          ],
        },
      ]
      await consumeBal(vm, bal)

      const acc = await vm.stateManager.getAccount(addr)
      expect(acc?.balance).toBe(0x1000n)
      expect(acc?.nonce).toBe(5n)

      const code = await vm.stateManager.getCode(addr)
      expect(bytesToHex(code)).toBe('0x6001600201')

      const storage = await vm.stateManager.getStorage(addr, setLengthLeft(hexToBytes('0x01'), 32))
      expect(storage).toEqual(hexToBytes('0x09'))

      // 3. state root matching and mismatching
      const stateRoot = await vm.stateManager.getStateRoot()
      await consumeBal(vm, [], stateRoot)

      const fakeRoot = new Uint8Array(32).fill(1)
      await expect(consumeBal(vm, [], fakeRoot)).rejects.toThrow('Expected state root')
    })
  })

  describe('emitTVMProfile.ts', () => {
    it('returns early when logs are empty and prints when populated', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      emitTVMProfile([], 'Empty Profile')
      expect(spy).not.toHaveBeenCalled()

      const logs: any[] = [
        {
          tag: 'ADD',
          calls: 10,
          avgTimePerCall: 0.05,
          totalTime: 0.5,
          staticGasUsed: 30,
          dynamicGasUsed: 0,
          gasUsed: 30,
          staticGas: 3,
          millionGasPerSecond: 60,
          blocksPerSlot: 2.5,
        },
        {
          tag: 'SLOAD',
          calls: 5,
          avgTimePerCall: 0.1,
          totalTime: 0.5,
          gasUsed: 500,
        },
      ]

      emitTVMProfile(logs, 'Opcode Profile')
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  describe('constructors.ts', () => {
    it('rejects conflicting profiler options and sets up profiler properly', async () => {
      await expect(
        createVM({
          profilerOpts: {
            reportAfterBlock: true,
            reportAfterTx: true,
          },
        }),
      ).rejects.toThrow(
        'Cannot have `reportProfilerAfterBlock` and `reportProfilerAfterTx` set to `true` at the same time',
      )

      const vmBlockProf = await createVM({
        profilerOpts: { reportAfterBlock: true },
      })
      expect(vmBlockProf).toBeDefined()

      const vmTxProf = await createVM({
        profilerOpts: { reportAfterTx: true },
      })
      expect(vmTxProf).toBeDefined()
    })

    it('activatePrecompiles without pre-supplied stateManager seeds accounts', async () => {
      const vm = await createVM({
        activatePrecompiles: true,
      })
      // Account 1 (ecrecover) should have 1 wei
      const ecrecoverAddr = createAddressFromString('0x0000000000000000000000000000000000000001')
      const acc = await vm.stateManager.getAccount(ecrecoverAddr)
      expect(acc?.balance).toBe(1n)
    })
  })

  describe('vm.ts error handling & events', () => {
    it('handles event listeners with 2 arguments (data, done)', async () => {
      const vm = await setupVM()
      let doneCalled = false
      vm.events.on('beforeTx', (tx: any, done: any) => {
        doneCalled = true
        done()
      })
      await vm._emit('beforeTx', {} as any)
      expect(doneCalled).toBe(true)
    })

    it('handles errorStr fallback and shallowCopy(false)', async () => {
      const vm = await setupVM()
      expect(vm.errorStr()).toContain('vm hf=')

      // Break hardfork temporarily to test error branch
      const origHardfork = vm.common.hardfork.bind(vm.common)
      ;(vm.common as any).hardfork = () => {
        throw new Error('fail')
      }
      expect(vm.errorStr()).toBe('vm hf=error')
      ;(vm.common as any).hardfork = origHardfork

      const copy = await vm.shallowCopy(false)
      expect(copy).toBeDefined()
    })
  })

  describe('requests.ts', () => {
    function buildValidDepositLog() {
      // 576 bytes
      const log = new Uint8Array(576)
      const view = new DataView(log.buffer, log.byteOffset, log.byteLength)

      // Offsets
      view.setBigUint64(24, 160n)
      view.setBigUint64(56, 256n)
      view.setBigUint64(88, 320n)
      view.setBigUint64(120, 384n)
      view.setBigUint64(152, 512n)

      // Sizes
      view.setBigUint64(160 + 24, 48n)
      view.setBigUint64(256 + 24, 32n)
      view.setBigUint64(320 + 24, 8n)
      view.setBigUint64(384 + 24, 96n)
      view.setBigUint64(512 + 24, 8n)

      // Fill values
      log.set(new Uint8Array(48).fill(1), 160 + 32)
      log.set(new Uint8Array(32).fill(2), 256 + 32)
      log.set(new Uint8Array(8).fill(3), 320 + 32)
      log.set(new Uint8Array(96).fill(4), 384 + 32)
      log.set(new Uint8Array(8).fill(5), 512 + 32)

      return log
    }

    it('accumulateRequests with EIP-6110, EIP-7002, and EIP-7251', async () => {
      const vm = await setupVM()
      const isActivatedSpy = vi
        .spyOn(vm.common, 'isActivatedEIP')
        .mockImplementation((eip) => [6110, 7002, 7251].includes(eip))
      const paramSpy = vi.spyOn(vm.common, 'param').mockImplementation((paramName) => {
        if (paramName === 'withdrawalRequestPredeployAddress') return 0x7002n
        if (paramName === 'consolidationRequestPredeployAddress') return 0x7251n
        if (paramName === 'systemAddress') return 0xfffffffffffffffffffffffffffffffffffffffen
        if (paramName === 'systemCallGasLimit') return 1000000n
        return 0n
      })

      try {
        const depositContract = Mainnet.depositContractAddress!
        const depositTopic = hexToBytes(
          '0x649bbc62d0e31342afea4e5cd82d4049e7e1ee912fc0889aa790803be39038c5',
        )

        const validLogData = buildValidDepositLog()
        const txResults: any[] = [
          {
            receipt: {
              logs: [[hexToBytes(depositContract), [depositTopic], validLogData]],
            },
          },
        ]

        const requests = await accumulateRequests(vm, txResults)
        expect(requests.length).toBe(3)
        expect(requests[0].type).toBe(CLRequestType.Deposit)
        expect(requests[1].type).toBe(CLRequestType.Withdrawal)
        expect(requests[2].type).toBe(CLRequestType.Consolidation)

        // Test with system accounts and predeploy accounts populated
        const withdrawalAddr = createAddressFromString(
          bytesToHex(setLengthLeft(intToBytes(0x7002), 20)),
        )
        const consolidationAddr = createAddressFromString(
          bytesToHex(setLengthLeft(intToBytes(0x7251), 20)),
        )
        await vm.stateManager.putAccount(withdrawalAddr, new Account(0n, 1000n))
        await vm.stateManager.putAccount(consolidationAddr, new Account(0n, 1000n))

        const requestsWithAccounts = await accumulateRequests(vm, [])
        expect(requestsWithAccounts.length).toBe(3)
      } finally {
        isActivatedSpy.mockRestore()
        paramSpy.mockRestore()
      }
    })

    it('accumulateRequests throws on invalid layout or missing contract address', async () => {
      const vm = await setupVM()
      const isActivatedSpy = vi
        .spyOn(vm.common, 'isActivatedEIP')
        .mockImplementation((eip) => eip === 6110)

      // Mock missing depositContractAddress
      const origAddr = (Mainnet as any).depositContractAddress
      try {
        ;(Mainnet as any).depositContractAddress = undefined
        delete (vm.common as any)['_chainParams'].depositContractAddress
        await expect(accumulateRequests(vm, [])).rejects.toThrow(
          'deposit contract address required with EIP 6110',
        )
      } finally {
        ;(Mainnet as any).depositContractAddress = origAddr
      }

      // Invalid deposit log layout
      const badTxResults: any[] = [
        {
          receipt: {
            logs: [
              [
                hexToBytes(Mainnet.depositContractAddress!),
                [hexToBytes('0x649bbc62d0e31342afea4e5cd82d4049e7e1ee912fc0889aa790803be39038c5')],
                new Uint8Array(100), // wrong size
              ],
            ],
          },
        },
      ]
      await expect(accumulateRequests(vm, badTxResults)).rejects.toThrow(
        'invalid deposit log: unsupported data layout',
      )
      isActivatedSpy.mockRestore()
    })
  })

  describe('runBlock.ts helper functions & validations', () => {
    it('calculateMinerReward', () => {
      const minerReward = 2000000000000000000n
      expect(calculateMinerReward(minerReward, 0)).toBe(minerReward)
      expect(calculateMinerReward(minerReward, 2)).toBe(minerReward + (minerReward / 32n) * 2n)
    })

    it('encodeReceipt handles pre-byzantium, post-byzantium status 0/1, and typed receipts', () => {
      const preByzantiumReceipt: any = {
        stateRoot: new Uint8Array(32).fill(7),
        cumulativeBlockGasUsed: 21000n,
        bitvector: new Uint8Array(256),
        logs: [],
      }
      const enc1 = encodeReceipt(preByzantiumReceipt, TransactionType.Legacy)
      expect(enc1.length).toBeGreaterThan(0)

      const postByzantiumReceiptFailure: any = {
        status: 0,
        cumulativeBlockGasUsed: 21000n,
        bitvector: new Uint8Array(256),
        logs: [],
      }
      const enc2 = encodeReceipt(postByzantiumReceiptFailure, TransactionType.AccessListEIP2930)
      expect(enc2[0]).toBe(TransactionType.AccessListEIP2930)

      const postByzantiumReceiptSuccess: any = {
        status: 1,
        cumulativeBlockGasUsed: 21000n,
        bitvector: new Uint8Array(256),
        logs: [],
      }
      const enc3 = encodeReceipt(postByzantiumReceiptSuccess, TransactionType.Legacy)
      expect(enc3.length).toBeGreaterThan(0)
    })

    it('rewardAccount works with existing and new accounts, reward 0 and > 0', async () => {
      const vm = await setupVM()
      const addr = createAddressFromString('0x1234567890123456789012345678901234567890')

      // Account does not exist
      const acc1 = await rewardAccount(vm.tvm, addr, 500n, vm.common)
      expect(acc1.balance).toBe(500n)

      // Account already exists
      const acc2 = await rewardAccount(vm.tvm, addr, 200n, vm.common)
      expect(acc2.balance).toBe(700n)

      // Reward 0
      const acc3 = await rewardAccount(vm.tvm, addr, 0n, vm.common)
      expect(acc3.balance).toBe(700n)
    })

    it('accumulateParentBlockHash validates EIP-2935 and handles empty / non-empty contract code', async () => {
      const vm = await setupVM()
      // Not activated
      await expect(accumulateParentBlockHash(vm, 10n, new Uint8Array(32))).rejects.toThrow(
        'Cannot call `accumulateParentBlockHash`: EIP 2935 is not active',
      )

      const isActivatedSpy = vi
        .spyOn(vm.common, 'isActivatedEIP')
        .mockImplementation((eip) => eip === 2935)
      const paramSpy = vi.spyOn(vm.common, 'param').mockImplementation((paramName) => {
        if (paramName === 'historyStorageAddress') return 0x2935n
        if (paramName === 'historyServeWindow') return 8192n
        return 0n
      })

      try {
        const historyAddress = new Address(setLengthLeft(intToBytes(0x2935), 20))

        // 1. No code deployed at history address -> returns early
        await accumulateParentBlockHash(vm, 10n, new Uint8Array(32).fill(3))
        const code = await vm.stateManager.getCode(historyAddress)
        expect(code.length).toBe(0)

        // 2. Put dummy code so it executes storage writing
        await vm.stateManager.putCode(historyAddress, hexToBytes('0x00'))
        await accumulateParentBlockHash(vm, 10n, new Uint8Array(32).fill(9))
        const slotKey = setLengthLeft(intToBytes(9), 32)
        const storedHash = await vm.stateManager.getStorage(historyAddress, slotKey)
        expect(storedHash).toEqual(new Uint8Array(32).fill(9))
      } finally {
        isActivatedSpy.mockRestore()
        paramSpy.mockRestore()
      }
    })

    it('runBlock validation errors', async () => {
      const vm = await setupVM()

      // Gas limit > 2^63 - 1
      const hugeGasLimitBlock = createBlock(
        {
          header: {
            gasLimit: 0x8000000000000001n,
          },
        },
        { common: vm.common },
      )
      await expect(runBlock(vm, { block: hugeGasLimitBlock })).rejects.toThrow(
        'Invalid block with gas limit greater than (2^63 - 1)',
      )

      // Blockchain has no validateHeader method when skipHeaderValidation is false
      const block = createBlock({}, { common: vm.common })
      const origValidate = (vm.blockchain as any).validateHeader
      ;(vm.blockchain as any).validateHeader = undefined
      try {
        await expect(
          runBlock(vm, { block, skipHeaderValidation: false, skipBlockValidation: false }),
        ).rejects.toThrow('blockchain has no `validateHeader` method')
      } finally {
        ;(vm.blockchain as any).validateHeader = origValidate
      }

      // Mismatched stateRoot when generateFields is false
      const badStateRootBlock = createBlock(
        {
          header: {
            stateRoot: new Uint8Array(32).fill(99),
          },
        },
        { common: vm.common },
      )
      await expect(
        runBlock(vm, { block: badStateRootBlock, generate: false, skipHeaderValidation: true }),
      ).rejects.toThrow('invalid block stateRoot')

      // Mismatched gasUsed when generateFields is false
      const validBlock = createBlock({}, { common: vm.common })
      const res = await runBlock(vm, { block: validBlock, generate: true })
      const badGasBlock = createBlock(
        {
          header: {
            ...res.results,
            gasUsed: 999999n,
            stateRoot: res.stateRoot,
            receiptTrie: res.receiptsRoot,
            logsBloom: res.logsBloom,
          },
        },
        { common: vm.common },
      )
      await expect(
        runBlock(vm, { block: badGasBlock, generate: false, skipHeaderValidation: true }),
      ).rejects.toThrow('invalid gasUsed')
    })
  })

  describe('runTx.ts validations & edge cases', () => {
    it('generateTxReceipt for PreByzantium and PostByzantium with exceptionError', async () => {
      const vm = await setupVM()
      const tx = createTx(
        { type: TransactionType.Legacy, gasLimit: 60000, gasPrice: 100 },
        { common: vm.common },
      )

      const failureResult: any = {
        totalGasSpent: 53000n,
        bloom: { bitvector: new Uint8Array(256) },
        execResult: {
          logs: [],
          exceptionError: { error: 'revert' },
        },
      }
      const receiptFailure = await generateTxReceipt(vm, tx, failureResult, 53000n)
      expect((receiptFailure as any).status).toBe(0)

      // Pre-Byzantium (mock EIP-609 inactive)
      const spy = vi.spyOn(vm.common, 'isActivatedEIP').mockImplementation((eip) => eip !== 609)
      try {
        const receiptPre = await generateTxReceipt(vm, tx, failureResult, 53000n)
        expect((receiptPre as any).stateRoot).toBeDefined()
      } finally {
        spy.mockRestore()
      }
    })

    it('rejects block hardfork mismatch and chainId mismatch', async () => {
      const vm = await setupVM()
      const block = createBlock({}, { common: vm.common })
      const tx = createTx({ gasLimit: 60000, gasPrice: 100 }, { common: vm.common })

      const spyBlockHf = vi.spyOn(block.common, 'hardfork').mockReturnValue('otherFork')
      const spyTxHf = vi.spyOn(tx.common, 'hardfork').mockReturnValue('otherFork')

      try {
        await expect(runTx(vm, { tx, block })).rejects.toThrow(
          'block has a different hardfork than the vm',
        )
      } finally {
        spyBlockHf.mockRestore()
        spyTxHf.mockRestore()
      }

      // Chain ID mismatch
      const txWrongChain = createTx(
        {
          type: TransactionType.AccessListEIP2930,
          chainId: vm.common.chainId(),
          gasLimit: 60000,
          gasPrice: 100,
        },
        { common: vm.common },
      )
      vi.spyOn(txWrongChain.common, 'chainId').mockReturnValue(999999n)
      await expect(runTx(vm, { tx: txWrongChain })).rejects.toThrow('tx has a different chainId')
    })

    it('rejects tx gasLimit higher than block gasLimit', async () => {
      const vm = await setupVM()
      const block = createBlock({ header: { gasLimit: 50000n } }, { common: vm.common })
      const tx = createTx({ gasLimit: 60000n, gasPrice: 100 }, { common: vm.common })

      await expect(runTx(vm, { tx, block })).rejects.toThrow(
        'tx has a higher gas limit than the block',
      )
    })

    it('rejects typed tx when EIP-2930 or EIP-1559 not activated', async () => {
      const vm = await setupVM()
      const tx2930 = createTx(
        {
          type: TransactionType.AccessListEIP2930,
          chainId: vm.common.chainId(),
          gasLimit: 60000n,
          gasPrice: 100n,
          accessList: [],
        },
        { common: vm.common },
      )

      const spy = vi.spyOn(vm.common, 'isActivatedEIP').mockImplementation((eip) => eip !== 2930)
      try {
        await expect(runTx(vm, { tx: tx2930 })).rejects.toThrow('EIP 2930 is not activated')
      } finally {
        spy.mockRestore()
      }
    })

    it('rejects sender with deployed code (EIP-3607)', async () => {
      const vm = await setupVM()
      const tx = createTx({ gasLimit: 60000, gasPrice: 100 }, { common: vm.common }).sign(
        privateKey,
      )
      const sender = tx.getSenderAddress()

      // Put code on sender
      await vm.stateManager.putCode(sender, hexToBytes('0x60006000fd'))
      await expect(runTx(vm, { tx })).rejects.toThrow(
        'invalid sender address, address is not EOA (EIP-3607)',
      )
    })

    it('rejects sender without enough funds for upfront and max cost', async () => {
      const vm = await setupVM()
      const tx = createTx(
        { gasLimit: 60000, gasPrice: 100, value: 1000000000n },
        { common: vm.common },
      ).sign(privateKey)
      const sender = tx.getSenderAddress()
      await vm.stateManager.putAccount(sender, new Account(0n, 10n))

      await expect(runTx(vm, { tx, skipBalance: false })).rejects.toThrow(
        "sender doesn't have enough funds to send tx",
      )
    })

    it('rejects self-transfer of TRX and tokens, and invalid tokenIds', async () => {
      const vm = await setupVM()
      const txForSender = createTx({ gasLimit: 60000, gasPrice: 100 }, { common: vm.common }).sign(
        privateKey,
      )
      const sender = txForSender.getSenderAddress()

      const txSelfTrx = createTx(
        { gasLimit: 60000, gasPrice: 100, to: sender, value: 100n },
        { common: vm.common },
      ).sign(privateKey)
      await vm.stateManager.putAccount(sender, new Account(0n, 100000000n))

      await expect(runTx(vm, { tx: txSelfTrx, skipBalance: false })).rejects.toThrow(
        'Cannot transfer TRX to yourself.',
      )

      // Self transfer asset
      const txSelfAsset = createTx(
        {
          gasLimit: 60000,
          gasPrice: 100,
          to: sender,
          value: 0n,
          tokenId: 1000005n,
          tokenValue: 10n,
        },
        { common: vm.common },
      ).sign(privateKey)
      await expect(runTx(vm, { tx: txSelfAsset, skipBalance: false })).rejects.toThrow(
        'Cannot transfer asset to yourself.',
      )

      // Invalid tokenId <= MIN_TOKEN_ID (1000000)
      const recipient = createAddressFromString('0x1111111111111111111111111111111111111111')
      const txBadTokenId = createTx(
        { gasLimit: 60000, gasPrice: 100, to: recipient, tokenId: 100n, tokenValue: 10n },
        { common: vm.common },
      ).sign(privateKey)
      await expect(runTx(vm, { tx: txBadTokenId, skipBalance: false })).rejects.toThrow(
        'tokenId must be > 1000000',
      )

      // TokenId 0 with tokenValue > 0
      const txZeroTokenId = createTx(
        { gasLimit: 60000, gasPrice: 100, to: recipient, tokenId: 0n, tokenValue: 10n },
        { common: vm.common },
      ).sign(privateKey)
      await expect(runTx(vm, { tx: txZeroTokenId, skipBalance: false })).rejects.toThrow(
        'invalid arguments with tokenValue',
      )

      // Token does not exist
      const txNoAsset = createTx(
        { gasLimit: 60000, gasPrice: 100, to: recipient, tokenId: 1000005n, tokenValue: 10n },
        { common: vm.common },
      ).sign(privateKey)
      await expect(runTx(vm, { tx: txNoAsset, skipBalance: false })).rejects.toThrow('No asset !')
    })

    it('rejects incorrect nonce', async () => {
      const vm = await setupVM()
      const tx = createTx(
        { nonce: 5n, gasLimit: 60000, gasPrice: 100 },
        { common: vm.common },
      ).sign(privateKey)
      const sender = tx.getSenderAddress()
      await vm.stateManager.putAccount(sender, new Account(0n, 100000000n))

      await expect(runTx(vm, { tx, skipNonce: false })).rejects.toThrow(
        "the tx doesn't have the correct nonce",
      )
    })

    it('handles gas refund and profiler on runTx', async () => {
      const vm = await createVM({
        profilerOpts: { reportAfterTx: true },
      })
      const tx = createTx({ gasLimit: 60000, gasPrice: 100 }, { common: vm.common }).sign(
        privateKey,
      )
      const sender = tx.getSenderAddress()
      await vm.stateManager.putAccount(sender, new Account(0n, 100000000n))

      const res = await runTx(vm, {
        tx,
        reportAccessList: true,
        reportPreimages: true,
      })
      expect(res.totalGasSpent).toBeGreaterThan(0n)
      expect(res.receipt).toBeDefined()
    })
  })

  describe('buildBlock.ts', () => {
    it('builds block with sealOpts (PoW nonce & mixHash) and EIP-2935', async () => {
      const common = new Common({
        chain: {
          ...TronMainnet,
          consensus: { type: 'pow', algorithm: 'ethash', ethash: {} },
        } as any,
      })
      const vm = await createVM({ common })

      const isActivatedSpy = vi
        .spyOn(vm.common, 'isActivatedEIP')
        .mockImplementation((eip) => eip === 2935)
      const paramSpy = vi.spyOn(vm.common, 'param').mockImplementation((paramName) => {
        if (paramName === 'historyStorageAddress') return 0x2935n
        if (paramName === 'historyServeWindow') return 8192n
        return 0n
      })

      try {
        const parentBlock = createBlock({}, { common: vm.common })
        const builder = await buildBlock(vm, {
          parentBlock,
          headerData: {
            number: 10n,
            gasLimit: 10000000n,
          },
        })

        const sealOpts = {
          nonce: hexToBytes('0x1234567890abcdef'),
          mixHash: new Uint8Array(32).fill(4),
        }

        const { block } = await builder.build(sealOpts)
        expect(block.header.number).toBe(10n)
      } finally {
        isActivatedSpy.mockRestore()
        paramSpy.mockRestore()
      }
    })
  })

  describe('runBlock.ts additional branches', () => {
    it('executes assignBlockRewards with uncleHeaders and PoW consensus', async () => {
      const commonPoW = new Common({
        chain: {
          ...TronMainnet,
          consensus: { type: 'pow', algorithm: 'ethash', ethash: {} },
        } as any,
      })
      const vmPoW = await createVM({ common: commonPoW })
      const ommer = createBlock({ header: { number: 1n } }, { common: commonPoW })
      const blockWithUncles = createBlock(
        {
          header: { number: 2n },
          uncleHeaders: [ommer.header],
        },
        { common: commonPoW },
      )
      const res = await runBlock(vmPoW, {
        block: blockWithUncles,
        generate: true,
        skipHeaderValidation: true,
        skipBlockValidation: true,
      })
      expect(res).toBeDefined()
    })

    it('processes withdrawals (EIP-4895) with reportPreimages and profiler on block', async () => {
      const isActivatedSpy = vi
        .spyOn(Common.prototype, 'isActivatedEIP')
        .mockImplementation((eip) => eip === 4895)

      try {
        const vm = await createVM({
          profilerOpts: { reportAfterBlock: true },
        })
        const withdrawalAddr = createAddressFromString('0x2222222222222222222222222222222222222222')
        const block = createBlock(
          {
            header: { number: 1n },
            withdrawals: [
              {
                index: 0n,
                validatorIndex: 1n,
                address: withdrawalAddr,
                amount: 10n,
              },
            ],
          },
          { common: vm.common },
        )

        const res = await runBlock(vm, {
          block,
          generate: true,
          reportPreimages: true,
          skipHeaderValidation: true,
          skipBlockValidation: true,
        })
        expect(res).toBeDefined()
      } finally {
        isActivatedSpy.mockRestore()
      }
    })

    it('processes EIP-7685 requests in runBlock and validates mismatched headers', async () => {
      const isActivatedSpy = vi
        .spyOn(Common.prototype, 'isActivatedEIP')
        .mockImplementation((eip) => eip === 7685)

      try {
        const vm = await setupVM()
        const block = createBlock({ header: { number: 1n } }, { common: vm.common })
        const res = await runBlock(vm, {
          block,
          generate: true,
          skipHeaderValidation: true,
          skipBlockValidation: true,
        })
        expect(res.requestsHash).toBeDefined()

        // Mismatched requestsHash when generate is false
        const badRequestsBlock = createBlock(
          {
            header: {
              ...block.header,
              stateRoot: res.stateRoot,
              receiptTrie: res.receiptsRoot,
              logsBloom: res.logsBloom,
              gasUsed: res.gasUsed,
              requestsHash: new Uint8Array(32).fill(99),
            },
          },
          { common: vm.common },
        )
        await expect(
          runBlock(vm, {
            block: badRequestsBlock,
            generate: false,
            skipHeaderValidation: true,
            skipBlockValidation: true,
          }),
        ).rejects.toThrow('invalid requestsHash')

        // Mismatched receiptTrie when generate is false
        const badReceiptBlock = createBlock(
          {
            header: {
              ...block.header,
              stateRoot: res.stateRoot,
              receiptTrie: new Uint8Array(32).fill(99),
              logsBloom: res.logsBloom,
              gasUsed: res.gasUsed,
              requestsHash: res.requestsHash,
            },
          },
          { common: vm.common },
        )
        await expect(
          runBlock(vm, {
            block: badReceiptBlock,
            generate: false,
            skipHeaderValidation: true,
            skipBlockValidation: true,
          }),
        ).rejects.toThrow('invalid receiptTrie')

        // Mismatched bloom when generate is false
        const badBloomBlock = createBlock(
          {
            header: {
              ...block.header,
              stateRoot: res.stateRoot,
              receiptTrie: res.receiptsRoot,
              logsBloom: new Uint8Array(256).fill(99),
              gasUsed: res.gasUsed,
              requestsHash: res.requestsHash,
            },
          },
          { common: vm.common },
        )
        await expect(
          runBlock(vm, {
            block: badBloomBlock,
            generate: false,
            skipHeaderValidation: true,
            skipBlockValidation: true,
          }),
        ).rejects.toThrow('invalid bloom')
      } finally {
        isActivatedSpy.mockRestore()
      }
    })
  })

  describe('requests.ts system access entries & parsing layouts', () => {
    it('clones and restores system access entry and covers system account persistence', async () => {
      const vm = await setupVM()
      const systemAddr = createAddressFromString(
        bytesToHex(setLengthLeft(intToBytes(Number(0xfff)), 20)),
      )
      const withdrawalAddr = createAddressFromString(
        bytesToHex(setLengthLeft(intToBytes(Number(0x7002)), 20)),
      )

      const isActivatedSpy = vi
        .spyOn(vm.common, 'isActivatedEIP')
        .mockImplementation((eip) => eip === 7002 || eip === 7251)
      const paramSpy = vi.spyOn(vm.common, 'param').mockImplementation((paramName) => {
        if (paramName === 'withdrawalRequestPredeployAddress') return 0x7002n
        if (paramName === 'consolidationRequestPredeployAddress') return 0x7002n
        if (paramName === 'systemAddress') return 0xfffn
        if (paramName === 'systemCallGasLimit') return 1000000n
        return 0n
      })

      // Provide systemAccount and withdrawal predeploy account
      await vm.stateManager.putAccount(systemAddr, new Account(1n, 5000n))
      await vm.stateManager.putAccount(withdrawalAddr, new Account(0n, 1000n))

      // Populate blockLevelAccessList accesses for systemAddress
      vm.tvm.blockLevelAccessList = {
        accesses: {
          [systemAddr.toString()]: {
            nonceChanges: new Map([[1, 2n]]),
            balanceChanges: new Map([[1, 500n]]),
            codeChanges: [[1, new Uint8Array([1])]],
            storageChanges: {
              '0x01': [[1, new Uint8Array([2])]],
            },
            storageReads: new Set(['0x01']),
          },
        },
      } as any

      try {
        const reqs = await accumulateRequests(vm, [])
        expect(reqs.length).toBe(2)
      } finally {
        isActivatedSpy.mockRestore()
        paramSpy.mockRestore()
      }
    })
  })

  describe('runTx.ts floorCost, asset checks and gas refunds', () => {
    it('calculates floorCost for EIP-7623', async () => {
      const vm = await setupVM()
      const tx = createTx(
        {
          gasLimit: 60000,
          gasPrice: 100,
          data: hexToBytes('0x00010200'),
        },
        { common: vm.common },
      ).sign(privateKey)
      const sender = tx.getSenderAddress()
      await vm.stateManager.putAccount(sender, new Account(0n, 100000000n))

      const isActivatedSpy = vi
        .spyOn(Common.prototype, 'isActivatedEIP')
        .mockImplementation((eip) => eip === 7623)
      const paramSpy = vi.spyOn(Common.prototype, 'param').mockImplementation((paramName) => {
        if (paramName === 'txGas') return 21000n
        if (paramName === 'totalCostFloorPerToken') return 10n
        if (paramName === 'maxRefundQuotient') return 5n
        return 0n
      })

      try {
        const res = await runTx(vm, { tx })
        expect(res.totalGasSpent).toBeGreaterThan(0n)
      } finally {
        isActivatedSpy.mockRestore()
        paramSpy.mockRestore()
      }
    })

    it('rejects gasLimit lower than minGasLimit', async () => {
      const vm = await setupVM()
      const tx = createTx({ gasLimit: 20000, gasPrice: 100 }, { common: vm.common }).sign(
        privateKey,
      )
      const sender = tx.getSenderAddress()
      await vm.stateManager.putAccount(sender, new Account(0n, 100000000n))

      await expect(runTx(vm, { tx, skipBlockGasLimitValidation: true })).rejects.toThrow(
        'is lower than the minimum gas limit',
      )
    })

    it('rejects various asset transfer error conditions', async () => {
      const vm = await setupVM()
      const recipient = createAddressFromString('0x3333333333333333333333333333333333333333')

      // 1. Owner no asset
      const tx = createTx(
        {
          gasLimit: 60000,
          gasPrice: 100,
          to: recipient,
          tokenId: 1000005n,
          tokenValue: 10n,
        },
        { common: vm.common },
      ).sign(privateKey)
      const sender = tx.getSenderAddress()

      vi.spyOn(vm.stateManager, 'tokenIdExists').mockResolvedValue(true)

      // Owner has empty asset map
      await vm.stateManager.putAccount(sender, new Account(0n, 100000000n))
      await expect(runTx(vm, { tx, skipBalance: false })).rejects.toThrow('Owner no asset!')

      // 2. assetBalance is not sufficient
      const accInsufficient = new Account(0n, 100000000n)
      accInsufficient.asset = { '1000005': 5n }
      await vm.stateManager.putAccount(sender, accInsufficient)
      await expect(runTx(vm, { tx, skipBalance: false })).rejects.toThrow(
        'assetBalance is not sufficient.',
      )

      // 3. assetBalance must greater than 0
      const accZero = new Account(0n, 100000000n)
      accZero.asset = { '1000005': 0n }
      await vm.stateManager.putAccount(sender, accZero)
      await expect(runTx(vm, { tx, skipBalance: false })).rejects.toThrow(
        'assetBalance must greater than 0.',
      )

      // 4. asset key missing in asset map
      const accMissingKey = new Account(0n, 100000000n)
      accMissingKey.asset = { '1000006': 100n }
      await vm.stateManager.putAccount(sender, accMissingKey)
      await expect(runTx(vm, { tx, skipBalance: false })).rejects.toThrow(
        'assetBalance must greater than 0.',
      )
    })
  })
})
