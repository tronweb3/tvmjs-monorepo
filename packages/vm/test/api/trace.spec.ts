import { Common, TronMainnet } from '@tvmjs/common'
import { SIGNER_A } from '@tvmjs/testdata'
import { createLegacyTx } from '@tvmjs/tx'
import { Account, bytesToHex, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { assert, it } from 'vitest'
import { createVM, runTx } from '../../src/index.ts'
import { stepTraceJSON, summaryTraceJSON } from '../trace.ts'

it('reports TRON instruction, memory and receipt traces', async () => {
  const vm = await createVM({
    common: new Common({ chain: TronMainnet, activatedProposals: [] }),
  })
  const contract = createAddressFromString('0x' + '44'.repeat(20))
  await vm.stateManager.putCode(contract, hexToBytes('0x604260005260206000f3'))
  await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 1000000n))
  const trace: ReturnType<typeof stepTraceJSON>[] = []
  vm.tvm.events!.on('step', (step) => {
    trace.push(stepTraceJSON(step, true))
  })
  const tx = createLegacyTx(
    { to: contract, gasLimit: 100000n, gasPrice: 10n },
    { common: vm.common },
  ).sign(SIGNER_A.privateKey)
  const result = await runTx(vm, { tx })
  const summary = await summaryTraceJSON({ ...result, transaction: tx }, vm)
  assert.deepEqual(
    trace.map((step) => step.opName),
    ['PUSH1', 'PUSH1', 'MSTORE', 'PUSH1', 'PUSH1', 'RETURN'],
  )
  assert.deepEqual(
    trace.map((step) => step.gasCost),
    [3, 3, 3, 3, 3, 0],
  )
  assert.strictEqual(trace[2].memSize, 0)
  assert.strictEqual(trace[3].memSize, 32)
  assert.deepEqual(trace[3].memory, ['0x' + '00'.repeat(31) + '42'])
  assert.deepEqual(summary, {
    stateRoot: bytesToHex(await vm.stateManager.getStateRoot()),
    output: '0x' + '00'.repeat(31) + '42',
    gasUsed: 21015,
    pass: true,
    fork: 'tron',
  })
})
