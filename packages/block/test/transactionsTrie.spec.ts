import { Common, TronMainnet } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import { assert, describe, expect, it } from 'vitest'

import { createBlock, createBlockFromRLP, genTransactionsTrieRoot } from '../src/index.ts'

import { signingKey } from './helpers.ts'

describe.each([true, false])('transaction trie revalidation (freeze: %s)', (freeze) => {
  const common = new Common({ chain: TronMainnet })
  const signedTransaction = (nonce: number) =>
    createLegacyTx(
      {
        nonce,
        to: `0x${'11'.repeat(20)}`,
        gasLimit: 30000n,
        gasPrice: 7n,
        data: '0x01',
      },
      { common },
    ).sign(signingKey)

  it.each(['replace', 'append', 'remove', 'reorder'] as const)(
    'rejects a changed transaction list after %s',
    async (operation) => {
      const first = signedTransaction(0)
      const second = signedTransaction(1)
      const original = operation === 'remove' || operation === 'reorder' ? [first, second] : [first]
      const block = createBlock(
        {
          header: { transactionsTrie: await genTransactionsTrieRoot(original) },
          transactions: original,
        },
        { common, freeze },
      )
      const initialTransactions = block.transactions.slice()
      await expect(block.validateData()).resolves.toBeUndefined()

      // Factories copy the input array; mutate the block's own transaction list.
      switch (operation) {
        case 'replace':
          block.transactions[0] = second
          break
        case 'append':
          block.transactions.push(second)
          break
        case 'remove':
          block.transactions.pop()
          break
        case 'reorder':
          block.transactions.reverse()
          break
      }

      assert.isTrue(block.transactionsAreValid())
      assert.notDeepEqual(await block.genTxTrie(), block.header.transactionsTrie)
      const restored = createBlockFromRLP(block.serialize(), { common, freeze })
      await expect(restored.validateData()).rejects.toThrow('invalid transaction trie')
      await expect(block.validateData()).rejects.toThrow('invalid transaction trie')
      await expect(block.validateData(false, false)).rejects.toThrow('invalid transaction trie')
      assert.isFalse(await block.transactionsTrieIsValid())

      block.transactions.splice(0, block.transactions.length, ...initialTransactions)
      await expect(block.validateData()).resolves.toBeUndefined()
    },
  )

  it('accepts a corrected transaction list after a failed validation', async () => {
    const expected = signedTransaction(0)
    const block = createBlock(
      {
        header: { transactionsTrie: await genTransactionsTrieRoot([expected]) },
        transactions: [signedTransaction(1)],
      },
      { common, freeze },
    )
    await expect(block.validateData()).rejects.toThrow('invalid transaction trie')

    block.transactions[0] = expected

    await expect(block.validateData()).resolves.toBeUndefined()
    assert.isTrue(await block.transactionsTrieIsValid())
  })

  it('rechecks serialized transaction contents even when array entries are unchanged', async () => {
    const tx = signedTransaction(0)
    const block = createBlock(
      { header: { transactionsTrie: await genTransactionsTrieRoot([tx]) }, transactions: [tx] },
      { common, freeze },
    )
    await expect(block.validateData()).resolves.toBeUndefined()

    block.transactions[0].data[0] = 2

    assert.notDeepEqual(await block.genTxTrie(), block.header.transactionsTrie)
    assert.isFalse(await block.transactionsTrieIsValid())
    await expect(block.validateData(false, false)).rejects.toThrow('invalid transaction trie')
  })

  it('does not reuse a previous root after clearing and refilling the list', async () => {
    const tx = signedTransaction(0)
    const block = createBlock(
      { header: { transactionsTrie: await genTransactionsTrieRoot([tx]) }, transactions: [tx] },
      { common, freeze },
    )
    await expect(block.validateData()).resolves.toBeUndefined()

    block.transactions.length = 0
    await expect(block.validateData()).rejects.toThrow('invalid transaction trie')
    block.transactions.push(signedTransaction(1))

    await expect(block.validateData()).rejects.toThrow('invalid transaction trie')
  })
})
