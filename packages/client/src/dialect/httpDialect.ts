import type { HandlerParams } from './registry.ts'

/**
 * Which of `doGet` / `doPost` a path's servlet overrides:
 *
 * - `B` — both, so either verb reaches the servlet
 * - `S` — `doGet` is an empty method body, so a GET answers 200 with no body
 * - `P` — `doPost` only; the container answers 405 for every other verb
 * - `G` — `doGet` only
 */
export type RouteKind = 'B' | 'S' | 'P' | 'G'

/** what the transport knows about a request before any dialect reads it */
export interface RequestFacts {
  httpMethod: string
  /** the path with its leading slash and any parameters stripped */
  path: string
  query: URLSearchParams
  /** reads the body once, and only when the dialect asks for it */
  body: () => Promise<string>
  formEncoded: boolean
  /** the `Accept` header, empty when the request carried none */
  accept: string
}

/**
 * How one wire protocol maps onto HTTP. The transport owns sockets, body
 * limits, verbs and status codes; everything about what a path means, how its
 * fields are stated and how its reply is printed lives behind this.
 */
export interface HttpDialect {
  /** whether this node implements a handler for the path */
  hasHandler(path: string): boolean
  /** the verbs a path answers, or undefined when the surface declares no such path */
  routeKind(path: string): RouteKind | undefined
  /** a path this node adds on top of the dialect's declared surface */
  isExtension(path: string): boolean
  /** the verbs an extension path answers */
  extensionKind(path: string): RouteKind
  /** a path whose body is a JSON-RPC 2.0 envelope rather than a field bag */
  isRPCEnvelope(path: string): boolean
  /** the request's fields, read off wherever this path states them */
  readParams(facts: RequestFacts): Promise<HandlerParams>
  /** runs before the handler; the dialect refuses a malformed request here */
  prepare(facts: RequestFacts, params: HandlerParams): void
  /** the value that goes on the wire for a handler's return value */
  render(facts: RequestFacts, result: unknown): unknown
  /** the reply as wire text, carrying the number forms this dialect prints */
  serialize(body: unknown): string
}

/**
 * The `Allow` header for a path. The container computes it from which `doXxx`
 * the servlet overrides: `HEAD` comes along with `doGet`, `TRACE` and
 * `OPTIONS` are always there, and a path no servlet claims is served by the
 * container's own not-found servlet, which declares `doGet` alone.
 */
export function allowHeader(kind: RouteKind | undefined): string {
  const methods: string[] = []
  if (kind !== 'P') methods.push('GET', 'HEAD')
  if (kind !== 'G' && kind !== undefined) methods.push('POST')
  methods.push('TRACE', 'OPTIONS')
  return methods.join(', ')
}

/** a request body the servlet layer refuses before any handler sees it */
export class BodyFormatError extends Error {}
