import {
  Common,
  TronMainnet,
  TronNile,
  TronShasta,
  createCurrentTronMainnetCommon,
} from '@tvmjs/common'
import { MerkleStateManager, SimpleStateManager } from '@tvmjs/statemanager'
import {
  Account,
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  createAddressFromString,
  hexToBytes,
  setLengthLeft,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { Message, TVMError, createTVM } from '../src/index.ts'
import energyVectors from './testdata/tronEnergy.json' with { type: 'json' }

import type { TVM } from '../src/index.ts'

const source = createAddressFromString('0x1000000000000000000000000000000000000001')
const target = createAddressFromString('0x2000000000000000000000000000000000000002')
const slot = new Uint8Array(32)
const tokenId = 1000001n
const MAX_WORD = (1n << 256n) - 1n

function push(value: bigint) {
  return concatBytes(Uint8Array.of(0x7f), setLengthLeft(bigIntToBytes(value), 32))
}

function callCode(opcode: number, value = 0n, gas = 50000n, memory = [0n, 0n, 0n, 0n]) {
  // Stack arguments are pushed in reverse: output, input, token/value, target, gas.
  const args = [memory[3], memory[2], memory[1], memory[0]]
  if (opcode === 0xd0) args.push(tokenId)
  if ([0xf1, 0xf2, 0xd0].includes(opcode)) args.push(value)
  args.push(bytesToBigInt(target.bytes), gas)
  return concatBytes(...args.map(push), Uint8Array.of(opcode))
}

async function initialize(tvm: TVM, code: Uint8Array, targetAccount?: Account) {
  const account = new Account(0n, 100n)
  account.asset = { [Number(tokenId)]: 100n }
  await tvm.stateManager.putAccount(source, account)
  await tvm.stateManager.putCode(source, code)
  if (targetAccount !== undefined) await tvm.stateManager.putAccount(target, targetAccount)
}

describe('TRON Energy source vectors', () => {
  for (const chain of [TronMainnet, TronNile, TronShasta]) {
    for (const vector of energyVectors.vectors) {
      it(`${chain.name}: ${vector.name}`, async () => {
        // These pinned vectors predate proposal-specific adjustments.
        const tvm = await createTVM({ common: new Common({ chain, activatedProposals: [] }) })
        await initialize(tvm, hexToBytes(vector.code as `0x${string}`))
        const result = await tvm.runCall({ to: source, gasLimit: 100000n })
        assert.isUndefined(result.execResult.exceptionError)
        assert.strictEqual(result.execResult.executionGasUsed, BigInt(vector.energy))
        assert.strictEqual(result.execResult.gasRefund, BigInt(vector.refund))
      })
    }
  }

  it.each([[], [95], [96], [95, 96]].map((activatedProposals) => ({ activatedProposals })))(
    'does not restore cold access pricing with proposals $activatedProposals',
    async ({ activatedProposals }) => {
      const common = new Common({ chain: TronMainnet, activatedProposals })
      const tvm = await createTVM({ common })
      const result = await tvm.runCode({ code: hexToBytes('0x600054506000545000') })
      assert.strictEqual(result.executionGasUsed, 110n)
      for (const eip of [2929, 3529, 3651]) {
        assert.isFalse(common.isActivatedEIP(eip))
        assert.throws(() => common.setEIPs([eip]), /not supported/)
      }
    },
  )

  it('preserves explicit TRON parameters when loading defaults and copying the TVM', async () => {
    const common = new Common({
      chain: TronMainnet,
      params: { tron: { balanceGas: 21 } },
      eips: [2930],
    })
    const tvm = await createTVM({ common })
    for (const instance of [tvm, tvm.shallowCopy()]) {
      const result = await instance.runCode({ code: hexToBytes('0x60003100') })
      assert.strictEqual(result.executionGasUsed, 24n)
      assert.strictEqual(instance.common.param('sloadGas'), 50n)
    }
  })

  it.each([
    ['BALANCE', '600031506000315000', 50n],
    ['EXTCODESIZE', '60003b5060003b5000', 50n],
    ['EXTCODEHASH', '60003f5060003f5000', 810n],
    ['ISCONTRACT', '6000d4506000d45000', 50n],
    ['TOKENBALANCE', '6000620f4241d1506000620f4241d15000', 56n],
    ['EXTCODECOPY', '60206000600060003c00', 38n],
    ['CALLDATACOPY', '6020600060003700', 15n],
    ['CODECOPY', '6020600060003900', 15n],
    ['RETURNDATACOPY', '6000600060003e00', 9n],
    ['EXP', '600260020a00', 26n],
  ] as const)('%s has the source Energy cost', async (_name, code, energy) => {
    const tvm = await createTVM()
    const result = await tvm.runCode({ code: hexToBytes(`0x${code}`) })
    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.executionGasUsed, energy)
  })

  it('allows the java-tron higher CPU limit memory schedule through explicit parameters', async () => {
    const common = new Common({
      chain: TronMainnet,
      activatedProposals: [],
      params: { tron: { mloadGas: 1, mstoreGas: 1, mstore8Gas: 1 } },
    })
    const tvm = await createTVM({ common })
    const result = await tvm.runCode({ code: hexToBytes('0x600060005200') })
    assert.strictEqual(result.executionGasUsed, 10n)
  })

  it('applies java-tron proposal 65 to all three memory opcodes', async () => {
    // Each memory instruction runs after the first MSTORE has expanded memory,
    // so proposal 65 contributes exactly one Energy per instruction.
    const code = hexToBytes('0x600060005260005150600060005300')
    for (const [activatedProposals, expected] of [
      [[], 20n],
      [[65], 23n],
    ] as const) {
      const tvm = await createTVM({
        common: new Common({ chain: TronMainnet, activatedProposals: [...activatedProposals] }),
      })
      const result = await tvm.runCode({ code })
      assert.isUndefined(result.exceptionError)
      assert.strictEqual(result.executionGasUsed, expected)
      for (const opcode of [0x51, 0x52, 0x53]) {
        assert.strictEqual(tvm.getActiveOpcodes().get(opcode)?.fee, activatedProposals.length)
      }
    }
  })

  it('uses the current mainnet memory schedule from the Common factory', async () => {
    const tvm = await createTVM({ common: createCurrentTronMainnetCommon() })
    const result = await tvm.runCode({ code: hexToBytes('0x600060005200') })
    assert.isUndefined(result.exceptionError)
    assert.strictEqual(result.executionGasUsed, 10n)
    assert.isTrue(tvm.common.isActivatedEIP(7939))
  })

  it('reports accesses without warming addresses or slots', async () => {
    const tvm = await createTVM()
    tvm.journal.startReportingAccessList()
    const code = concatBytes(push(bytesToBigInt(target.bytes)), hexToBytes('0x315060005400'))
    await initialize(tvm, code)
    const result = await tvm.runCall({ to: source })
    assert.isUndefined(result.execResult.exceptionError)
    assert.isTrue(tvm.journal.accessList!.has(target.toString().slice(2)))
    assert.isTrue(tvm.journal.accessList!.get(source.toString().slice(2))!.has('00'.repeat(32)))
    assert.isFalse(tvm.journal.isWarmedAddress(target.bytes))
    assert.isFalse(tvm.journal.isWarmedStorage(source.bytes, slot))
  })

  it('ignores manually warmed addresses and storage when charging Energy', async () => {
    const tvm = await createTVM()
    tvm.journal.addAlwaysWarmAddress('00'.repeat(20))
    tvm.journal.addAlwaysWarmSlot(source.toString(), '00'.repeat(32))
    await initialize(tvm, hexToBytes('0x600031506000545000'))
    const result = await tvm.runCall({ to: source })
    assert.strictEqual(result.execResult.executionGasUsed, 80n)
  })
})

