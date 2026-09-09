import { Common, Mainnet, TronNile } from '@tvmjs/common'
import { Address, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { TVMError, createTVM } from '../src/index.ts'

const CALLER = new Address(hexToBytes('0x00000000000000000000000000000000000000ee'))
const CONTRACT = new Address(hexToBytes('0x00000000000000000000000000000000000000ff'))

// STATICCALL with 192 bytes of zero calldata, then POP the result. The payload is neither a valid
// 0x09 batchValidateSign shape (160 + 192k) nor a valid 0x0a validateMultiSign shape (160 + 160k).
const INVALID_PRECOMPILE_CALLS = [
  ['0x09', hexToBytes('0x6000600060c0600060095afa5000')],
  ['0x0a', hexToBytes('0x6000600060c06000600a5afa5000')],
] as const

describe('TRON Osaka compatibility gates', () => {
  it.each(INVALID_PRECOMPILE_CALLS)(
    'burns the full parent frame when Osaka rejects invalid %s calldata',
    async (_address, code) => {
      const common = new Common({ chain: TronNile, activatedProposals: [96] })
      const tvm = await createTVM({ common })
      await tvm.stateManager.putCode(CONTRACT, code)

      const gasLimit = 100000n
      const result = await tvm.runCall({ caller: CALLER, to: CONTRACT, gasLimit })

      assert.strictEqual(result.execResult.executionGasUsed, gasLimit)
      assert.strictEqual(result.execResult.exceptionError?.error, TVMError.errorMessages.OUT_OF_GAS)
    },
  )

  it.each(INVALID_PRECOMPILE_CALLS)(
    'keeps pre-Osaka TRON behavior for malformed %s calldata',
    async (_address, code) => {
      const common = new Common({ chain: TronNile })
      const tvm = await createTVM({ common })
      await tvm.stateManager.putCode(CONTRACT, code)

      const result = await tvm.runCall({ caller: CALLER, to: CONTRACT, gasLimit: 100000n })

      assert.isUndefined(result.execResult.exceptionError)
    },
  )

  it.each(INVALID_PRECOMPILE_CALLS)(
    'does not apply the TRON Osaka %s gate to Ethereum',
    async (_address, code) => {
      const common = new Common({ chain: Mainnet })
      const tvm = await createTVM({ common })
      await tvm.stateManager.putCode(CONTRACT, code)

      const result = await tvm.runCall({ caller: CALLER, to: CONTRACT, gasLimit: 100000n })

      assert.isUndefined(result.execResult.exceptionError)
    },
  )
})
