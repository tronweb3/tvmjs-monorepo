import { genWithdrawalsTrieRoot } from '@tvmjs/block'
import { bytesToHex, createWithdrawal } from '@tvmjs/util'

// A retained data helper; withdrawals cannot be included in TRON execution blocks.
const withdrawal = createWithdrawal({
  index: 0n,
  validatorIndex: 0n,
  address: `0x${'20'.repeat(20)}`,
  amount: 1000n,
})
console.log(bytesToHex(await genWithdrawalsTrieRoot([withdrawal])))
// 0x897ca49edcb278aecab2688bcc2b7b7ee43524cc489672534fee332a172f1718
