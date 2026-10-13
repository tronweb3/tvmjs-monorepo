import { Common, TronMainnet } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import { Account, createAddressFromPrivateKey, createZeroAddress, hexToBytes } from '@tvmjs/util'
import { createVM, runTx } from '@tvmjs/vm'

const main = async () => {
  const common = new Common({ chain: TronMainnet })
  const vm = await createVM({ common })
  // Public example key for a local simulation account.
  const privateKey = hexToBytes(`0x${'01'.repeat(32)}`)
  await vm.stateManager.putAccount(
    createAddressFromPrivateKey(privateKey),
    new Account(0n, 1000000n),
  )
  const tx = createLegacyTx(
    {
      gasLimit: 21000n,
      gasPrice: 10n,
      value: 1n,
      to: createZeroAddress(),
    },
    { common },
  ).sign(privateKey)
  const result = await runTx(vm, { tx })
  if (result.execResult.exceptionError) throw result.execResult.exceptionError
  console.log(result.totalGasSpent) // 21000n for the local transaction envelope
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
