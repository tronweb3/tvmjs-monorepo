/**
 * Replicate proto3 JSON printing on the wire: object fields at their default
 * value (0, '', false, empty array/object) are omitted — responses serialize
 * from protobuf messages, where such fields are simply absent.
 * Array elements are kept verbatim (repeated fields print every element, so
 * `ret: [{}]` and `constant_result: [""]` survive).
 */

/**
 * A protobuf `double`. JSON's number formatting drops the point on a whole
 * value, while a protobuf printer keeps it, so the text is carried explicitly.
 */
export class Float {
  readonly text: string
  constructor(value: number) {
    this.text = Number.isInteger(value) ? `${value}.0` : String(value)
  }
}

/**
 * Fields that are messages rather than scalars. A message the request set is
 * printed even when it holds nothing, which a value-based rule cannot tell
 * apart from one that was never set.
 */
const SET_MESSAGE_FIELDS: ReadonlySet<string> = new Set(['abi', 'account_resource'])

const VERBATIM_FIELDS: ReadonlySet<string> = new Set([
  // map fields: an entry states both halves, however small the value
  'assetV2',
  'asset',
  'assetNetUsed',
  'assetNetLimit',
  'free_asset_net_usageV2',
  'free_asset_net_usage',
  'latest_asset_operation_timeV2',
  'latest_asset_operation_time',
  'cancel_unfreezeV2_amount',
  // not a protobuf field at all: the servlet states it alongside the message
  'visible',
])

export function omitDefaults(value: unknown): unknown {
  if (value instanceof Float) return value
  if (Array.isArray(value)) {
    return value.map((element) => omitDefaults(element))
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (VERBATIM_FIELDS.has(key)) {
        out[key] = entry
        continue
      }
      if (SET_MESSAGE_FIELDS.has(key) && typeof entry === 'object' && entry !== null) {
        out[key] = omitDefaults(entry)
        continue
      }
      const pruned = omitDefaults(entry)
      if (pruned === undefined || pruned === null) continue
      if (pruned === 0 || pruned === 0n || pruned === '' || pruned === false) continue
      if (Array.isArray(pruned) && pruned.length === 0) continue
      if (
        typeof pruned === 'object' &&
        !Array.isArray(pruned) &&
        Object.keys(pruned).length === 0
      ) {
        continue
      }
      out[key] = pruned
    }
    return out
  }
  return value
}
