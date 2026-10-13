import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet } from '@tvmjs/common'
import { MerkleStateManager, SimpleStateManager } from '@tvmjs/statemanager'
import { SIGNER_A } from '@tvmjs/testdata'
import { createLegacyTx } from '@tvmjs/tx'
import { hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import {
  captureReferenceResult,
  initializeReferenceState,
  referenceInputs,
} from '../../../tvm/test/referenceExecution.ts'
import measured from '../../../tvm/test/testdata/javaTronExecution.json' with { type: 'json' }
import { createVM, runTx } from '../../src/index.ts'

for (const StateManager of [SimpleStateManager, MerkleStateManager]) {
  describe(`java-tron execution through runTx / ${StateManager.name}`, () => {
    for (const [index, vector] of referenceInputs.cases.entries()) {
      it(vector.name, async () => {
        const common = new Common({ chain: TronMainnet, activatedProposals: [] })
        const vm = await createVM({ common, stateManager: new StateManager({ common }) })
        await initializeReferenceState(vm.stateManager, vector)
        assert.strictEqual(SIGNER_A.address.toString(), referenceInputs.context.caller)
        assert.strictEqual(measured.cases[index].name, vector.name)
        // Zero-priced local envelope isolates execution balance changes from network fees.
        const tx = createLegacyTx(
          {
            to: referenceInputs.context.contract,
            gasLimit: BigInt(vector.energyLimit) + 21000n,
            gasPrice: 0n,
          },
          { common: vm.common },
        ).sign(SIGNER_A.privateKey)
        const result = await runTx(vm, {
          tx,
          block: createBlock({ header: { baseFeePerGas: 0n } }, { common: vm.common }),
          rootTransactionId: hexToBytes(referenceInputs.context.rootTransactionId),
        })
        assert.deepEqual(
          await captureReferenceResult(vm.stateManager, vector, result.execResult),
          measured.cases[index],
        )
        assert.strictEqual(result.gasRefund, 0n)
        assert.strictEqual(
          result.totalGasSpent,
          BigInt(measured.cases[index].energy) + tx.getIntrinsicGas(),
        )
      })
    }
  })
}
