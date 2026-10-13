import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { createAddressFromString, hexToBytes } from '@tvmjs/util'
import { describe, expect, it, vi } from 'vitest'

import { createTVM } from '../src/index.ts'
import { defaultBlock } from '../src/tvm.ts'

describe.each([TronMainnet, TronNile, TronShasta])('Beacon root removal on $name', (chain) => {
  it('rejects old block contexts before state changes and leaves execution usable', async () => {
    const tvm = await createTVM({ common: new Common({ chain }) })
    const to = createAddressFromString(`0x${'11'.repeat(20)}`)
    const checkpoint = vi.spyOn(tvm.journal, 'checkpoint')
    const putAccount = vi.spyOn(tvm.stateManager, 'putAccount')
    const putStorage = vi.spyOn(tvm.stateManager, 'putStorage')
    for (const field of ['parentBeaconBlockRoot', 'parent_beacon_block_root']) {
      for (const value of [undefined, null, 0, '', new Uint8Array(), new Uint8Array(32)]) {
        const block = defaultBlock()
        Object.assign(block.header, { [field]: value })
        const error = `Beacon root block context field ${field} is no longer supported`
        await expect(
          tvm.runCall({ to, block, code: hexToBytes('0x600760005500') }),
        ).rejects.toThrow(error)
        await expect(
          tvm.runCode({ to, block, code: hexToBytes('0x600760005500') }),
        ).rejects.toThrow(error)
      }
    }
    expect(checkpoint).not.toHaveBeenCalled()
    expect(putAccount).not.toHaveBeenCalled()
    expect(putStorage).not.toHaveBeenCalled()
    expect(await tvm.stateManager.getAccount(to)).toBeUndefined()

    const result = await tvm.runCall({ to, code: hexToBytes('0x600760005500') })
    expect(result.execResult.exceptionError).toBeUndefined()
    expect(await tvm.stateManager.getStorage(to, new Uint8Array(32))).toEqual(new Uint8Array([7]))
  })
})
