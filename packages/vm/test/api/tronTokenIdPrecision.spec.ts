import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { MerklePatriciaTrie } from '@tvmjs/mpt'
import { MerkleStateManager, SimpleStateManager } from '@tvmjs/statemanager'
import { SIGNER_A } from '@tvmjs/testdata'
import { createLegacyTx } from '@tvmjs/tx'
import { createAccount, createAddressFromString, hexToBytes, tokenIdToKey } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { createVM, runTx } from '../../src/index.ts'

const LOW = 2n ** 53n
const HIGH = LOW + 1n
const recipient = createAddressFromString('0x2000000000000000000000000000000000000002')

it('accepts a TRC-10 transfer after rebuilding MerkleStateManager from persisted account state', async () => {
  const common = new Common({ chain: TronMainnet })
  const trie = new MerklePatriciaTrie({ useKeyHashing: true, common })
  const initial = new MerkleStateManager({ common, trie })
  await initial.putAccount(
    SIGNER_A.address,
    createAccount({
      balance: 10n ** 18n,
      asset: { [tokenIdToKey(1000001n)]: 5n },
    }),
  )

  // A new manager has no write-derived registry, but reads the account from
  // the persisted trie. The sender asset entry must be enough to validate it.
  const restarted = new MerkleStateManager({ common, trie })
  const vm = await createVM({ common, stateManager: restarted })
  const tx = createLegacyTx(
    { to: recipient, gasLimit: 100000n, gasPrice: 10n, tokenId: 1000001n, tokenValue: 3n },
    { common },
  ).sign(SIGNER_A.privateKey)

  const result = await runTx(vm, { tx })
  assert.isUndefined(result.execResult.exceptionError)
  assert.strictEqual((await restarted.getAccount(recipient))!.getTokenBalance(1000001n), 3n)
})

