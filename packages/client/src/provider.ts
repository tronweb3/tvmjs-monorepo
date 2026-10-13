import { nodeCore } from './core/nodeAccess.ts'
import { defaultRegistry } from './dialect/index.ts'
import { requestInput } from './requestInput.ts'
import { responseSnapshot } from './response.ts'

import type { NodeCore } from './core/node.ts'
import type { HandlerParams } from './dialect/registry.ts'
import type { TronNode } from './node.ts'
import type { ProviderRequest, ProviderResult } from './rpc.ts'

export type { ProviderRequest } from './rpc.ts'

export class MethodNotFoundError extends Error {}

/** a JSON-RPC argument the dev surface refuses, answered as -32602 */
export class InvalidParamsError extends Error {}

const nodes = new WeakMap<TronProvider, TronNode>()

/** The same node binding is used by program dispatch and HTTP processing. */
export function providerCore(provider: TronProvider): NodeCore {
  return nodeCore(nodes.get(provider)!)
}

async function dispatch(
  provider: TronProvider,
  { method, params }: ProviderRequest,
  wire: boolean,
): Promise<unknown> {
  const definition = defaultRegistry.resolve(method)
  const core = providerCore(provider)
  return core.log.run(
    method,
    async () => {
      if (definition === undefined) {
        throw new MethodNotFoundError(`the method ${method} does not exist/is not available`)
      }
      const input = wire ? (params ?? {}) : requestInput(definition, params)
      return core.withWriteLock(async () =>
        responseSnapshot(await definition.handler(core, input as HandlerParams), wire),
      )
    },
    definition?.name,
  )
}

/** Package-private HTTP dispatch: preserve protocol inputs and number/text printers. */
export function requestWire(provider: TronProvider, request: ProviderRequest): Promise<unknown> {
  return dispatch(provider, request, true)
}

/**
 * Query and submit transactions directly, using the same handlers as HTTP.
 * Program calls accept equivalent input forms and return ordinary JS values.
 */
export class TronProvider {
  constructor(node: TronNode) {
    nodeCore(node)
    nodes.set(this, node)
  }

  get node(): TronNode {
    return nodes.get(this)!
  }

  async request<M extends string, D extends string = string>(
    request: ProviderRequest<M, D>,
  ): Promise<ProviderResult<M, D>> {
    return (await dispatch(this, request, false)) as ProviderResult<M, D>
  }
}
