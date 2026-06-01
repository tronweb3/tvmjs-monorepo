import { createTVM } from '@tvmjs/tvm'
import { createAddressFromString, hexToBytes } from '@tvmjs/util'

const main = async () => {
  const tvm = await createTVM()

  tvm.events.on('beforeMessage', (event) => {
    console.log('synchronous listener to beforeMessage', event)
  })
  tvm.events.on('afterMessage', (event, resolve) => {
    console.log('asynchronous listener to beforeMessage', event)
    // we need to call resolve() to avoid the event listener hanging
    resolve?.()
  })
  const res = await tvm.runCall({
    to: createAddressFromString('0x0000000000000000000000000000000000000000'),
    value: 0n,
    data: hexToBytes('0x6001'), // PUSH1 01 -- simple bytecode to push 1 onto the stack
  })
  console.log(res.execResult.executionGasUsed) // 0n
}

void main()
