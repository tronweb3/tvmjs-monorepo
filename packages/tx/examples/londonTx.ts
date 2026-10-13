import { Common, TronMainnet } from '@tvmjs/common'
import type { FeeMarketEIP1559TxData } from '@tvmjs/tx'
import { createFeeMarket1559Tx } from '@tvmjs/tx'
import { bytesToHex, hexToBytes } from '@tvmjs/util'

const common = new Common({ chain: TronMainnet })

const txData: FeeMarketEIP1559TxData = {
  data: '0x1a8451e600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  gasLimit: '0x02625a00',
  maxPriorityFeePerGas: '0x01',
  maxFeePerGas: '0xff',
  nonce: '0x00',
  to: '0xcccccccccccccccccccccccccccccccccccccccc',
  value: '0x0186a0',
  chainId: common.chainId(),
  accessList: [],
  type: '0x02',
}

const tx = createFeeMarket1559Tx(txData, { common })
// Demonstration key only. This is a local execution envelope, not a node broadcast.
const privateKey = hexToBytes(`0x${'46'.repeat(32)}`)
const signedTx = tx.sign(privateKey)
console.log(bytesToHex(signedTx.hash()))
