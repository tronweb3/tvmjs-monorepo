import { createAdminApi } from './admin.ts'
import { createDebugApi } from './debug.ts'
import { createTreApi } from './tre.ts'

import type { NodeCore } from '../core/node.ts'
import type { AdminApi } from './admin.ts'
import type { DebugApi } from './debug.ts'
import type { TreApi } from './tre.ts'

interface DevelopmentApi {
  tre: TreApi
  admin: AdminApi
  debug: DebugApi
}

// Internal dispatch objects never escape through the public node.
const apis = new WeakMap<NodeCore, DevelopmentApi>()

export function developmentApi(node: NodeCore): DevelopmentApi {
  let api = apis.get(node)
  if (api === undefined) {
    api = { tre: createTreApi(node), admin: createAdminApi(node), debug: createDebugApi(node) }
    apis.set(node, api)
  }
  return api
}
