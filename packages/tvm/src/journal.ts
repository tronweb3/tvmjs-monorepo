import type { Common, StateManagerInterface } from '@tvmjs/common'
import {
  EthereumJSErrorWithoutCode,
  RIPEMD160_ADDRESS_STRING,
  bytesToHex,
  bytesToUnprefixedHex,
  stripHexPrefix,
  unprefixedHexToBytes,
} from '@tvmjs/util'
import type { Account, Address, PrefixedHexString } from '@tvmjs/util'

type AddressString = string
type SlotString = string
type WarmSlots = Set<SlotString>

type JournalType = Map<AddressString, WarmSlots>

/**
 * Journal Diff Item:
 * Index 0: remove warm address
 * Index 1: remove warm slots for this warm address
 * Index 2: remove touched
 * Index 3: remove storage slots written in this transaction
 */

type JournalDiffItem = [
  Set<AddressString>,
  Map<AddressString, Set<SlotString>>,
  Set<AddressString>,
  Set<string>,
]

type JournalHeight = number

export class Journal {
  private stateManager: StateManagerInterface

  private journal!: JournalType
  private alwaysWarmJournal!: Map<AddressString, Set<SlotString>>
  private touched!: Set<AddressString>
  private journalDiff!: [JournalHeight, JournalDiffItem][]

  private journalHeight: JournalHeight
  private storageWrites = new Set<string>()

  public accessList?: Map<AddressString, Set<SlotString>>
  public preimages?: Map<PrefixedHexString, Uint8Array>

  constructor(stateManager: StateManagerInterface, _common: Common) {
    // TODO maybe call into this.clearJournal
    this.cleanJournal()
    this.journalHeight = 0

    this.stateManager = stateManager
  }

  /**
   * Clears the internal `accessList` map, and mark this journal to start reporting
   * which addresses and storages have been accessed
   */
  startReportingAccessList() {
    this.accessList = new Map()
  }

  /**
   * Clears the internal `preimages` map, and marks this journal to start reporting
   * the images (hashed addresses) of the accounts that have been accessed
   */
  startReportingPreimages() {
    this.preimages = new Map()
  }

  async putAccount(address: Address, account: Account | undefined) {
    this.touchAddress(address)
    return this.stateManager.putAccount(address, account)
  }

  async deleteAccount(address: Address) {
    this.touchAddress(address)
    await this.stateManager.deleteAccount(address)
  }

  private touchAddress(address: Address): void {
    const str = address.toString().slice(2)
    this.touchAccount(str)
  }

  private touchAccount(address: string) {
    // If preimages are being reported, add the address to the preimages map
    if (this.preimages !== undefined) {
      const bytesAddress = unprefixedHexToBytes(address)
      if (this.stateManager.getAppliedKey === undefined) {
        throw EthereumJSErrorWithoutCode(
          'touchAccount: stateManager.getAppliedKey can not be undefined if preimage storing is enabled',
        )
      }
      const hashedKey = this.stateManager.getAppliedKey(bytesAddress)
      this.preimages.set(bytesToHex(hashedKey), bytesAddress)
    }

    if (!this.touched.has(address)) {
      this.touched.add(address)
      const diffArr = this.journalDiff[this.journalDiff.length - 1][1]
      diffArr[2].add(address)
    }
  }
  async commit() {
    await this.stateManager.commit()
    this.journalHeight--
    this.journalDiff.push([this.journalHeight, [new Set(), new Map(), new Set(), new Set()]])
  }

  async checkpoint() {
    this.journalHeight++
    this.journalDiff.push([this.journalHeight, [new Set(), new Map(), new Set(), new Set()]])
    try {
      await this.stateManager.checkpoint()
    } catch (error) {
      // Keep Journal bookkeeping atomic with the StateManager call. Without this cleanup, a
      // rejected checkpoint leaves the Journal one level too deep and corrupts subsequent
      // commit/revert pairing on the same TVM instance.
      this.journalDiff.pop()
      this.journalHeight--
      throw error
    }
  }

