import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { assert, describe, expect, it } from 'vitest'

import { createBlockchain } from '../src/index.ts'

describe.each([TronMainnet, TronNile, TronShasta])(
  'TRON parent header validation on $name',
  (chain) => {
    it('validates the parent-derived fee and preserves the head after rejected headers', async () => {
      const common = new Common({ chain })
      const genesisBlock = createBlock(
        { header: { gasLimit: 1000000n, baseFeePerGas: 8n } },
        { common },
      )
      const blockchain = await createBlockchain({ common, genesisBlock, validateBlocks: true })
      const header = {
        number: 1n,
        parentHash: genesisBlock.hash(),
        timestamp: 1n,
        gasLimit: 1000000n,
        baseFeePerGas: 7n,
      }
      for (const override of [
        { baseFeePerGas: 8n },
        { baseFeePerGas: 1000000000n },
        { gasLimit: 2000000n },
        { gasLimit: 1000976n },
        { gasLimit: 999024n },
      ]) {
        const block = createBlock({ header: { ...header, ...override } }, { common })
        await expect(blockchain.putBlock(block)).rejects.toThrow(
          'baseFeePerGas' in override ? /base fee not correct/ : /gas limit .* too much/,
        )
        assert.deepEqual((await blockchain.getCanonicalHeadBlock()).hash(), genesisBlock.hash())
        assert.deepEqual((await blockchain.getCanonicalHeadHeader()).hash(), genesisBlock.hash())
      }
      const block = createBlock({ header }, { common })
      await blockchain.putBlock(block)
      assert.deepEqual((await blockchain.getCanonicalHeadBlock()).hash(), block.hash())
      assert.strictEqual((await blockchain.getCanonicalHeadHeader()).baseFeePerGas, 7n)
      const nextHeader = { ...header, number: 2n, parentHash: block.hash(), timestamp: 2n }
      const invalidChild = createBlock({ header: { ...nextHeader, baseFeePerGas: 8n } }, { common })
      await expect(blockchain.putBlock(invalidChild)).rejects.toThrow(/base fee not correct/)
      assert.deepEqual((await blockchain.getCanonicalHeadBlock()).hash(), block.hash())
      const validChild = createBlock({ header: nextHeader }, { common })
      await blockchain.putBlock(validChild)
      assert.deepEqual((await blockchain.getCanonicalHeadBlock()).hash(), validChild.hash())
    })
  },
)
