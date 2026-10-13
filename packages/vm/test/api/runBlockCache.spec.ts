import { createBlock } from '@tvmjs/block'
import { CacheType, Caches, MerkleStateManager } from '@tvmjs/statemanager'
import { SIGNER_A, SIGNER_B } from '@tvmjs/testdata'
import { createLegacyTx } from '@tvmjs/tx'
import { Account, bytesToBigInt, bytesToHex, hexToBytes } from '@tvmjs/util'
import { assert, describe, expect, it } from 'vitest'

import { createVM, runBlock } from '../../src/index.ts'

import type { Block } from '@tvmjs/block'
import type { StateManagerInterface } from '@tvmjs/common'

const balance = 1000000000000000000n
const code = hexToBytes('0x600760005500')
const slot = new Uint8Array(32)

async function seed(state: StateManagerInterface) {
  await state.putAccount(SIGNER_A.address, new Account(0n, balance))
  await state.putCode(SIGNER_B.address, code)
  return state.getStateRoot()
}

async function readState(state: StateManagerInterface) {
  const root = await state.getStateRoot()
  const account = await state.getAccount(SIGNER_A.address)
  return {
    root: bytesToHex(root),
    nonce: account?.nonce,
    balance: account?.balance,
    storage: bytesToBigInt(await state.getStorage(SIGNER_B.address, slot)),
    code: bytesToHex(await state.getCode(SIGNER_B.address)),
  }
}

describe.each([undefined, CacheType.ORDERED_MAP, CacheType.LRU])(
  'runBlock state rollback with cache type %s',
  (type) => {
    it('restores all readable state after rejecting a block and then accepts a valid block', async () => {
      const caches =
        type === undefined
          ? undefined
          : new Caches({ account: { type }, code: { type }, storage: { type } })
      const state = new MerkleStateManager({ caches })
      const vm = await createVM({ stateManager: state })
      const root = await seed(state)
      const initial = await readState(state)
      assert.strictEqual(initial.balance, balance)
      assert.strictEqual(initial.nonce, 0n)
      assert.strictEqual(initial.storage, 0n)

      const reference = await createVM()
      assert.deepEqual(await seed(reference.stateManager), root)
      const tx = createLegacyTx(
        { to: SIGNER_B.address, gasLimit: 100000n, gasPrice: 10n },
        { common: vm.common },
      ).sign(SIGNER_A.privateKey)
      const template = createBlock(
        { header: { gasLimit: 1000000n, number: 1n }, transactions: [tx] },
        { common: vm.common },
      )
      let validBlock: Block | undefined
      reference.events.once('afterBlock', ({ block }) => {
        validBlock = block
      })
      const expected = await runBlock(reference, {
        block: template,
        generate: true,
        skipBlockValidation: true,
      })
      assert.isUndefined(expected.results[0].execResult.exceptionError)
      assert.isDefined(validBlock)
      const invalidBlock = createBlock(
        {
          ...validBlock!,
          header: { ...validBlock!.header, stateRoot: new Uint8Array(32).fill(0xff) },
        },
        { common: vm.common },
      )

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          runBlock(vm, { block: invalidBlock, skipBlockValidation: true }),
        ).rejects.toThrow('invalid block stateRoot')
        assert.deepEqual(await readState(state), initial)
      }
      state.clearCaches()
      assert.deepEqual(await readState(state), initial)

      await runBlock(vm, { block: validBlock!, skipBlockValidation: true })
      const result = await readState(state)
      assert.deepEqual(result, await readState(reference.stateManager))
      assert.strictEqual(result.storage, 7n)
      assert.strictEqual(result.nonce, 1n)
      assert.strictEqual(result.balance, balance - expected.gasUsed * 10n)
      assert.strictEqual(result.root, bytesToHex(expected.stateRoot))
    })
  },
)