for (const chain of [TronMainnet, TronNile, TronShasta]) {
  for (const StateManager of [SimpleStateManager, MerkleStateManager]) {
    describe(`TRC-10 runTx: ${chain.name} / ${StateManager.name}`, () => {
      const setupVM = async () => {
        const common = new Common({ chain })
        return createVM({ common, stateManager: new StateManager({ common }) })
      }
      it('transfers the exact high token ID', async () => {
        const vm = await setupVM()
        await vm.stateManager.putAccount(
          SIGNER_A.address,
          createAccount({
            balance: 10n ** 18n,
            asset: { [tokenIdToKey(LOW)]: 5n, [tokenIdToKey(HIGH)]: 5n },
          }),
        )
        const tx = createLegacyTx(
          { to: recipient, gasLimit: 100000n, gasPrice: 10n, tokenId: HIGH, tokenValue: 3n },
          { common: vm.common },
        ).sign(SIGNER_A.privateKey)
        assert.strictEqual(tx.tokenId, HIGH)
        const result = await runTx(vm, { tx })
        assert.isUndefined(result.execResult.exceptionError)

        const sender = (await vm.stateManager.getAccount(SIGNER_A.address))!
        const to = (await vm.stateManager.getAccount(recipient))!
        assert.strictEqual(sender.getTokenBalance(HIGH), 2n)
        assert.strictEqual(sender.getTokenBalance(LOW), 5n)
        assert.strictEqual(to.getTokenBalance(HIGH), 3n)
        assert.strictEqual(to.getTokenBalance(LOW), 0n)
      })

      it('checks token existence by exact ID', async () => {
        const vm = await setupVM()
        await vm.stateManager.putAccount(
          SIGNER_A.address,
          createAccount({ balance: 10n ** 18n, asset: { [tokenIdToKey(HIGH)]: 5n } }),
        )
        const tx = createLegacyTx(
          { to: recipient, gasLimit: 100000n, gasPrice: 10n, tokenId: LOW, tokenValue: 1n },
          { common: vm.common },
        ).sign(SIGNER_A.privateKey)
        let error: unknown
        try {
          await runTx(vm, { tx })
        } catch (cause) {
          error = cause
        }
        assert.instanceOf(error, Error)
        assert.match((error as Error).message, /No asset/)
        assert.strictEqual(
          (await vm.stateManager.getAccount(SIGNER_A.address))!.getTokenBalance(HIGH),
          5n,
        )
      })

      it('executes signed Token transfers on a VM copy without changing the original balances', async () => {
        const vm = await setupVM()
        const ids = [1000088n, HIGH, 2n ** 63n - 1n]
        await vm.stateManager.checkpoint()
        await vm.stateManager.putAccount(
          SIGNER_A.address,
          createAccount({
            balance: 10n ** 18n,
            asset: Object.fromEntries(ids.map((id) => [tokenIdToKey(id), 5n])),
          }),
        )
        await vm.stateManager.commit()
        const copy = await vm.shallowCopy()
        for (const [index, tokenId] of ids.entries()) {
          const tx = createLegacyTx(
            {
              to: recipient,
              nonce: BigInt(index),
              gasLimit: 100000n,
              gasPrice: 10n,
              tokenId,
              tokenValue: 3n,
            },
            { common: copy.common },
          ).sign(SIGNER_A.privateKey)
          const result = await runTx(copy, { tx })
          assert.isUndefined(result.execResult.exceptionError)
          assert.strictEqual(
            (await copy.stateManager.getAccount(recipient))!.getTokenBalance(tokenId),
            3n,
          )
          assert.strictEqual(
            (await copy.stateManager.getAccount(SIGNER_A.address))!.getTokenBalance(tokenId),
            2n,
          )
          assert.strictEqual(
            (await vm.stateManager.getAccount(SIGNER_A.address))!.getTokenBalance(tokenId),
            5n,
          )
        }
        assert.isUndefined(await vm.stateManager.getAccount(recipient))
        assert.strictEqual((await vm.stateManager.getAccount(SIGNER_A.address))!.nonce, 0n)
      })

      it.each([
        ['0x60006000fd', 'revert'],
        ['0x5b600056', 'out of gas'],
      ] as const)(
        'reverts attached Token transfers after %s and permits a later transaction',
        async (code, error) => {
          const vm = await setupVM()
          await vm.stateManager.putAccount(
            SIGNER_A.address,
            createAccount({
              balance: 10n ** 18n,
              asset: { [tokenIdToKey(HIGH)]: 5n },
            }),
          )
          await vm.stateManager.putCode(recipient, hexToBytes(code))
          const tx = createLegacyTx(
            { to: recipient, gasLimit: 30000n, gasPrice: 10n, tokenId: HIGH, tokenValue: 3n },
            { common: vm.common },
          ).sign(SIGNER_A.privateKey)
          const result = await runTx(vm, { tx })
          assert.strictEqual(result.execResult.exceptionError?.error, error)
          assert.isTrue(await vm.stateManager.tokenIdExists(HIGH))
          assert.isFalse(await vm.stateManager.tokenIdExists(LOW))
          assert.strictEqual(
            (await vm.stateManager.getAccount(SIGNER_A.address))!.getTokenBalance(HIGH),
            5n,
          )
          assert.strictEqual(
            (await vm.stateManager.getAccount(recipient))!.getTokenBalance(HIGH),
            0n,
          )
          await vm.stateManager.putCode(recipient, hexToBytes('0x00'))
          const next = createLegacyTx(
            {
              to: recipient,
              nonce: 1n,
              gasLimit: 30000n,
              gasPrice: 10n,
              tokenId: HIGH,
              tokenValue: 3n,
            },
            { common: vm.common },
          ).sign(SIGNER_A.privateKey)
          assert.isUndefined((await runTx(vm, { tx: next })).execResult.exceptionError)
          assert.strictEqual(
            (await vm.stateManager.getAccount(recipient))!.getTokenBalance(HIGH),
            3n,
          )
        },
      )
    })
  }
}
