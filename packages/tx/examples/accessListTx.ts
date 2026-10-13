import { Common, TronMainnet } from '@tvmjs/common'
import type { AccessList2930TxData } from '@tvmjs/tx'
import { createAccessList2930Tx } from '@tvmjs/tx'
import { bytesToHex, hexToBytes } from '@tvmjs/util'

const common = new Common({ chain: TronMainnet })

const txData: AccessList2930TxData = {
  data: '0x1a8451e600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  gasLimit: '0x02625a00',
  gasPrice: '0x01',
  nonce: '0x00',
  to: '0xcccccccccccccccccccccccccccccccccccccccc',
  value: '0x0186a0',
  chainId: common.chainId(),
  accessList: [
    {
      address: '0x0000000000000000000000000000000000000101',
      storageKeys: [
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        '0x00000000000000000000000000000000000000000000000000000000000060a7',
      ],
    },
  ],
  type: '0x01',
}

const tx = createAccessList2930Tx(txData, { common })
// Demonstration key only. Access-list entries do not add TRON access charges.
const privateKey = hexToBytes(`0x${'46'.repeat(32)}`)
const signedTx = tx.sign(privateKey)
console.log(bytesToHex(signedTx.hash()))
