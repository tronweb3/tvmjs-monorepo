import { createBlock } from '@tvmjs/block'
import { createBlockchain } from '@tvmjs/blockchain'
import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { MerkleStateManager } from '@tvmjs/statemanager'
import { createTVM, getActivePrecompiles } from '@tvmjs/tvm'
import { createLegacyTx } from '@tvmjs/tx'
import { Account, createAddressFromPrivateKey, createZeroAddress, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createVM, runTx } from '../../src/index.ts'

describe('TRON configuration across execution entry points', () => {
  for (const [chain, expectedChainId] of [
    [TronMainnet, 728126428n],
    [TronNile, 3448148188n],
    [TronShasta, 2494104990n],
  ] as const) {
    it(`${chain.name}: executes CHAINID without consensus metadata`, async () => {
      const common = new Common({ chain })
      const vm = await createVM({ common })
      const tvm = await createTVM({ common: common.copy() })
      for (const engine of [vm.tvm, tvm]) {
        const result = await engine.runCode({ code: hexToBytes('0x4600'), gasLimit: 100n })
        assert.isUndefined(result.exceptionError)
        assert.deepEqual(result.runState!.stack.getStack(), [expectedChainId])
        assert.strictEqual(result.executionGasUsed, 2n)
      }
      assert.strictEqual(vm.common, vm.tvm.common)
      assert.isFalse(vm.common.hasConsensus())
      const precompiles = getActivePrecompiles(common)
      for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        assert.isTrue(precompiles.has(id.toString(16).padStart(40, '0')), `precompile ${id}`)
      }
    })
  }

  it('defaults transactions, blocks, state and engines to the same network', async () => {
    const vm = await createVM()
    assert.strictEqual(vm.common.chainId(), 728126428n)
    assert.strictEqual((await createTVM()).common.chainId(), vm.common.chainId())
    assert.strictEqual(new MerkleStateManager().common.chainId(), vm.common.chainId())
    assert.strictEqual(createBlock().common.chainId(), vm.common.chainId())
    assert.strictEqual(createLegacyTx({}).common.chainId(), vm.common.chainId())
  })

  it('accepts equivalent Common instances and preserves caller options', async () => {
    const common = new Common({ chain: TronNile, activatedProposals: [96, 95] })
    const tvm = await createTVM(Object.freeze({ common: common.copy() }))
    const opts = Object.freeze({ common, tvm })
    const vm = await createVM(opts)
    assert.strictEqual(vm.common, tvm.common)
    assert.strictEqual(opts.common, common)
    assert.deepEqual(vm.common.activatedProposals(), [95, 96])
  })

  it('rejects conflicting networks, proposals, EIPs and supplied parameter values', async () => {
    const base = new Common({ chain: TronMainnet, params: { tron: { balanceGas: 20 } } })
    const conflicts = [
      new Common({ chain: TronNile }),
      new Common({ chain: TronMainnet, activatedProposals: [96] }),
      new Common({ chain: TronMainnet, eips: [7939] }),
      new Common({ chain: TronMainnet, params: { tron: { balanceGas: 21 } } }),
    ]
    for (const common of conflicts) {
      await assertRejected(createVM({ common: base, tvmOpts: { common } }), /Conflicting Common/)
      const tvm = await createTVM({ common })
      await assertRejected(createVM({ common: base, tvm }), /Conflicting Common/)
    }
  })

  it('does not discard a supplied parameter override when tvmOpts.common starts without parameters', async () => {
    const common = new Common({ chain: TronMainnet, params: { tron: { balanceGas: 21 } } })
    await assertRejected(
      createVM({
        common,
        tvmOpts: { common: new Common({ chain: TronMainnet }) },
      }),
      /Conflicting Common/,
    )
    const vm = await createVM({ common, tvmOpts: { common: common.copy() } })
    assert.strictEqual(vm.common.param('balanceGas'), 21n)
  })

  it('does not discard supplied genesis metadata behind an execution-only tvmOpts.common', async () => {
    const genesis = {
      gasLimit: 1000000,
      difficulty: 0,
      nonce: '0x0000000000000000',
      extraData: '0x',
    } as const
    const common = new Common({ chain: { ...TronMainnet, genesis } })
    assert.isTrue(common.hasGenesis())
    await assertRejected(
      createVM({ common, tvmOpts: { common: new Common({ chain: TronMainnet }) } }),
      /Conflicting Common/,
    )
    await assertRejected(
      createVM({ common: new Common({ chain: TronMainnet }), tvmOpts: { common } }),
      /Conflicting Common/,
    )
    const vm = await createVM({ common, tvmOpts: { common: common.copy() } })
    assert.isTrue(vm.common.hasGenesis())
    assert.deepEqual(vm.common.genesis(), genesis)
  })

  it('accepts equivalent genesis and consensus metadata regardless of key order', async () => {
    const genesis = {
      gasLimit: 1000000,
      difficulty: 0,
      nonce: '0x0000000000000000',
      extraData: '0x',
    } as const
    const reorderedGenesis = {
      extraData: '0x',
      nonce: '0x0000000000000000',
      difficulty: 0,
      gasLimit: 1000000,
    } as const
    const common = new Common({ chain: { ...TronMainnet, genesis } })
    const equivalent = new Common({ chain: { ...TronMainnet, genesis: reorderedGenesis } })
    assert.isTrue(common.isCompatibleWith(equivalent))
    assert.isTrue(equivalent.isCompatibleWith(common))
    const vm = await createVM({ common, tvmOpts: { common: equivalent } })
    assert.deepEqual(vm.common.genesis(), genesis)

    const consensus = { type: 'custom', algorithm: 'fibonacci' } as const
    const withConsensus = new Common({ chain: { ...TronMainnet, consensus } })
    const reorderedConsensus = new Common({
      chain: { ...TronMainnet, consensus: { algorithm: 'fibonacci', type: 'custom' } },
    })
    assert.isTrue(withConsensus.isCompatibleWith(reorderedConsensus))
    assert.isFalse(withConsensus.isCompatibleWith(common))
  })

  it('runs a default signed transaction and rejects a different chainId', async () => {
    const privateKey = hexToBytes(`0x${'01'.repeat(32)}`)
    const vm = await createVM()
    await vm.stateManager.putAccount(
      createAddressFromPrivateKey(privateKey),
      new Account(0n, 1000000n),
    )
    const data = { to: createZeroAddress(), gasLimit: 21000n, gasPrice: 10n, value: 1n }
    const tx = createLegacyTx(data).sign(privateKey)
    const result = await runTx(vm, { tx })
    assert.isUndefined(result.execResult.exceptionError)
    const foreign = createLegacyTx(
      { ...data, nonce: 1n },
      { common: new Common({ chain: TronNile }) },
    ).sign(privateKey)
    await assertRejected(runTx(vm, { tx: foreign }), /different chainId/)
  })

  it('requires explicit genesis input for a Blockchain and supports a supplied execution block', async () => {
    await assertRejected(createBlockchain(), /explicit genesisBlock/)
    const common = new Common({ chain: TronNile })
    const genesisBlock = createBlock({ header: { number: 0 } }, { common })
    const blockchain = await createBlockchain({ common, genesisBlock })
    assert.deepEqual((await blockchain.getBlock(0n)).hash(), genesisBlock.hash())
    assert.isUndefined(blockchain.consensus)
    await assertRejected(
      createBlockchain({ common, genesisBlock, validateConsensus: true }),
      /requires explicit network metadata/,
    )
    await assertRejected(createBlockchain({ genesisBlock }), /different chainId/)
  })
})

async function assertRejected(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown
  try {
    await promise
  } catch (cause) {
    error = cause
  }
  assert.instanceOf(error, Error)
  assert.match((error as Error).message, pattern)
}
