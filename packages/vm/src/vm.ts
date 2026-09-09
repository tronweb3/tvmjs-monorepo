import { createTVM } from '@tvmjs/tvm'
import { EventEmitter } from 'eventemitter3'

import { createVM } from './constructors.ts'
import { paramsVM } from './params.ts'

import type { Common, StateManagerInterface } from '@tvmjs/common'
import type { TVMInterface, TVMMockBlockchainInterface } from '@tvmjs/tvm'
import { isDebugEnabled } from '@tvmjs/util'
import type { BigIntLike } from '@tvmjs/util'
import type { VMEvent, VMOpts } from './types.ts'

type EventRegistration = {
  fn: (...args: any[]) => void
  context: any
  once: boolean
}

function getEventRegistrations(emitter: EventEmitter<any>, event: string): EventRegistration[] {
  // EventEmitter3's public listeners() API discards per-registration `once` and `context`
  // metadata. Snapshot the v5 registration records so async serial dispatch can match emit().
  const eventKey = EventEmitter.prefixed ? `${EventEmitter.prefixed}${event}` : event
  const registered = (
    emitter as EventEmitter<any> & {
      _events: Record<string, EventRegistration | EventRegistration[] | undefined>
    }
  )._events[eventKey]
  if (registered === undefined) {
    return []
  }
  return Array.isArray(registered) ? registered.slice() : [registered]
}

/**
 * The VM is a state transition machine that executes TVM bytecode and updates the state.
 * It can be used to execute transactions, blocks, individual transactions, or snippets of TVM bytecode.
 *
 * A VM can be created with the constructor method:
 *
 * - {@link createVM}
 */
export class VM {
  /**
   * The StateManager used by the VM
   */
  readonly stateManager: StateManagerInterface

  /**
   * The blockchain the VM operates on
   */
  readonly blockchain: TVMMockBlockchainInterface

  readonly common: Common

  readonly events: EventEmitter<VMEvent>
  /**
   * The TVM used for bytecode execution
   */
  readonly tvm: TVMInterface

  protected readonly _opts: VMOpts
  protected _isInitialized: boolean = false

  protected readonly _setHardfork: boolean | BigIntLike

  /**
   * Cached emit() function, not for public usage
   * set to public due to implementation internals
   * @hidden
   */
  public readonly _emit: (topic: string, data: any) => Promise<void>

  /**
   * VM is run in DEBUG mode (default: false)
   * Taken from DEBUG environment variable
   *
   * Safeguards on debug() calls are added for
   * performance reasons to avoid string literal evaluation
   * @hidden
   */
  readonly DEBUG: boolean = false

  /**
   * Instantiates a new {@link VM} Object.
   *
   * @deprecated The direct usage of this constructor is discouraged since
   * non-finalized async initialization might lead to side effects. Please
   * use the async {@link createVM} constructor instead (same API).
   * @param opts
   */
  constructor(opts: VMOpts = {}) {
    this.common = opts.common!
    this.common.updateParams(opts.params ?? paramsVM)
    this.stateManager = opts.stateManager!
    this.blockchain = opts.blockchain!
    this.tvm = opts.tvm!

    this.events = new EventEmitter<VMEvent>()

    this._emit = async (topic: string, data: any): Promise<void> => {
      const event = topic as keyof VMEvent
      const registrations = getEventRegistrations(this.events, topic)
      for (const { fn, context, once } of registrations) {
        // `_emit` invokes listeners directly so callback-style listeners can be awaited in series.
        // Mirror EventEmitter.emit() by removing one-time registrations immediately before their
        // callback is invoked, including when it throws.
        if (once) {
          this.events.removeListener(event, fn, undefined, true)
        }
        if (fn.length === 2) {
          await new Promise<void>((resolve) => {
            fn.call(context, data, resolve)
          })
        } else {
          fn.call(context, data)
        }
      }
    }
    this._opts = opts

    this._setHardfork = opts.setHardfork ?? false

    // Skip DEBUG calls unless 'tvmjs' included in environmental DEBUG variables
    this.DEBUG = isDebugEnabled('tvmjs')
  }

  /**
   * Returns a copy of the {@link VM} instance.
   *
   * Note that the returned copy will share the same db as the original for the blockchain and the statemanager.
   *
   * Associated caches will be deleted and caches will be re-initialized for a more short-term focused
   * usage, being less memory intense (the statemanager caches will switch to using an ORDERED_MAP cache
   * data structure more suitable for short-term usage, the trie node LRU cache will not be activated at all).
   * To fine-tune this behavior (if the shallow-copy-returned object has a longer life span e.g.) you can set
   * the `downlevelCaches` option to `false`.
   *
   * @param downlevelCaches Downlevel (so: adopted for short-term usage) associated state caches (default: true)
   */
  async shallowCopy(downlevelCaches = true): Promise<VM> {
    const common = this.common.copy()
    common.setHardfork(this.common.hardfork())
    const blockchain = this.blockchain.shallowCopy()
    const stateManager = this.stateManager.shallowCopy(downlevelCaches)
    const tvmOpts = {
      ...(this.tvm as any)._optsCached,
      common: this._opts.tvmOpts?.common?.copy() ?? common,
      blockchain: this._opts.tvmOpts?.blockchain?.shallowCopy() ?? blockchain,
      stateManager: this._opts.tvmOpts?.stateManager?.shallowCopy(downlevelCaches) ?? stateManager,
    }
    const tvmCopy = await createTVM(tvmOpts) // TODO fixme (should copy the TVMInterface, not default TVM)
    return createVM({
      stateManager,
      blockchain: this.blockchain,
      common,
      tvm: tvmCopy,
      setHardfork: this._setHardfork,
      profilerOpts: this._opts.profilerOpts,
    })
  }

  /**
   * Return a compact error string representation of the object
   */
  errorStr() {
    let hf = ''
    try {
      hf = this.common.hardfork()
    } catch {
      hf = 'error'
    }
    const errorStr = `vm hf=${hf}`
    return errorStr
  }
}
