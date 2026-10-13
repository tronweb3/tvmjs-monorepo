import { BodyFormatError } from '../httpDialect.ts'

import { boolParam } from './address.ts'
import { INT64_FIELDS } from './int64Fields.ts'
import {
  checkFieldName,
  checkMergeField,
  fieldPosition,
  fieldTokens,
  skipUnknownField,
} from './mergeValue.ts'
import {
  MERGED_MESSAGE,
  MERGE_ENUMS,
  MERGE_ENUM_NAMES,
  MESSAGE_FIELDS,
  MESSAGE_FIELD_TYPES,
  SELF_FORMAT_FIELDS,
} from './mergedFields.ts'
import { Float, omitDefaults } from './proto.ts'
import { JAVA_TRON_ROUTES } from './routeManifest.ts'

import { ACCEPT, HTTP_METHOD, RAW_BODY } from '../registry.ts'

import { requestKeyed } from '../../lookup.ts'
import type { HttpDialect, RequestFacts, RouteKind } from '../httpDialect.ts'
import type { HandlerParams, Registry } from '../registry.ts'

/**
 * Routes this node adds on top of the TRON REST surface, with the verbs each
 * answers; a `wallet/*` path the manifest does not declare is refused before
 * any handler runs.
 */
const DEV_EXTENSIONS: Readonly<Record<string, RouteKind>> = requestKeyed({
  tre: 'P',
  admin: 'G',
  'admin/': 'G',
  'admin/accounts': 'G',
  'admin/accounts-json': 'G',
  'admin/accounts-generation': 'P',
  'admin/temporary-accounts-generation': 'P',
  healthcheck: 'B',
})

/** the namespace whose every path belongs to the admin servlet, named or not */
const ADMIN_PREFIX = 'admin/'

/**
 * Routes that read request parameters directly instead of parsing a JSON
 * message. Query parameters always apply; form fields also apply on POST.
 */
const QUERY_ONLY_ROUTES: ReadonlySet<string> = new Set([
  'admin/accounts-generation',
  'admin/temporary-accounts-generation',
  'healthcheck',
  'net/listnodes',
  'wallet/getassetissuelist',
  'wallet/getbandwidthprices',
  'wallet/getchainparameters',
  'wallet/getburntrx',
  'wallet/getenergyprices',
  'wallet/getmemofee',
  'wallet/getnextmaintenancetime',
  'wallet/getnodeinfo',
  'wallet/getnowblock',
  'wallet/getpendingsize',
  'wallet/listnodes',
  'wallet/listproposals',
  'wallet/listwitnesses',
  'wallet/totaltransaction',
])

/**
 * `NumberMessage.num` is an int64, while `AssetIssueContract.num` — the same
 * leaf name — is an int32. The reply's own message decides which one a route
 * is printing.
 */
const NUMBER_MESSAGE_ROUTES: ReadonlySet<string> = new Set([
  'wallet/getnextmaintenancetime',
  'wallet/totaltransaction',
])
const NUMBER_NUM: ReadonlySet<string> = new Set(['num'])
const EMPTY_FIELDS: ReadonlySet<string> = new Set()

/**
 * JSON text for a value, written by what the value is. Two kinds the JSON
 * number grammar cannot state travel whole: an int64 keeps its digits, where
 * `Number(bigint)` would round past 2^53, and a protobuf double keeps the
 * point that JSON's own formatting drops. Every other leaf goes through
 * `JSON.stringify`, so its escaping and number formatting are the platform's.
 *
 * `undefined` marks a value JSON omits: an object drops the member, an array
 * states it as null.
 */
