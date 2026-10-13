import { Common, TronMainnet } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import { bytesToHex, createZeroAddress, hexToBytes } from '@tvmjs/util'
import { createVM, runTx } from '@tvmjs/vm'

const main = async () => {
  const common = new Common({ chain: TronMainnet })
  const vm = await createVM({ common })

  // Setup an event listener on the `afterTx` event
  vm.events.on('afterTx', (event, resolve) => {
    console.log('asynchronous listener to afterTx', bytesToHex(event.transaction.hash()))
    // we need to call resolve() to avoid the event listener hanging
    resolve?.()
  })

  vm.events.on('afterTx', (event) => {
    console.log('synchronous listener to afterTx', bytesToHex(event.transaction.hash()))
  })

  const tx = createLegacyTx(
    {
      gasLimit: BigInt(21000),
      gasPrice: BigInt(1000000000),
      value: BigInt(1),
      to: createZeroAddress(),
    },
    { common },
  ).sign(hexToBytes(`0x${'01'.repeat(32)}`))
  const res = await runTx(vm, { tx, skipBalance: true })
  console.log(res.totalGasSpent) // 21000n - gas cost for local simulation transfer
}

void main()
