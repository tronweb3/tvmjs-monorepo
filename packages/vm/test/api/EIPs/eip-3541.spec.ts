import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { SIGNER_A } from '@tvmjs/testdata'
import { createLegacyTx } from '@tvmjs/tx'
import { Account, hexToBytes } from '@tvmjs/util'
import type { Address } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'
import { createVM, runTx } from '../../../src/index.ts'

describe.each([TronMainnet, TronNile, TronShasta])(
  'TRON code prefix validation on $name',
  (chain) => {
    for (const mode of ['deployment', 'CREATE', 'CREATE2'] as const) {
      it.each(['ef', 'ff'])(`${mode} validates a runtime prefix of 0x%s`, async (prefix) => {
        const common = new Common({ chain, eips: [] })
        const vm = await createVM({ common })
        assert.isTrue(common.isActivatedEIP(3541))
        await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 100000000n))
        const initcode = `60${prefix}60005360016000f3`
        const nested = `7f${initcode.padEnd(64, '0')}600052`
        const data =
          mode === 'deployment'
            ? initcode
            : mode === 'CREATE'
              ? `${nested}602060006000f000`
              : `${nested}6000602060006000f500`
        const tx = createLegacyTx(
          { data: hexToBytes(`0x${data}`), gasLimit: 1000000n, gasPrice: 10n },
          { common },
        ).sign(SIGNER_A.privateKey)
        let child: Address | undefined
        let parentStack: bigint[] | undefined
        vm.tvm.events!.on('step', (step) => {
          if (step.depth === 1) child = step.address
          if (step.depth === 0 && step.opcode.name === 'STOP') parentStack = [...step.stack]
        })
        const result = await runTx(vm, { tx })
        const address = mode === 'deployment' ? result.createdAddress : child
        assert.isDefined(address, 'the deployment path actually executed')
        const code = await vm.stateManager.getCode(address!)
        if (prefix === 'ef') {
          assert.strictEqual(code.length, 0)
          if (mode === 'deployment') assert.isDefined(result.execResult.exceptionError)
          else {
            assert.isUndefined(result.execResult.exceptionError)
            assert.deepEqual(parentStack, [0n])
          }
        } else {
          assert.isUndefined(result.execResult.exceptionError)
          assert.deepEqual(code, hexToBytes('0xff'))
          if (mode !== 'deployment') assert.isTrue(parentStack![0] > 0n)
        }
      })
    }
  },
)
