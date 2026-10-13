import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { createAddressFromString, hexToBytes } from '@tvmjs/util'
import { describe, expect, it } from 'vitest'

import { Message, createTVM } from '../src/index.ts'
import { precompile0a } from '../src/precompiles/0a-validate-multi-sign.ts'
import { defaultBlock } from '../src/tvm.ts'

describe.each([TronMainnet, TronNile, TronShasta])('Blob removal on $name', (chain) => {
  it('rejects Blob fields in caller-supplied block contexts', async () => {
    const tvm = await createTVM({ common: new Common({ chain }) })
    for (const field of ['blobGasUsed', 'excessBlobGas', 'getBlobGasPrice']) {
      const block = defaultBlock()
      Object.assign(block.header, { [field]: undefined })
      await expect(tvm.runCall({ block })).rejects.toThrow(`Blob block context field ${field}`)
      await expect(tvm.runCode({ block, code: new Uint8Array([0]) })).rejects.toThrow(
        `Blob block context field ${field}`,
      )
    }
    expect((await tvm.runCode({ code: new Uint8Array([0]) })).exceptionError).toBeUndefined()
  })

  it('keeps Blob opcodes invalid and the TRON multi-sign and Token opcodes registered', async () => {
    const tvm = await createTVM({ common: new Common({ chain }) })
    for (const opcode of ['49', '4a']) {
      const result = await tvm.runCode({ code: hexToBytes(`0x6000${opcode}`), gasLimit: 1000n })
      expect(result.exceptionError?.error).toBe('invalid opcode')
    }
    const opcodes = tvm.getActiveOpcodes()
    expect(opcodes.has(0x49)).toBe(false)
    expect(opcodes.has(0x4a)).toBe(false)
    for (const [code, mnemonic] of [
      [0xd0, 'CALLTOKEN'],
      [0xd1, 'TOKENBALANCE'],
      [0xd2, 'CALLTOKENVALUE'],
      [0xd3, 'CALLTOKENID'],
    ] as const) {
      expect(opcodes.get(code)?.name).toBe(mnemonic)
    }
    expect(tvm.getPrecompile(createAddressFromString(`0x${'00'.repeat(19)}0a`))).toBe(precompile0a)
  })

  it('rejects removed message and execution fields before touching state or acquiring an execution lock', async () => {
    const tvm = await createTVM({ common: new Common({ chain }) })
    const to = createAddressFromString(`0x${'11'.repeat(20)}`)
    for (const value of [undefined, null, [], ['0x00']]) {
      expect(() => new Message({ gasLimit: 1000n, blobVersionedHashes: value } as any)).toThrow(
        'blobVersionedHashes is no longer supported',
      )
      await expect(tvm.runCall({ to, blobVersionedHashes: value } as any)).rejects.toThrow(
        'blobVersionedHashes is no longer supported',
      )
      await expect(
        tvm.runCode({ to, code: new Uint8Array(), blobVersionedHashes: value } as any),
      ).rejects.toThrow('blobVersionedHashes is no longer supported')
      const message = new Message({ to, gasLimit: 1000n })
      Object.assign(message, { blobVersionedHashes: value })
      await expect(tvm.runCall({ message })).rejects.toThrow(
        'blobVersionedHashes is no longer supported',
      )
    }
    expect(await tvm.stateManager.getAccount(to)).toBeUndefined()
    expect((await tvm.runCode({ code: new Uint8Array([0]) })).exceptionError).toBeUndefined()
  })
})
