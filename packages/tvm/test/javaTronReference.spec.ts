import { sha256 } from '@noble/hashes/sha2.js'
import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { MerkleStateManager, SimpleStateManager } from '@tvmjs/statemanager'
import { bytesToHex, createAddressFromString, hexToBytes, utf8ToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import { Message, createTVM } from '../src/index.ts'
import {
  captureReferenceResult,
  initializeReferenceState,
  referenceInputs,
} from './referenceExecution.ts'
import measured from './testdata/javaTronExecution.json' with { type: 'json' }

it('binds the captured results to the exact inputs and upstream configuration', () => {
  assert.strictEqual(
    bytesToHex(sha256(utf8ToBytes(JSON.stringify(referenceInputs)))).slice(2),
    measured.provenance.inputSha256,
  )
  assert.deepEqual(measured.reference, referenceInputs.reference)
  assert.deepEqual(measured.configuration, referenceInputs.configuration)
  assert.deepEqual(
    measured.cases.map(({ name }) => name),
    referenceInputs.cases.map(({ name }) => name),
  )
})

for (const chain of [TronMainnet, TronNile, TronShasta]) {
  for (const StateManager of [SimpleStateManager, MerkleStateManager]) {
    describe(`java-tron engine: ${chain.name} / ${StateManager.name}`, () => {
      for (const [index, vector] of referenceInputs.cases.entries()) {
        it(vector.name, async () => {
          assert.strictEqual(measured.cases[index].name, vector.name)
          const tvm = await createTVM({
            common: new Common({ chain, activatedProposals: [] }),
            stateManager: new StateManager(),
          })
          await initializeReferenceState(tvm.stateManager, vector)
          const { context } = referenceInputs
          const { execResult } = await tvm.runCall({
            caller: createAddressFromString(context.caller),
            origin: createAddressFromString(context.caller),
            to: createAddressFromString(context.contract),
            rootTransactionId: hexToBytes(context.rootTransactionId),
            gasLimit: BigInt(vector.energyLimit),
          })
          assert.deepEqual(
            await captureReferenceResult(tvm.stateManager, vector, execResult),
            measured.cases[index],
          )
          assert.strictEqual(execResult.gasRefund, 0n)
        })
      }

      it.each(['runCall', 'runCode'] as const)(
        'does not carry zero-slot presence into a later %s execution',
        async (entry) => {
          const tvm = await createTVM({
            common: new Common({ chain, activatedProposals: [] }),
            stateManager: new StateManager(),
          })
          await initializeReferenceState(tvm.stateManager, referenceInputs.cases[0])
          const message = new Message({
            to: createAddressFromString(referenceInputs.context.contract),
            caller: createAddressFromString(referenceInputs.context.caller),
            gasLimit: 100000n,
          })
          for (const [code, energy] of [
            ['0x600060005500', 5006n],
            ['0x600160005500', 20006n],
            ['0x600060005500', 5006n],
            ['0x600160005500', 20006n],
          ] as const) {
            message.code = hexToBytes(code)
            const result =
              entry === 'runCall'
                ? (await tvm.runCall({ message })).execResult
                : await tvm.runCode({
                    to: message.to,
                    caller: message.caller,
                    code: message.code,
                    gasLimit: 100000n,
                  })
            assert.isUndefined(result.exceptionError)
            assert.strictEqual(result.executionGasUsed, energy)
          }
        },
      )
    })
  }
}
