import type { TronNode } from '../node.ts'
import type { NodeCore } from './node.ts'

// Package-private ownership: the public node has no property exposing its core.
const cores = new WeakMap<TronNode, NodeCore>()

export function attachNode(node: TronNode, core: NodeCore): void {
  cores.set(node, core)
}

export function nodeCore(node: TronNode): NodeCore {
  const core = cores.get(node)
  if (core === undefined) throw new TypeError('Expected a node created by TronNode.create')
  return core
}
