import { NodeCore } from './core/node.ts'
import { attachNode, nodeCore } from './core/nodeAccess.ts'
import { developmentApi } from './development/index.ts'

import type { ClientConfig, GenesisConfig, NodeRuntimeOptions } from './config.ts'
import type { AdminApi } from './development/admin.ts'
import type { DebugApi } from './development/debug.ts'
import type { TreApi } from './development/tre.ts'

function loggedApi<T extends object>(core: NodeCore, api: T, methods: Record<keyof T, string>): T {
  return Object.fromEntries(
    Object.entries(api).map(([key, value]) => [
      key,
      (...args: unknown[]) =>
        core.log.run(methods[key as keyof T], () => Reflect.apply(value, api, args)),
    ]),
  ) as T
}

/** Local development controls. Chain queries and transactions use TronProvider. */
export class TronNode {
  readonly #tre: TreApi
  readonly #admin: AdminApi
  readonly #debug: DebugApi

  private constructor(core: NodeCore) {
    attachNode(this, core)
    const api = developmentApi(core)
    // Facade objects are separate from the provider's internal dispatch objects.
    this.#tre = loggedApi(core, api.tre, {
      mine: 'tre_mine',
      increaseTime: 'tre_increaseTime',
      blockTime: 'tre_blockTime',
      setAccountBalance: 'tre_setAccountBalance',
      setAccountCode: 'tre_setAccountCode',
      setAccountStorageAt: 'tre_setAccountStorageAt',
      unlockedAccounts: 'tre_unlockedAccounts',
    })
    this.#admin = loggedApi(core, api.admin, {
      info: 'admin',
      accounts: 'admin/accounts-json',
      temporaryAccountsGeneration: 'admin/temporary-accounts-generation',
      accountsGeneration: 'admin/accounts-generation',
    })
    this.#debug = loggedApi(core, api.debug, {
      traceTransaction: 'debug_traceTransaction',
      storageRangeAt: 'debug_storageRangeAt',
    })
  }

  static async create(config: ClientConfig = {}): Promise<TronNode> {
    return new TronNode(await NodeCore.create(config))
  }

  /** Initial-chain configuration snapshot; editing it does not change the node. */
  get config(): GenesisConfig {
    return nodeCore(this).config
  }

  /** Execution-settings snapshot; editing it does not change the node. */
  get runtime(): NodeRuntimeOptions {
    return nodeCore(this).runtime
  }

  get tre(): TreApi {
    return this.#tre
  }

  get admin(): AdminApi {
    return this.#admin
  }

  get debug(): DebugApi {
    return this.#debug
  }
}
