import { isVisible } from '../address.ts'
import { withVisibleAddresses } from '../visible.ts'
import { blockNumberOf, hexValueField } from './chain.ts'
import { formatTransaction } from './print.ts'
import { JavaExceptionError } from './types.ts'

import type { HandlerParams, Registry } from '../../registry.ts'

/**
 * Transaction queries read from the node's tx store (populated by
 * broadcasttransaction). Unknown txids answer {} — polling
 * clients treat that as not-yet-indexed.
 */

/**
 * Hex request fields are parsed leniently: a `0x` prefix is
 * stripped and the case is irrelevant. The stores key on the lower-case form.
 */
function txKey(params: HandlerParams): string | undefined {
  const hex = hexValueField(params, 'value')
  return hex.length === 64 ? hex : undefined
}

export function registerTxHandlers(registry: Registry): void {
  registry.register('wallet/getpendingsize', (node) => ({ pendingSize: node.pendingSize() }), {
    verbatim: true,
  })
  registry.register('wallet/gettransactionlistfrompending', (node) => {
    const txId = node.pendingIds()
    return txId.length === 0 ? {} : { txId }
  })
  registry.register('wallet/gettransactionfrompending', (node, params) => {
    const key = txKey(params)
    if (key === undefined) throw new JavaExceptionError('null')
    return formatTransaction(node.pendingTransaction(key) ?? {}, isVisible(params))
  })

  registry.register(
    'wallet/gettransactionbyid',
    (node, params) => {
      const key = txKey(params)
      const record = key === undefined ? undefined : node.txs.get(key)
      return formatTransaction(record?.transaction ?? {}, isVisible(params))
    },
    { solidity: true },
  )

  registry.register(
    'wallet/gettransactioninfobyid',
    (node, params) => {
      const key = txKey(params)
      const record = key === undefined ? undefined : node.txs.get(key)
      return withVisibleAddresses(record?.info ?? {}, isVisible(params))
    },
    { solidity: true },
  )

  /**
   * The receipt view of a transaction: only the receipt sub-message prints,
   * under a capitalised key.
   */
  registry.register('wallet/gettransactionreceiptbyid', (node, params) => {
    const key = txKey(params)
    const info = key === undefined ? undefined : node.txs.get(key)?.info
    const receipt = (info as Record<string, unknown> | undefined)?.receipt
    return receipt === undefined ? {} : { Receipt: receipt }
  })

  registry.register(
    'wallet/gettransactioninfobyblocknum',
    (node, params) => {
      const num = blockNumberOf(params)
      if (num <= 0n) return {}
      const record = node.blocks.getByNumber(num)
      if (record === undefined) return []
      return withVisibleAddresses(
        record.txs.map((tx) => tx.info),
        isVisible(params),
      )
    },
    { solidity: true },
  )

  registry.register(
    'wallet/gettransactioncountbyblocknum',
    (node, params) => {
      const record = node.blocks.getByNumber(blockNumberOf(params))
      return { count: record?.txs.length ?? 0 }
    },
    // handwritten reply — count stays even when zero
    { solidity: true, verbatim: true },
  )
}
