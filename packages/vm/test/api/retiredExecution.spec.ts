import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet, TronNile, TronShasta } from '@tvmjs/common'
import { SIGNER_A } from '@tvmjs/testdata'
import { getActivePrecompiles } from '@tvmjs/tvm'
import { createLegacyTx } from '@tvmjs/tx'
import { Account, createAddressFromString, hexToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import { buildBlock, createVM, runBlock } from '../../src/index.ts'

const systemContracts = [
  '0x0000F90827F1C53A10CB7A02335B175320002935',
  '0x00000961EF480EB55E80D19AD83579A64C007002',
  '0x0000BBDDC7CE488642FB579F8B00F3A590007251',
].map(createAddressFromString)

describe.each([TronMainnet, TronNile, TronShasta])(
  'retired execution boundaries on $name',
  (chain) => {
    it.each([
      2935, 3540, 3670, 4399, 4895, 6110, 7002, 7251, 7480, 7620, 7623, 7685, 7692, 6800, 7864,
      7928,
    ])('cannot activate EIP-%s', (eip) => {
      const common = new Common({ chain })
      assert.isFalse(common.isActivatedEIP(eip))
      assert.throws(() => common.setEIPs([eip]), /not supported/)
      assert.isFalse(common.isActivatedEIP(eip))
    })

    it('rejects withdrawals and requests at the block boundary', () => {
      const common = new Common({ chain })
      assert.throws(() => createBlock({ withdrawals: [] }, { common }), /4895/)
      assert.throws(
        () => createBlock({ header: { withdrawalsRoot: new Uint8Array(32) } }, { common }),
        /4895/,
      )
      assert.throws(
        () => createBlock({ header: { requestsHash: new Uint8Array(32) } }, { common }),
        /7685/,
      )
    })

    it('neither executes Ethereum system contracts nor awards block rewards', async () => {
      const common = new Common({ chain })
      const vm = await createVM({ common })
      const coinbase = createAddressFromString('0x' + '42'.repeat(20))
      for (const address of systemContracts) {
        await vm.stateManager.putAccount(address, new Account(0n, 11n))
        await vm.stateManager.putCode(address, hexToBytes('0x600160005500'))
      }
      const root = await vm.stateManager.getStateRoot()
      const parentBlock = createBlock({ header: { gasLimit: 100000n } }, { common })
      const builder = await buildBlock(vm, {
        parentBlock,
        headerData: { coinbase, timestamp: 1n },
        blockOpts: { putBlockIntoBlockchain: false },
      })
      const { block } = await builder.build()
      const result = await runBlock(vm, { block, skipBlockValidation: true })
      assert.deepEqual(result.stateRoot, root)
      assert.strictEqual(result.gasUsed, 0n)
      assert.isUndefined(result.requests)
      assert.isUndefined(result.requestsHash)
      assert.isUndefined(block.withdrawals)
      assert.isUndefined(await vm.stateManager.getAccount(coinbase))
      for (const address of systemContracts) {
        assert.deepEqual(
          await vm.stateManager.getStorage(address, new Uint8Array(32)),
          new Uint8Array(),
        )
        assert.strictEqual((await vm.stateManager.getAccount(address))!.balance, 11n)
      }
    })

    it('does not interpret a deposit-like log as a consensus request', async () => {
      const common = new Common({ chain })
      const vm = await createVM({ common })
      const deposit = createAddressFromString('0x00000000219ab540356cbb839cbe05303d7705fa')
      // DepositEvent topic with deliberately empty data. It is an ordinary log on TRON.
      await vm.stateManager.putCode(
        deposit,
        hexToBytes(
          '0x7f649bbc62d0e31342afea4e5cd82d4049e7e1ee912fc0889aa790803be39038c560006000a100',
        ),
      )
      await vm.stateManager.putAccount(SIGNER_A.address, new Account(0n, 1000000n))
      const tx = createLegacyTx({ to: deposit, gasLimit: 100000n, gasPrice: 10n }, { common }).sign(
        SIGNER_A.privateKey,
      )
      const block = createBlock({ header: { gasLimit: 100000n }, transactions: [tx] }, { common })
      const result = await runBlock(vm, { block, generate: true, skipBlockValidation: true })
      assert.isUndefined(result.results[0].execResult.exceptionError)
      assert.strictEqual(result.receipts[0].logs.length, 1)
      assert.isUndefined(result.requests)
    })

    it('keeps EOF execution and alternate precompile wrappers inactive', async () => {
      const vm = await createVM({ common: new Common({ chain }) })
      const result = await vm.tvm.runCode({ code: hexToBytes('0xef0001'), gasLimit: 100n })
      assert.strictEqual(result.exceptionError?.error, 'invalid opcode')
      const precompiles = getActivePrecompiles(vm.common)
      for (const address of [0x100, 0x20003, 0x20009]) {
        assert.isFalse(precompiles.has(address.toString(16).padStart(40, '0')))
      }
      for (const address of [0x09, 0x0a]) {
        assert.isTrue(precompiles.has(address.toString(16).padStart(40, '0')))
      }
    })
  },
)