for (const StateManager of [SimpleStateManager, MerkleStateManager]) {
  describe(`TRON storage Energy with ${StateManager.name}`, () => {
    it('executes explicitly supplied code at a missing recipient', async () => {
      const tvm = await createTVM({ stateManager: new StateManager() })
      await tvm.stateManager.putAccount(source, new Account())
      const result = await tvm.runCall({
        caller: source,
        to: target,
        code: hexToBytes('0x600160005500'),
        gasLimit: 50000n,
      })
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.executionGasUsed, 20006n)
      assert.isDefined(await tvm.stateManager.getAccount(target))
      assert.strictEqual(bytesToBigInt(await tvm.stateManager.getStorage(target, slot)), 1n)
      assert.strictEqual((await tvm.stateManager.getCode(target)).length, 0)
    })

    it.each([
      [0n, [0n], 5000n],
      [0n, [1n], 20000n],
      [1n, [0n], 5000n],
      [1n, [1n], 5000n],
      [1n, [2n, 1n], 10000n],
      [0n, [1n, 0n, 1n], 30000n],
    ] as const)(
      'charges current-value writes from %s through %s without refunds',
      async (initial, values, energy) => {
        const tvm = await createTVM({ stateManager: new StateManager() })
        const code = concatBytes(
          ...values.map((value) => concatBytes(push(value), push(0n), Uint8Array.of(0x55))),
        )
        await initialize(tvm, code)
        if (initial !== 0n) await tvm.stateManager.putStorage(source, slot, bigIntToBytes(initial))
        const result = await tvm.runCall({ to: source, gasLimit: 100000n })
        assert.isUndefined(result.execResult.exceptionError)
        assert.strictEqual(result.execResult.executionGasUsed, energy + 6n * BigInt(values.length))
        assert.strictEqual(result.execResult.gasRefund, 0n)
        assert.strictEqual(
          bytesToBigInt(await tvm.stateManager.getStorage(source, slot)),
          values.at(-1),
        )
      },
    )

    it('treats a padded zero storage value as an unset slot', async () => {
      const tvm = await createTVM({ stateManager: new StateManager() })
      await initialize(tvm, hexToBytes('0x600160005500'))
      await tvm.stateManager.putStorage(source, slot, new Uint8Array(32))
      const result = await tvm.runCall({ to: source })
      assert.strictEqual(result.execResult.executionGasUsed, 20006n)
    })

    it.each(['revert', 'out of gas'] as const)(
      'restores storage and balances after a nested %s',
      async (failure) => {
        for (const opcode of [0xf1, 0xd0]) {
          const tvm = await createTVM({ stateManager: new StateManager() })
          await initialize(
            tvm,
            callCode(opcode, 1n, failure === 'revert' ? 50000n : 0n),
            new Account(),
          )
          await tvm.stateManager.putCode(target, hexToBytes('0x600160005560006000fd'))
          const result = await tvm.runCall({ to: source, gasLimit: 100000n })
          assert.isUndefined(result.execResult.exceptionError)
          assert.strictEqual(result.execResult.runState!.stack.peek()[0], 0n)
          assert.strictEqual(result.execResult.gasRefund, 0n)
          assert.strictEqual(bytesToBigInt(await tvm.stateManager.getStorage(target, slot)), 0n)
          const from = (await tvm.stateManager.getAccount(source))!
          const to = (await tvm.stateManager.getAccount(target))!
          assert.strictEqual(from.balance, 100n)
          assert.strictEqual(from.getTokenBalance(tokenId), 100n)
          assert.strictEqual(to.balance, 0n)
          assert.strictEqual(to.getTokenBalance(tokenId), 0n)
        }
      },
    )

    it('rolls back successful nested changes when the caller reverts', async () => {
      const tvm = await createTVM({ stateManager: new StateManager() })
      await initialize(
        tvm,
        concatBytes(callCode(0xd0, 1n), hexToBytes('0x60006000fd')),
        new Account(),
      )
      await tvm.stateManager.putCode(target, hexToBytes('0x600160005500'))
      const result = await tvm.runCall({ to: source, gasLimit: 100000n })
      assert.strictEqual(result.execResult.exceptionError?.error, TVMError.errorMessages.REVERT)
      assert.strictEqual(bytesToBigInt(await tvm.stateManager.getStorage(target, slot)), 0n)
      assert.strictEqual(
        (await tvm.stateManager.getAccount(source))!.getTokenBalance(tokenId),
        100n,
      )
      assert.strictEqual((await tvm.stateManager.getAccount(target))!.getTokenBalance(tokenId), 0n)
    })
  })
}

