import { createAddressFromString } from '@tvmjs/util'
import { createVM } from '@tvmjs/vm'

import type { GenesisState } from '@tvmjs/common'

const main = async () => {
  const accountAddress = '0x000d836201318ec6899a67540690382780743280'
  const expectedBalance = 42n
  const genesisState: GenesisState = {
    [accountAddress]: `0x${expectedBalance.toString(16)}`,
  }

  const vm = await createVM()
  await vm.stateManager.generateCanonicalGenesis!(genesisState)
  const account = await vm.stateManager.getAccount(createAddressFromString(accountAddress))

  if (account === undefined || account.balance !== expectedBalance) {
    throw new Error('Failed to import the expected account balance from genesis state')
  }

  console.log(
    `The balance for account ${accountAddress} in the custom genesis state is ${account.balance}`,
  )
}
void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
