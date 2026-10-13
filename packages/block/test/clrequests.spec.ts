import { sha256 } from '@noble/hashes/sha2.js'
import { Common, TronMainnet } from '@tvmjs/common'
import { bytesToHex, createCLRequest, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createBlock, genRequestsRoot } from '../src/index.ts'

import type { CLRequest, CLRequestType } from '@tvmjs/util'

describe('[Block]: CLRequests tests', () => {
  const common = new Common({ chain: TronMainnet })

  function createDepositRequest(): CLRequest<CLRequestType> {
    // Example deposit data
    const sampleDepositRequest = hexToBytes(
      '0x00ac842878bb70009552a4cfcad801d6e659c50bd50d7d03306790cb455ce7363c5b6972f0159d170f625a99b2064dbefc010000000000000000000000818ccb1c4eda80270b04d6df822b1e72dd83c3030040597307000000a747f75c72d0cf0d2b52504c7385b516f0523e2f0842416399f42b4aee5c6384a5674f6426b1cc3d0827886fa9b909e616f5c9f61f986013ed2b9bf37071cbae951136265b549f44e3c8e26233c0433e9124b7fd0dc86e82f9fedfc0a179d7690000000000000000',
    )
    return createCLRequest(sampleDepositRequest)
  }

  function createWithdrawalRequest(): CLRequest<CLRequestType> {
    // Type 1 (Withdrawal) + example data
    const withdrawalData = hexToBytes(
      '0x01000000000000000000000000000000000000000001000000000000000000000de0b6b3a7640000',
    )
    return createCLRequest(withdrawalData)
  }

  function createConsolidationRequest(): CLRequest<CLRequestType> {
    // Type 2 (Consolidation) + example data
    const consolidationData = hexToBytes('0x020000000100000000000000000000000000000000000001')
    return createCLRequest(consolidationData)
  }

  it('hashes a deposit request as data and rejects it in a TRON block', () => {
    const requestsHash = genRequestsRoot([createDepositRequest()], sha256)
    assert.strictEqual(
      bytesToHex(requestsHash),
      '0xcda208fdf27463bbf25fa3a89c4207752d4060ec06a6afb4903c24bc621f19a4',
    )
    assert.throws(() => createBlock({ header: { requestsHash } }, { common }), 'EIP 7685')
  })

  it('hashes a withdrawal request as data and rejects it in a TRON block', () => {
    const requestsHash = genRequestsRoot([createWithdrawalRequest()], sha256)
    assert.strictEqual(
      bytesToHex(requestsHash),
      '0x2139fa96081c4bc9ac4cb48ed391744d17ad24941e31ddcf0bc91857fb2bf3f2',
    )
    assert.throws(() => createBlock({ header: { requestsHash } }, { common }), 'EIP 7685')
  })

  it('hashes a consolidation request as data and rejects it in a TRON block', () => {
    const requestsHash = genRequestsRoot([createConsolidationRequest()], sha256)
    assert.strictEqual(
      bytesToHex(requestsHash),
      '0x67a037b7b1e7189b7181168fd34b8622b490acd1fb089de140620243b98db661',
    )
    assert.throws(() => createBlock({ header: { requestsHash } }, { common }), 'EIP 7685')
  })

  it('hashes multiple request types without enabling execution requests', () => {
    const requests = [
      createDepositRequest(),
      createWithdrawalRequest(),
      createConsolidationRequest(),
    ]
    assert.strictEqual(
      bytesToHex(genRequestsRoot(requests, sha256)),
      '0xa506a2636d5f9ea89875b83c3ad5f18d26c5dd377d5cef89fc8604372a0f54a2',
    )
    assert.isFalse(common.isActivatedEIP(7685))
    assert.throws(() => common.setEIPs([7685]))
  })

  it('should validate the requests are sorted by type', () => {
    const depositRequest = createDepositRequest()
    const withdrawalRequest = createWithdrawalRequest()

    // Requests in wrong order should throw
    const requests = [withdrawalRequest, depositRequest]

    assert.throws(
      () => genRequestsRoot(requests, sha256),
      'requests are not sorted in ascending order',
      'should throw when requests are not sorted by type',
    )
  })
})