  async revert() {
    // Do not mutate Journal bookkeeping until the StateManager has successfully reverted. This
    // keeps both layers aligned and allows callers to retry a rejected revert.
    await this.stateManager.revert()

    // Loop backwards over the journal diff and stop if we are at a lower height than current journal height
    // During this process, delete all items.
    // TODO check this logic, if there is this array: height [4,3,4] and we revert height 4, then the final
    // diff arr will be reverted, but it will stop at height 3, so [4,3] are both not reverted..?
    let finalI: number
    for (let i = this.journalDiff.length - 1; i >= 0; i--) {
      finalI = i
      const [height, diff] = this.journalDiff[i]
      if (height < this.journalHeight) {
        break
      }

      const addressSet = diff[0]
      const slotsMap = diff[1]
      const touchedSet = diff[2]
      for (const key of diff[3]) this.storageWrites.delete(key)

      for (const address of addressSet) {
        // Sanity check, journal should have the item
        if (this.journal.has(address)) {
          this.journal.delete(address)
        }
      }

      for (const [address, delSlots] of slotsMap) {
        // Sanity check, the address SHOULD be in the journal
        if (this.journal.has(address)) {
          const slots = this.journal.get(address)!
          for (const delSlot of delSlots) {
            slots.delete(delSlot)
          }
        }
      }

      for (const address of touchedSet) {
        // Delete the address from the journal
        if (address !== RIPEMD160_ADDRESS_STRING) {
          // If RIPEMD160 is touched, keep it touched.
          // Default behavior for others.
          this.touched.delete(address)
        }
      }
    }

    // the final diffs are reverted and we can dispose those
    this.journalDiff = this.journalDiff.slice(0, finalI! + 1)

    this.journalHeight--
  }

  public cleanJournal() {
    this.journalHeight = 0
    this.journal = new Map()
    this.alwaysWarmJournal = new Map()
    this.touched = new Set()
    this.journalDiff = [[0, [new Set(), new Map(), new Set(), new Set()]]]
    this.storageWrites = new Set()
  }

  /** Reset only the execution-local storage presence information at a public execution boundary. */
  clearStorageWrites(): void {
    this.storageWrites.clear()
    for (const [, diff] of this.journalDiff) diff[3].clear()
  }

  /** java-tron retains a written zero in Storage.rowCache until the transaction ends. */
  hasStorageWrite(address: Address, slot: Uint8Array): boolean {
    return this.storageWrites.has(`${address.toString()}:${bytesToHex(slot)}`)
  }

  recordStorageWrite(address: Address, slot: Uint8Array): void {
    const key = `${address.toString()}:${bytesToHex(slot)}`
    if (this.storageWrites.has(key)) return
    this.storageWrites.add(key)
    this.journalDiff[this.journalDiff.length - 1][1][3].add(key)
  }

  /**
   * Clears transaction bookkeeping. TRON keeps existing empty accounts, whose
   * existence affects the new-account Energy charged by CALL and SELFDESTRUCT.
   */
  async cleanup(): Promise<void> {
    this.cleanJournal()
    delete this.accessList
    delete this.preimages
  }

  /** Records optional diagnostic access data without warming or charging. */
  addAccessedAddress(address: Uint8Array): void {
    if (this.accessList === undefined) return
    const key = bytesToUnprefixedHex(address)
    if (!this.accessList.has(key)) this.accessList.set(key, new Set())
  }

  /** Records a storage access, including accesses in subsequently reverted calls. */
  addAccessedStorage(address: Uint8Array, slot: Uint8Array): void {
    if (this.accessList === undefined) return
    this.addAccessedAddress(address)
    this.accessList.get(bytesToUnprefixedHex(address))!.add(bytesToUnprefixedHex(slot))
  }

  addAlwaysWarmAddress(addressStr: string, addToAccessList: boolean = false) {
    const address = stripHexPrefix(addressStr)
    if (!this.alwaysWarmJournal.has(address)) {
      this.alwaysWarmJournal.set(address, new Set())
    }
    if (addToAccessList && this.accessList !== undefined) {
      if (!this.accessList.has(address)) {
        this.accessList.set(address, new Set())
      }
    }
  }

