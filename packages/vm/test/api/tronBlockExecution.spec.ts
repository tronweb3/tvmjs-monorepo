import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { Account, createAddressFromString } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { buildBlock, createVM, runBlock } from '../../src/index.ts'

const daoAddresses = [
  '0xd4fe7bc31cedb7bfb8a345f31e668033056b2728',
  '0xb3fb0e5aba0e20e5c49d252dfd30e102b171a425',
  '0xbf4ed7b27f1d666546e30d74d50d173d20bca754',
].map(createAddressFromString)

describe.each([TronMainnet, TronNile, TronShasta])('TRON block execution on $name', (chain) => {
  it.each([0n, 500000n, 1000000n])(
    'derives builder defaults from a parent using %s gas',
    async (gasUsed) => {
      const common = new Common({ chain })
      const vm = await createVM({ common })
      const parentBlock = createBlock(
        { header: { number: 12964999n, gasLimit: 1000000n, gasUsed, baseFeePerGas: 8n } },
        { common },
      )
      const builder = await buildBlock(vm, {
        parentBlock,
        headerData: { timestamp: 1n },
        blockOpts: { putBlockIntoBlockchain: false },
      })
      const { block } = await builder.build()
      assert.strictEqual(block.header.number, 12965000n)
      assert.strictEqual(block.header.gasLimit, 1000000n)
      assert.strictEqual(
        block.header.baseFeePerGas,
        gasUsed === 0n ? 7n : gasUsed === 500000n ? 8n : 9n,
      )
      assert.doesNotThrow(() => block.header.validateGasLimit(parentBlock.header))
    },
  )

  it('preserves explicit builder fees and gas limits', async () => {
    const common = new Common({ chain })
    const vm = await createVM({ common })
    const parentBlock = createBlock(
      { header: { gasLimit: 1000000n, baseFeePerGas: 8n } },
      { common },
    )
    const builder = await buildBlock(vm, {
      parentBlock,
      headerData: { baseFeePerGas: 0n, gasLimit: 1000001n, timestamp: 1n },
      blockOpts: { putBlockIntoBlockchain: false },
    })
    const { block } = await builder.build()
    assert.strictEqual(block.header.baseFeePerGas, 0n)
    assert.strictEqual(block.header.gasLimit, 1000001n)
  })

  it.each([false, true])(
    'leaves DAO balances and absent accounts unchanged with refund account present=%s',
    async (present) => {
      const common = new Common({ chain })
      const vm = await createVM({ common })
      await vm.stateManager.putAccount(daoAddresses[0], new Account(0n, 0x1111n))
      await vm.stateManager.putAccount(daoAddresses[1], new Account(0n, 0x2222n))
      if (present) await vm.stateManager.putAccount(daoAddresses[2], new Account(0n, 0x4444n))
      const root = await vm.stateManager.getStateRoot()
      for (const number of [1n, 1920000n, 1920009n]) {
        const block = createBlock(
          { header: { number, gasLimit: 1000000n, extraData: '0x1234' } },
          { common },
        )
        const result = await runBlock(vm, {
          block,
          generate: true,
          skipBlockValidation: true,
          setHardfork: true,
        })
        assert.deepEqual(result.stateRoot, root)
        assert.strictEqual(result.gasUsed, 0n)
        assert.deepEqual(result.receipts, [])
        assert.strictEqual((await vm.stateManager.getAccount(daoAddresses[0]))!.balance, 0x1111n)
        assert.strictEqual((await vm.stateManager.getAccount(daoAddresses[1]))!.balance, 0x2222n)
        assert.strictEqual(
          (await vm.stateManager.getAccount(daoAddresses[2]))?.balance,
          present ? 0x4444n : undefined,
        )
      }
    },
  )
})
