import { Account } from '@tvmjs/util'

export function createAccountWithDefaults(nonce = BigInt(0), balance = BigInt(0xfff384)) {
  return new Account(nonce, balance)
}
