import { isDebugEnabled } from '@tvmjs/util'
import debugDefault from 'debug'

import type { Debugger } from 'debug'

export class Cache {
  _debug: Debugger

  _checkpoints = 0

  // Pending writes are independent of the cached values saved for rollback.
  protected _dirtyKeys = new Set<string>()
  private _dirtyCheckpoints: Map<string, boolean>[] = []

  _stats = {
    size: 0,
    reads: 0,
    hits: 0,
    writes: 0,
    deletions: 0,
  }

  /**
   * StateManager cache is run in DEBUG mode (default: false)
   * Taken from DEBUG environment variable
   *
   * Safeguards on debug() calls are added for
   * performance reasons to avoid string literal evaluation
   * @hidden
   */
  protected readonly DEBUG: boolean = false

  constructor() {
    // Skip DEBUG calls unless 'tvmjs' included in environmental DEBUG variables
    this.DEBUG = isDebugEnabled('tvmjs')

    this._debug = debugDefault('statemanager:cache')
  }

  protected _setDirty(key: string, dirty: boolean): void {
    const wasDirty = this._dirtyKeys.has(key)
    if (wasDirty === dirty) return

    const checkpoint = this._dirtyCheckpoints[this._dirtyCheckpoints.length - 1]
    if (checkpoint !== undefined && !checkpoint.has(key)) {
      checkpoint.set(key, wasDirty)
    }
    if (dirty) {
      this._dirtyKeys.add(key)
    } else {
      this._dirtyKeys.delete(key)
    }
  }

  protected _clearDirty(): void {
    // A flush can write pending data from an outer checkpoint. If the inner
    // trie checkpoint is reverted, that data must become pending again.
    for (const key of this._dirtyKeys) {
      this._setDirty(key, false)
    }
  }

  checkpoint(): void {
    this._checkpoints += 1
    this._dirtyCheckpoints.push(new Map())
  }

  commit(): void {
    this._checkpoints -= 1
    const checkpoint = this._dirtyCheckpoints.pop()!
    const parent = this._dirtyCheckpoints[this._dirtyCheckpoints.length - 1]
    if (parent !== undefined) {
      for (const [key, wasDirty] of checkpoint) {
        if (!parent.has(key)) parent.set(key, wasDirty)
      }
    }
  }

  revert(): void {
    this._checkpoints -= 1
    const checkpoint = this._dirtyCheckpoints.pop()!
    for (const [key, wasDirty] of checkpoint) {
      if (wasDirty) {
        this._dirtyKeys.add(key)
      } else {
        this._dirtyKeys.delete(key)
      }
    }
  }
}
