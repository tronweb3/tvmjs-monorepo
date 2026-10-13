import { NodeCore } from '../src/core/node.ts'
import { TronNode } from '../src/node.ts'

import type { ClientConfig } from '../src/config.ts'
import type { Clock } from '../src/core/clock.ts'

/** Test-only construction with a controlled clock; production uses TronNode.create. */
export async function createNode(config: ClientConfig, clock: Clock): Promise<TronNode> {
  return Reflect.construct(TronNode, [await NodeCore.create(config, clock)]) as TronNode
}
