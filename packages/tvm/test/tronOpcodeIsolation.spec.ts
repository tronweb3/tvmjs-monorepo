import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import {
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  createAccount,
  createAddressFromString,
  hexToBytes,
  setLengthLeft,
} from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { EOFContainer, TVMError, createTVM } from '../src/index.ts'
import { getOpcodesForHF } from '../src/opcodes/codes.ts'

const source = createAddressFromString(`0x${'11'.repeat(20)}`)
const target = createAddressFromString(`0x${'22'.repeat(20)}`)
const tokenId = 2n ** 53n + 1n
const tokenValue = 17n
const sentinel = 0xabn

const vectors = [
  {
    opcode: 0xd0,
    name: 'CALLTOKEN',
    args: [0n, 0n, 0n, 0n, tokenId, 0n, bytesToBigInt(target.bytes), 1000n],
    expected: 1n,
    fee: 40,
    dynamicGas: true,
    energy: 67n,
  },
  {
    opcode: 0xd1,
    name: 'TOKENBALANCE',
    args: [bytesToBigInt(target.bytes), tokenId],
    expected: 42n,
    fee: 20,
    dynamicGas: true,
    energy: 29n,
  },
  {
    opcode: 0xd2,
    name: 'CALLTOKENVALUE',
    args: [],
    expected: tokenValue,
    fee: 2,
    dynamicGas: false,
    energy: 5n,
  },
  {
    opcode: 0xd3,
    name: 'CALLTOKENID',
    args: [],
    expected: tokenId,
    fee: 2,
    dynamicGas: false,
    energy: 5n,
  },
]

function opcodeCode(opcode: number, args: bigint[]) {
  const pushes = args.map((value) =>
    concatBytes(Uint8Array.of(0x7f), setLengthLeft(bigIntToBytes(value), 32)),
  )
  return concatBytes(...pushes, Uint8Array.of(opcode, 0x00))
}

async function createTokenTVM(common: Common) {
  const tvm = await createTVM({ common })
  await tvm.stateManager.putAccount(
    source,
    createAccount({ asset: { [tokenId.toString()]: 100n } }),
  )
  await tvm.stateManager.putAccount(target, createAccount({ asset: { [tokenId.toString()]: 42n } }))
  return tvm
}

describe.each([TronMainnet, TronNile, TronShasta])('TRON opcode isolation on $name', (chain) => {
  for (const activatedProposals of [[], [95], [96], [95, 96]]) {
    for (const eips of [[], [7939]]) {
      it(`preserves Token instructions with proposals [${activatedProposals}] and EIPs [${eips}]`, async () => {
        const tvm = await createTokenTVM(new Common({ chain, activatedProposals, eips }))
        const common = tvm.common
        const originalOpcodes = new Map(tvm.getActiveOpcodes())
        for (const eofEIP of [3540, 3670, 4200, 4750, 5450, 6206, 7069, 7480, 7620, 7692, 7698]) {
          assert.isFalse(common.isActivatedEIP(eofEIP))
          assert.throws(() => common.setEIPs([...eips, eofEIP]), /not supported/)
        }
        assert.deepEqual(common.eips(), eips)
        assert.deepEqual(common.activatedProposals(), activatedProposals)
        assert.deepEqual(tvm.getActiveOpcodes(), originalOpcodes)

        const context = getOpcodesForHF(common)
        for (const vector of vectors) {
          const info = tvm.getActiveOpcodes().get(vector.opcode)!
          assert.strictEqual(info.name, vector.name)
          assert.strictEqual(info.fee, vector.fee)
          assert.strictEqual(info.dynamicGas, vector.dynamicGas)
          assert.strictEqual(context.dynamicGasHandlers.has(vector.opcode), vector.dynamicGas)

          // Captured before EOF cleanup: PUSH1 sentinel + PUSH32 arguments + TRON opcode fee.
          // The empty CALLTOKEN target has no execution or value-transfer cost.
          const code = concatBytes(
            Uint8Array.of(0x60, Number(sentinel)),
            opcodeCode(vector.opcode, vector.args),
          )
          const result = await tvm.runCode({
            to: source,
            tokenId,
            tokenValue,
            code,
            gasLimit: vector.energy,
          })
          assert.isUndefined(result.exceptionError, vector.name)
          assert.strictEqual(result.executionGasUsed, vector.energy, vector.name)
          assert.strictEqual(result.runState!.stack.length, 2, vector.name)
          assert.deepEqual(result.runState!.stack.peek(2), [vector.expected, sentinel], vector.name)
          assert.strictEqual(result.runState!.memoryWordCount, 0n, vector.name)
        }
        assert.strictEqual(
          (await tvm.stateManager.getAccount(source))!.getTokenBalance(tokenId),
          100n,
        )
        assert.strictEqual(
          (await tvm.stateManager.getAccount(target))!.getTokenBalance(tokenId),
          42n,
        )
      })
    }
  }
})

describe('TRON opcode boundaries', () => {
  for (const vector of vectors.filter(({ args }) => args.length > 0)) {
    it.each([0, vector.args.length - 1])(
      `${vector.name} rejects an incomplete stack of %s items`,
      async (count) => {
        const tvm = await createTokenTVM(new Common({ chain: TronMainnet }))
        const result = await tvm.runCode({
          to: source,
          code: opcodeCode(vector.opcode, vector.args.slice(0, count)),
          gasLimit: 100000n,
        })
        assert.strictEqual(result.exceptionError?.error, TVMError.errorMessages.STACK_UNDERFLOW)
      },
    )
  }

  it.each(vectors)('$name fails when one Energy below the required amount', async (vector) => {
    const tvm = await createTokenTVM(new Common({ chain: TronMainnet }))
    const gasLimit = vector.energy - 1n
    const result = await tvm.runCode({
      to: source,
      tokenId,
      tokenValue,
      code: concatBytes(
        Uint8Array.of(0x60, Number(sentinel)),
        opcodeCode(vector.opcode, vector.args),
      ),
      gasLimit,
    })
    assert.strictEqual(result.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
    assert.strictEqual(result.executionGasUsed, gasLimit)
    assert.strictEqual((await tvm.stateManager.getAccount(source))!.getTokenBalance(tokenId), 100n)
    assert.strictEqual((await tvm.stateManager.getAccount(target))!.getTokenBalance(tokenId), 42n)
  })

  it.each(vectors.filter(({ args }) => args.length === 0))(
    '$name accepts an empty stack and reads the transaction context',
    async (vector) => {
      const tvm = await createTVM()
      const result = await tvm.runCode({
        code: opcodeCode(vector.opcode, []),
        tokenId,
        tokenValue,
        gasLimit: BigInt(vector.fee),
      })
      assert.isUndefined(result.exceptionError)
      assert.strictEqual(result.executionGasUsed, BigInt(vector.fee))
      assert.strictEqual(result.runState!.stack.length, 1)
      assert.deepEqual(result.runState!.stack.peek(), [vector.expected])
    },
  )

  it('retains independent EOF container parsing without enabling EOF execution', async () => {
    const bytes = hexToBytes('0xef00010100040200010001040004000080000000deadbeef')
    const container = new EOFContainer(bytes)
    assert.deepEqual(container.body.dataSection, hexToBytes('0xdeadbeef'))
    assert.deepEqual(container.body.codeSections[0], Uint8Array.of(0x00))

    const tvm = await createTVM()
    const result = await tvm.runCode({ code: bytes, gasLimit: 100000n })
    assert.strictEqual(result.exceptionError?.error, TVMError.errorMessages.INVALID_OPCODE)
  })
})