describe('TRON CALL Energy and account existence', () => {
  it('keeps a missing recipient absent when reusing a zero-value message', async () => {
    const tvm = await createTVM()
    const message = new Message({ caller: source, to: target, gasLimit: 50000n })
    for (let i = 0; i < 2; i++) {
      const result = await tvm.runCall({ message })
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.executionGasUsed, 0n)
      assert.isUndefined(await tvm.stateManager.getAccount(target))
    }
  })

  for (const [name, opcode, argumentCount] of [
    ['CALL', 0xf1, 7],
    ['CALLCODE', 0xf2, 7],
    ['DELEGATECALL', 0xf4, 6],
    ['STATICCALL', 0xfa, 6],
    ['CALLTOKEN', 0xd0, 8],
  ] as const) {
    it(`${name}: costs 40 plus stack setup for a zero-value call`, async () => {
      const tvm = await createTVM()
      await initialize(tvm, callCode(opcode, 0n))
      const result = await tvm.runCall({ to: source })
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(result.execResult.executionGasUsed, 40n + BigInt(argumentCount * 3))
      assert.strictEqual(result.execResult.runState!.stack.peek()[0], 1n)
      assert.isUndefined(await tvm.stateManager.getAccount(target))
    })
  }

  for (const opcode of [0xf1, 0xd0]) {
    it.each(['missing', 'empty', 'funded', 'token only'] as const)(
      `opcode ${opcode}: transfers to a %s recipient`,
      async (state) => {
        const tvm = await createTVM()
        const account = state === 'missing' ? undefined : new Account()
        if (state === 'funded') account!.balance = 10n
        if (state === 'token only') account!.asset = { [Number(tokenId)]: 10n }
        await initialize(tvm, callCode(opcode, 1n, 0n), account)
        const result = await tvm.runCall({ to: source, gasLimit: 100000n })
        assert.isUndefined(result.execResult.exceptionError)
        assert.strictEqual(result.execResult.runState!.stack.peek()[0], 1n)
        // java-tron returns the unused 2300 stipend from an empty callee.
        const energy = (opcode === 0xd0 ? 24n : 21n) + 40n + 9000n - 2300n
        assert.strictEqual(
          result.execResult.executionGasUsed,
          energy + (state === 'missing' ? 25000n : 0n),
        )
        const recipient = (await tvm.stateManager.getAccount(target))!
        if (opcode === 0xd0)
          assert.strictEqual(recipient.getTokenBalance(tokenId), state === 'token only' ? 11n : 1n)
        else assert.strictEqual(recipient.balance, state === 'funded' ? 11n : 1n)
      },
    )

    it(`opcode ${opcode}: a preceding zero-value call does not bypass new-account charging`, async () => {
      const tvm = await createTVM()
      const code = concatBytes(
        callCode(opcode, 0n, 0n),
        Uint8Array.of(0x50),
        callCode(opcode, 1n, 0n),
      )
      await initialize(tvm, code)
      const result = await tvm.runCall({ to: source, gasLimit: 100000n })
      const setup = opcode === 0xd0 ? 24n : 21n
      assert.strictEqual(
        result.execResult.executionGasUsed,
        (setup + 40n) * 2n + 2n + 9000n + 25000n - 2300n,
      )
    })
  }

  it('forwards all available Energy after memory and call costs, even for a uint256 request', async () => {
    const tvm = await createTVM()
    await initialize(tvm, callCode(0xf1, 0n, MAX_WORD, [0n, 64n, 64n, 32n]))
    await tvm.stateManager.putCode(target, hexToBytes('0x00'))
    let forwarded: bigint | undefined
    tvm.events.on('beforeMessage', (message) => {
      if (message.depth === 1) forwarded = message.gasLimit
    })
    const result = await tvm.runCall({ to: source, gasLimit: 1070n })
    assert.isUndefined(result.execResult.exceptionError)
    assert.strictEqual(forwarded, 1000n)
    assert.strictEqual(result.execResult.executionGasUsed, 70n)
  })

  it.each([60n, 61n])('checks the full CALL cost at the %s Energy boundary', async (gasLimit) => {
    const tvm = await createTVM()
    await initialize(tvm, callCode(0xf1, 0n, MAX_WORD))
    let calls = 0
    tvm.events.on('beforeMessage', (message) => {
      if (message.depth === 1) calls++
    })
    const result = await tvm.runCall({ to: source, gasLimit })
    assert.strictEqual(result.execResult.executionGasUsed, gasLimit)
    if (gasLimit === 60n) {
      assert.strictEqual(result.execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
      assert.strictEqual(calls, 0)
    } else {
      assert.isUndefined(result.execResult.exceptionError)
      assert.strictEqual(calls, 1)
    }
    assert.isUndefined(await tvm.stateManager.getAccount(target))
  })
})
