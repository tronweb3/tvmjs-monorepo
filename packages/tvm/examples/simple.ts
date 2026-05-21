import { createTVM } from '@tvmjs/tvm'
import { hexToBytes } from '@tvmjs/util'

const main = async () => {
  const tvm = await createTVM()
  const res = await tvm.runCode({ code: hexToBytes('0x6001') }) // PUSH1 01 -- simple bytecode to push 1 onto the stack
  console.log(res.executionGasUsed) // 3n
}

void main()