  addAlwaysWarmSlot(addressStr: string, slotStr: string, addToAccessList: boolean = false) {
    const address = stripHexPrefix(addressStr)
    this.addAlwaysWarmAddress(address, addToAccessList)
    const slotsSet = this.alwaysWarmJournal.get(address)!
    const slot = stripHexPrefix(slotStr)
    slotsSet.add(slot)
    if (addToAccessList && this.accessList !== undefined) {
      this.accessList.get(address)!.add(slot)
    }
  }

  /**
   * Returns true if the address is warm in the current context
   * @param address - The address (as a Uint8Array) to check
   */
  isWarmedAddress(address: Uint8Array): boolean {
    // Using deprecated bytesToUnprefixedHex for performance: this is a hot path used in Map/Set lookups.
    const addressHex = bytesToUnprefixedHex(address)
    const warm = this.journal.has(addressHex) || this.alwaysWarmJournal.has(addressHex)
    return warm
  }

  /**
   * Add a warm address in the current context
   * @param addressArr - The address (as a Uint8Array) to check
   */
  addWarmedAddress(addressArr: Uint8Array): void {
    // Using deprecated bytesToUnprefixedHex for performance: this is a hot path used in Map/Set operations.
    const address = bytesToUnprefixedHex(addressArr)
    if (!this.journal.has(address)) {
      this.journal.set(address, new Set())
      const diffArr = this.journalDiff[this.journalDiff.length - 1][1]
      diffArr[0].add(address)
    }
    if (this.accessList !== undefined) {
      if (!this.accessList.has(address)) {
        this.accessList.set(address, new Set())
      }
    }
  }

  /**
   * Returns true if the slot of the address is warm
   * @param address - The address (as a Uint8Array) to check
   * @param slot - The slot (as a Uint8Array) to check
   */
  isWarmedStorage(address: Uint8Array, slot: Uint8Array): boolean {
    // Using deprecated bytesToUnprefixedHex for performance: this is a hot path used in Map/Set lookups.
    const addressHex = bytesToUnprefixedHex(address)
    const slots = this.journal.get(addressHex)
    if (slots === undefined) {
      if (this.alwaysWarmJournal.has(addressHex)) {
        return this.alwaysWarmJournal.get(addressHex)!.has(bytesToUnprefixedHex(slot))
      }
      return false
    }
    if (slots.has(bytesToUnprefixedHex(slot))) {
      return true
    } else if (this.alwaysWarmJournal.has(addressHex)) {
      return this.alwaysWarmJournal.get(addressHex)!.has(bytesToUnprefixedHex(slot))
    }
    return false
  }

  /**
   * Mark the storage slot in the address as warm in the current context
   * @param address - The address (as a Uint8Array) to check
   * @param slot - The slot (as a Uint8Array) to check
   */
  addWarmedStorage(address: Uint8Array, slot: Uint8Array): void {
    // Using deprecated bytesToUnprefixedHex for performance: this is a hot path used in Map/Set operations.
    const addressHex = bytesToUnprefixedHex(address)
    let slots = this.journal.get(addressHex)
    if (slots === undefined) {
      this.addWarmedAddress(address)
      slots = this.journal.get(addressHex)
    }
    const slotStr = bytesToUnprefixedHex(slot)
    if (!slots!.has(slotStr)) {
      slots!.add(slotStr)
      const diff = this.journalDiff[this.journalDiff.length - 1][1]
      const addressSlotMap = diff[1]
      if (!addressSlotMap.has(addressHex)) {
        addressSlotMap.set(addressHex, new Set())
      }
      const slotsSet = addressSlotMap.get(addressHex)!
      slotsSet.add(slotStr)
    }
    if (this.accessList !== undefined) {
      // Note: in `addWarmedAddress` the address is added to warm addresses
      const addrSet = this.accessList.get(addressHex)!
      addrSet.add(slotStr)
    }
  }
}
