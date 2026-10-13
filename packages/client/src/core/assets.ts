import { MIN_TOKEN_ID } from '@tvmjs/util'

/** TRC-10 asset metadata (chain state, not a VM concern) */
export interface AssetMeta {
  id: number
  /** owner address as lowercase unprefixed 40-char hex */
  ownerKey: string
  /** plain utf8 (wire encoding is the dialect's job) */
  name: string
  abbr: string
  totalSupply: bigint
  trxNum: number
  num: number
  precision: number
  startTime: bigint
  endTime: bigint
  /** carried and stored verbatim; the proto itself marks it useless */
  order: bigint
  voteScore: number
  description: string
  url: string
  freeAssetNetLimit: number
  /** locked tranches declared at issuance, in wire order */
  frozenSupply?: { frozen_amount: bigint; frozen_days: number }[]
  publicFreeAssetNetLimit: number
  /** shared free-bandwidth pool: spent bytes and when they last moved */
  publicFreeAssetNetUsage: number
  publicLatestFreeNetTime: number
}

export type AssetInput = Omit<AssetMeta, 'id'>

/**
 * TRC-10 registry: ids allocate upward from MIN_TOKEN_ID + 1, one asset per
 * issuing account (TRON rule). Balances live on accounts (`account.asset`);
 * this holds only the issuance metadata.
 */
export class AssetRegistry {
  private byIdMap: Map<number, AssetMeta> = new Map()
  private byOwnerMap: Map<string, number> = new Map()
  private nextId: number = Number(MIN_TOKEN_ID) + 1

  copy(): AssetRegistry {
    const copy = new AssetRegistry()
    copy.byIdMap = structuredClone(this.byIdMap)
    copy.byOwnerMap = new Map(this.byOwnerMap)
    copy.nextId = this.nextId
    return copy
  }

  create(input: AssetInput): AssetMeta | 'owner-already-issued' {
    if (this.byOwnerMap.has(input.ownerKey)) {
      return 'owner-already-issued'
    }
    const meta: AssetMeta = { ...input, id: this.nextId++ }
    this.byIdMap.set(meta.id, meta)
    this.byOwnerMap.set(meta.ownerKey, meta.id)
    return meta
  }

  /** take back an issuance, id included — the next one allocates it again */
  drop(id: number, ownerKey: string): void {
    this.byIdMap.delete(id)
    this.byOwnerMap.delete(ownerKey)
    if (this.nextId === id + 1) this.nextId = id
  }

  byId(id: number): AssetMeta | undefined {
    return this.byIdMap.get(id)
  }

  byOwner(ownerKey: string): AssetMeta | undefined {
    const id = this.byOwnerMap.get(ownerKey)
    return id === undefined ? undefined : this.byIdMap.get(id)
  }

  byName(name: string): AssetMeta[] {
    return this.list().filter((meta) => meta.name === name)
  }

  list(): AssetMeta[] {
    return [...this.byIdMap.values()].sort((a, b) => a.id - b.id)
  }

  /** Bytewise asset-store order: legacy names or V2 ids. */
  listInStoreOrder(legacy = false): AssetMeta[] {
    return [...this.byIdMap.values()].sort((a, b) => {
      const left = legacy ? a.name : String(a.id)
      const right = legacy ? b.name : String(b.id)
      return left === right ? 0 : left < right ? -1 : 1
    })
  }
}