function writeJSON(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Float) return value.text
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((element) => writeJSON(element) ?? 'null').join(',')}]`
  }
  const held = value as { toJSON?: () => unknown }
  if (typeof held.toJSON === 'function') return writeJSON(held.toJSON())
  const members: string[] = []
  for (const [key, entry] of Object.entries(value)) {
    const written = writeJSON(entry)
    if (written !== undefined) members.push(`${JSON.stringify(key)}:${written}`)
  }
  return `{${members.join(',')}}`
}

/**
 * Form bodies are decoded as URL-encoded pairs when they are not already JSON,
 * the `application/x-www-form-urlencoded` branch.
 */
function formToObject(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of new URLSearchParams(raw)) {
    out[key] = value
  }
  return out
}

/**
 * Whether a form value is already JSON — decided by parsing, so
 * an array or a bare scalar counts — each fails later, at the point that wants
 * an object. An empty body is passed straight on and fails at the merge.
 */
function isJSONText(raw: string): boolean {
  if (raw === '') return true
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

/**
 * A body a route parses for itself rather than merging. The merge-based routes
 * read an empty body as an empty message and fail inside the merge; these two
 * reach for a field on a parse that returned nothing, and the failure names the
 * accessor and the receiver it could not find.
 */
const OWN_BODY_PARSE: Readonly<Record<string, { empty: string; nullBody?: string }>> = requestKeyed(
  {
    'wallet/broadcasttransaction': {
      empty:
        'Cannot invoke "org.tron.json.JSONObject.getJSONObject(String)" because "jsonTransaction" is null',
    },
    // this one reads the body itself instead of going through the shared reader,
    // so it never consults `visible` and a literal null reaches its own parse too
    'wallet/broadcasthex': {
      empty:
        'Cannot invoke "org.tron.json.JSONObject.getString(String)" because the return value of "org.tron.json.JSONObject.parseObject(String)" is null',
      nullBody:
        'Cannot invoke "org.tron.json.JSONObject.getString(String)" because the return value of "org.tron.json.JSONObject.parseObject(String)" is null',
    },
  },
)

/** Strings are matched whole so digits inside them remain untouched. */
const JSON_TOKENS = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

/** how deep a body may nest, the outermost object counted as the first level */
const MAX_NESTING_DEPTH = 20

/**
 * The depth a body nests to, judged on the whole text before any field is
 * read. This runs ahead of the merge, so a body's shape settles its fate
 * before any field's type or value is looked at.
 */
function checkNestingDepth(body: string): void {
  let depth = 0
  let index = 0
  while (index < body.length) {
    const ch = body[index]
    if (ch === '"') {
      index += 1
      while (index < body.length && body[index] !== '"') {
        index += body[index] === '\\' ? 2 : 1
      }
    } else if (ch === '{' || ch === '[') {
      depth += 1
      if (depth > MAX_NESTING_DEPTH) {
        throw new BodyFormatError(
          `Document nesting depth (${depth}) exceeds the maximum allowed (${MAX_NESTING_DEPTH})`,
        )
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1
    }
    index += 1
  }
}

/** Restore wide integers using a second native parse with their digits quoted. */
function restoreIntegers(value: unknown, source: unknown): unknown {
  if (typeof value === 'number' && typeof source === 'string') return BigInt(source)
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const original = source as Record<string, unknown>
    for (const key of Object.keys(object)) {
      object[key] = restoreIntegers(object[key], original[key])
    }
  }
  return value
}

/** Standard JSON syntax, an object body, and lossless protocol integers. */
function parseJSONBody(raw: string, path: string): Record<string, unknown> {
  const own = OWN_BODY_PARSE[path]
  const trimmed = raw.trim()
  // an empty body clears the JSON layer and fails at the merge instead, which
  // is a different exception and so a different message
  if (trimmed === '') {
    throw new BodyFormatError(own?.empty ?? '1:1: Expected "{".')
  }
  // a literal null parses, yields no object, and the first field read off it
  // dereferences nothing
  if (trimmed === 'null') {
    throw new BodyFormatError(
      own?.nullBody ??
        'Cannot invoke "org.tron.json.JSONObject.containsKey(String)" because "jsonObject" is null',
    )
  }
  checkNestingDepth(trimmed)
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new BodyFormatError(`Unrecognized token: ${trimmed.slice(0, 32)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BodyFormatError('can not cast to JSONObject.')
  }
  // Node 20's reviver has no source text. Keep int64 digits without changing
  // JSON syntax, string values, or the handling of duplicate object keys.
  const exact = trimmed.replace(JSON_TOKENS, (token) =>
    /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? `"${token}"` : token,
  )
  return (exact === trimmed ? parsed : restoreIntegers(parsed, JSON.parse(exact))) as Record<
    string,
    unknown
  >
}

/** 64-bit fields printed as strings, which only a GET may ask for */
function int64AsString(value: unknown, extra: ReadonlySet<string>, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => int64AsString(element, extra, key))
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [entryKey, entry] of Object.entries(value)) {
      out[entryKey] = int64AsString(entry, extra, entryKey)
    }
    return out
  }
  if (key !== undefined && (INT64_FIELDS.has(key) || extra.has(key))) {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  }
  return value
}

/**
 * Step over every name the route's request message does not declare, in the
 * order they appear in the body — the order the merge itself would meet them.
 */
function mergeRequestBody(method: string, params: HandlerParams): void {
  const message = MERGED_MESSAGE[method]
  if (message === undefined) return
  const declared = MESSAGE_FIELDS[message] ?? {}
  Object.keys(params)
    // Envelope options are read by handlers, not merged into contract fields.
    .filter((field) => field !== 'visible' && field !== 'Permission_id')
    .map((field) => ({ field, at: fieldPosition(params, field) }))
    .sort((a, b) => a.at.line - b.at.line || a.at.column - b.at.column)
    .forEach(({ field }) => {
      // the name is read before the value it names
      checkFieldName(params, field)
      const kind = declared[field]
      if (kind === undefined) {
        skipUnknownField(params, field)
        return
      }
      for (const token of fieldTokens(params, field)) {
        checkMergeField(token, kind, {
          enums: MERGE_ENUMS,
          enumNames: MERGE_ENUM_NAMES,
          visible: boolParam(params.visible),
          selfFormat: SELF_FORMAT_FIELDS[message]?.[field],
          fieldName: `protocol.${message}.${field}`,
          messageFields: MESSAGE_FIELDS,
          messageFieldTypes: MESSAGE_FIELD_TYPES,
          messageSelfFormats: SELF_FORMAT_FIELDS,
          nestedMessage: MESSAGE_FIELD_TYPES[message]?.[field],
        })
      }
    })
}

