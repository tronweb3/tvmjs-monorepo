import { Common, TronMainnet } from '@tvmjs/common'
import { bytesToHex, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createTVM } from '../../src/index.ts'

import type { PrefixedHexString } from '@tvmjs/util'

type Situation = {
  pre: string
  post: string
  dst: number
  src: number
  length: number
  energy: bigint
}

// Taken from EIP

const situations: Situation[] = [
  {
    pre: '0000000000000000000000000000000000000000000000000000000000000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    post: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    dst: 0,
    src: 32,
    length: 32,
    energy: 405n,
  },
  {
    pre: '0101010101010101010101010101010101010101010101010101010101010101',
    post: '0101010101010101010101010101010101010101010101010101010101010101',
    dst: 0,
    src: 0,
    length: 32,
    energy: 210n,
  },
  // For the situation below, pre/post have 1 byte less than in the current state of the EIP
  {
    pre: '0001020304050607080000000000000000000000000000000000000000000000',
    post: '0102030405060708080000000000000000000000000000000000000000000000',
    dst: 0,
    src: 1,
    length: 8,
    energy: 210n,
  },
  // For the situation below, pre/post have 1 byte less than in the current state of the EIP
  {
    pre: '0001020304050607080000000000000000000000000000000000000000000000',
    post: '0000010203040506070000000000000000000000000000000000000000000000',
    dst: 1,
    src: 0,
    length: 8,
    energy: 210n,
  },
]

function numToOpcode(num: number) {
  return num.toString(16).padStart(2, '0')
}

const PUSH1 = '60'
const MSTORE8 = '53'
const MCOPY = '5E'
const STOP = '00'

describe('TRON MCOPY', () => {
  for (const situation of situations) {
    it(`copies ${situation.length} bytes from ${situation.src} to ${situation.dst}`, async () => {
      // create bytecode
      let bytecode = '0x'
      // prepare the memory
      for (let i = 0; i < situation.pre.length / 2; i++) {
        const start = i * 2
        const hexNum = situation.pre.slice(start, start + 2)
        bytecode += PUSH1 + hexNum + PUSH1 + numToOpcode(i) + MSTORE8
      }
      // mcopy
      bytecode +=
        PUSH1 +
        numToOpcode(situation.length) +
        PUSH1 +
        numToOpcode(situation.src) +
        PUSH1 +
        numToOpcode(situation.dst)
      bytecode += MCOPY + STOP

      const common = new Common({
        chain: TronMainnet,
        activatedProposals: [],
      })

      const tvm = await createTVM({
        common,
      })

      const result = await tvm.runCode({
        code: hexToBytes(bytecode as PrefixedHexString),
        gasLimit: BigInt(0xffffff),
      })
      assert.isUndefined(result.exceptionError)
      assert.strictEqual(result.runState!.stack.length, 0)
      const expected = hexToBytes(`0x${situation.post}`)
      assert.strictEqual(result.runState!.memoryWordCount, BigInt(expected.length / 32))
      assert.strictEqual(
        bytesToHex(result.runState!.memory.read(0, expected.length)),
        bytesToHex(expected),
      )
      // Two PUSH1 per initialized byte (MSTORE8 costs zero), memory expansion, three MCOPY arguments,
      // then MCOPY's 3 Energy base fee and 3 Energy per copied word.
      assert.strictEqual(result.executionGasUsed, situation.energy)
    })
  }
})
