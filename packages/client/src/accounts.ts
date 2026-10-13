/** Development credentials for one group of accounts. */
export interface AccountGroup {
  /** Present for mnemonic-derived groups; absent for directly configured keys. */
  mnemonic?: string
  hdPath?: string
  privateKeys: string[]
  more: AccountGroup[]
}

/** Development accounts returned by the node and /admin/accounts-json. */
export interface NodeAccounts extends AccountGroup {
  mnemonic: string
  hdPath: string
}