/**
 * GET reads the query string and POST reads the body; the two never mix.
 */
async function readFields(facts: RequestFacts, method: string): Promise<HandlerParams> {
  if (facts.httpMethod === 'POST' && !QUERY_ONLY_ROUTES.has(method)) {
    const raw = await facts.body()
    if (facts.formEncoded) {
      const trimmed = raw.trim()
      // JSON form bodies use the same parser as application/json bodies.
      const fields: HandlerParams = isJSONText(trimmed)
        ? parseJSONBody(trimmed, method)
        : formToObject(trimmed)
      fields[RAW_BODY] = trimmed
      return fields
    }
    const fields: HandlerParams = parseJSONBody(raw, method)
    fields[RAW_BODY] = raw.trim()
    return fields
  }
  const params: HandlerParams = {}
  // a query-only route still has to drain the body before replying, and a
  // form-encoded one is folded into the parameters the same way the servlet
  // container folds it
  if (facts.httpMethod === 'POST') {
    const raw = await facts.body()
    if (facts.formEncoded) {
      for (const [key, value] of new URLSearchParams(raw)) {
        if (!(key in params)) params[key] = value
      }
    }
  }
  // a repeated parameter resolves to its first occurrence, like getParameter
  for (const [key, value] of facts.query) {
    if (!(key in params)) params[key] = value
  }
  return params
}

/** the TRON REST surface as it maps onto HTTP */
export function createTronHttpDialect(registry: Registry): HttpDialect {
  // Input and reply rules belong to the same definition the provider executes.
  // The original path still determines servlet availability, verbs and log names.
  const methodName = (path: string): string => registry.resolve(path)?.name ?? path
  return {
    hasHandler(path: string): boolean {
      return registry.resolve(path) !== undefined
    },

    routeKind(path: string): RouteKind | undefined {
      return JAVA_TRON_ROUTES[path]
    },

    isExtension(path: string): boolean {
      if (JAVA_TRON_ROUTES[path] !== undefined) return false
      return DEV_EXTENSIONS[path] !== undefined || path.startsWith(ADMIN_PREFIX)
    },

    extensionKind(path: string): RouteKind {
      // one servlet answers for the whole admin namespace, so a path it does
      // not name still answers the verbs it declares
      return DEV_EXTENSIONS[path] ?? 'G'
    },

    isRPCEnvelope(path: string): boolean {
      return path === 'tre'
    },

    async readParams(facts: RequestFacts): Promise<HandlerParams> {
      const params = await readFields(facts, methodName(facts.path))
      params[HTTP_METHOD] = facts.httpMethod
      params[ACCEPT] = facts.accept
      return params
    },

    prepare(facts: RequestFacts, params: HandlerParams): void {
      // the whole body is merged into the request message before the endpoint
      // reads anything, so a name that message does not declare is judged here
      if (facts.httpMethod === 'POST') mergeRequestBody(methodName(facts.path), params)
    },

    render(facts: RequestFacts, result: unknown): unknown {
      const path = facts.path
      // Both rewrites belong to the dialect, whose replies come from
      // protobuf printing. A dev extension has no protobuf behind it, so it is
      // served as written — the same reason a JSON-RPC reply is.
      //
      // Within the dialect, some routes are handwritten JSON
      // ({"count": 0} keeps its zero) and skip the default-value omission too.
      if (this.isExtension(path)) return result
      const definition = registry.resolve(path)
      let body = definition?.verbatim === true ? result : omitDefaults(result)
      // the flag is read off the query string before the servlet runs, and only
      // on GET: reading a POST body there would consume the reader the servlet
      // is about to use
      if (
        facts.httpMethod === 'GET' &&
        definition?.selfPrinted !== true &&
        boolParam(facts.query.get('int64_as_string'))
      ) {
        body = int64AsString(
          body,
          NUMBER_MESSAGE_ROUTES.has(definition?.name ?? path) ? NUMBER_NUM : EMPTY_FIELDS,
        )
      }
      return body
    },

    /**
     * Handlers should already return JSON-safe values; the tagging is the
     * safety net for the two the JSON number grammar cannot state directly.
     */
    serialize(body: unknown): string {
      return writeJSON(body) ?? 'null'
    },
  }
}
