import { SimpleStateManager } from '@tvmjs/statemanager'
import { Account, createAddressFromPrivateKey, randomBytes } from '@tvmjs/util'

const main = async () => {
  const sm = new SimpleStateManager()
  const address = createAddressFromPrivateKey(randomBytes(32))
  const account = new Account(0n, 0xfffffn)
  await sm.putAccount(address, account)
  console.log(await sm.getAccount(address))
}

void main()
