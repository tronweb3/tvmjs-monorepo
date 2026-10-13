import { createServer } from 'node:http'
import { isIP } from 'node:net'

import { CLIENT_NAME, CLIENT_VERSION } from '../config.ts'
import { BlockTimeChangeError } from '../core/mining.ts'
import { BodyFormatError, allowHeader } from '../dialect/httpDialect.ts'
import { defaultRegistry } from '../dialect/index.ts'
import { TextBody } from '../dialect/registry.ts'
import { createTronHttpDialect } from '../dialect/tron/http.ts'
import { InvalidParamsError, MethodNotFoundError, providerCore, requestWire } from '../provider.ts'

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { HttpDialect, RequestFacts, RouteKind } from '../dialect/httpDialect.ts'
import type { HandlerParams } from '../dialect/registry.ts'
import type { TronProvider } from '../provider.ts'

/** body ceiling; a request past it is refused here and never reaches a handler */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * JSON bodies go out as the registered media type alone: RFC 8259 defines no
 * charset parameter for application/json and requires UTF-8. The JSON-RPC
 * face is JSON too.
 */
const JSON_CONTENT_TYPE = 'application/json'
/**
 * Who is serving, in the `product/version` form RFC 9110 §10.2.4 gives the
 * Server header (`@tvmjs/client` is not a token: `@` and `/` are delimiters).
 */
const SERVER_HEADER = `tvmjs/${CLIENT_VERSION}`

const encoder = new TextEncoder()
const dialect = createTronHttpDialect(defaultRegistry)

class PayloadTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  req.setEncoding('utf8')
  let raw = ''
  let bytes = 0
  for await (const chunk of req) {
    const text = chunk as string
    bytes += encoder.encode(text).length
    if (bytes > MAX_BODY_BYTES) {
      // stop reading, but leave the socket writable so the status can be sent
      req.pause()
      throw new PayloadTooLargeError()
    }
    raw += text
  }
  return raw
}

function isFormEncoded(req: IncomingMessage): boolean {
  // compared whole, so a charset parameter takes the request off this branch
  return req.headers['content-type'] === 'application/x-www-form-urlencoded'
}

/**
 * Method handling per endpoint. `S` routes declare an empty GET handler on real
 * nodes, so a GET reaches them but produces no body; `P` routes declare none at
 * all and the container answers 405. A path no route claims is served by the
 * container's own not-found servlet, which declares `doGet` alone — so a GET
 * there is 404 while a POST is 405.
 */
function methodOutcome(
  httpMethod: string,
  kind: RouteKind | undefined,
): 'run' | 'empty' | '404' | '405' | 'method-not-allowed' | '501' {
  switch (httpMethod) {
    case 'GET':
    case 'HEAD':
      if (kind === undefined) return '404'
      if (kind === 'P') return 'method-not-allowed'
      return kind === 'S' ? 'empty' : 'run'
    case 'POST':
      return kind === undefined || kind === 'G' ? 'method-not-allowed' : 'run'
    case 'PUT':
    case 'DELETE':
      return '405'
    // the servlet container recognises a fixed set of verbs and refuses the
    // rest before any servlet is consulted
    default:
      return '501'
  }
}

/** Browser-facing TRON routes carry CORS here; development controls do not. */
function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('server', SERVER_HEADER)
}

function setCors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'X-Requested-With,Content-Type,Accept')
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
}

/** Browser-inaccessible development controls; debug_* methods travel through /tre. */
function isControlRoute(path: string): boolean {
  return path === 'tre' || path === 'admin' || path.startsWith('admin/')
}

function requestHostname(host: string | undefined): string | undefined {
  if (host === undefined) return undefined
  try {
    const parsed = new URL(`http://${host}`)
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return undefined
    }
    return parsed.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function isWildcardBindHost(host: string): boolean {
  return host === '*' || host === '0.0.0.0' || host === '::'
}

function bindHostname(host: string): string {
  return isIP(host) === 6 ? `[${host.toLowerCase()}]` : host.toLowerCase()
}

function isAllowedControlHost(requestHost: string | undefined, bindHost: string): boolean {
  const hostname = requestHostname(requestHost)
  if (hostname === undefined) return false
  if (isWildcardBindHost(bindHost)) return true
  return isLoopbackHostname(hostname) || hostname === bindHostname(bindHost)
}

function sendForbidden(res: ServerResponse): void {
  const body = 'Forbidden\n'
  res.writeHead(403, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': encoder.encode(body).length,
  })
  res.end(body)
}

/** the request line and every header it carried, sent straight back */
function sendTraceEcho(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const echo = [`TRACE ${pathname} HTTP/${req.httpVersion}`]
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    echo.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
  }
  const body = `${echo.join('\r\n')}\r\n`
  res.writeHead(200, {
    'content-type': 'message/http',
    'content-length': encoder.encode(body).length,
  })
  res.end(body)
}

function sendJSON(dialect: HttpDialect, res: ServerResponse, status: number, body: unknown): void {
  // every response ends with a trailing newline
  const text = `${dialect.serialize(body)}\n`
  res.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': encoder.encode(text).length,
  })
  res.end(text)
}

/** Public errors carry the semantic message, never an implementation class. */
function servletFault(err: unknown): string {
  const held = err as { message?: unknown }
  return String(held?.message ?? err)
}

/** the container's own ceiling on the request line and headers together */
const MAX_HEADER_BYTES = 8192

/**
 * The request target as a URL. A target may arrive in absolute form
 * (`GET http://host/path`), which names the same resource as the origin form;
 * anything else is an opaque path, including a doubled leading slash, which
 * would otherwise parse as protocol-relative and move the path into the host.
 */
function targetURL(target: string): URL {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) {
    try {
      return new URL(target)
    } catch {
      // falls through to the opaque-path reading
    }
  }
  return new URL(`http://localhost${target.startsWith('/') ? target : `/${target}`}`)
}

/**
 * What the container answers when the parser refuses a request before any
 * route is looked up. Node's parser reports one code per failure; the reason
 * phrases are this node's own, as with every error body it writes.
 */
function parseFailure(err: NodeJS.ErrnoException, packet: string): [number, string] {
  const requestLine = packet.split('\r\n')[0] ?? ''
  switch (err.code) {
    case 'HPE_INVALID_METHOD':
      // a token the container does not implement, rather than a malformed one
      return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+ /.test(requestLine)
        ? [501, 'Not Implemented']
        : [400, 'Bad Request']
    case 'HPE_INVALID_VERSION':
      return / HTTP\/2(\.0)?$/.test(requestLine)
        ? [426, 'Upgrade Required']
        : [505, 'HTTP Version Not Supported']
    case 'HPE_HEADER_OVERFLOW':
      // the request line is measured on its own: a long one is the URI's fault
      return requestLine.length >= MAX_HEADER_BYTES
        ? [414, 'URI Too Long']
        : [431, 'Request Header Fields Too Large']
    default:
      return [400, 'Bad Request']
  }
}

/**
 * The path IS the method name; case preserved (getReward/getBrokerage). Path
 * parameters are stripped per segment before the mapping is looked up, while a
 * doubled leading slash maps to no servlet at all.
 */
function pathOf(url: URL): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    // a percent escape naming no byte; the container reads the target before
    // it reads the verb, so nothing below this is consulted
    return undefined
  }
  return decoded
    .split('/')
    .map((segment) => segment.split(';')[0])
    .join('/')
    .replace(/^\//, '')
}

/** a JSON-RPC 2.0 exchange over one path */
async function serveRPC(
  provider: TronProvider,
  dialect: HttpDialect,
  res: ServerResponse,
  params: HandlerParams,
): Promise<void> {
  const id = (params.id as number | string | null | undefined) ?? null
  try {
    const result = await requestWire(provider, {
      method: String(params.method ?? ''),
      params: (params.params ?? []) as HandlerParams,
    })
    sendJSON(dialect, res, 200, { jsonrpc: '2.0', id, result })
  } catch (err) {
    const code =
      err instanceof MethodNotFoundError
        ? -32601
        : err instanceof InvalidParamsError
          ? -32602
          : -32000
    sendJSON(dialect, res, 200, {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message: String((err as Error).message ?? err),
        ...(err instanceof BlockTimeChangeError ? { data: err.data } : {}),
      },
    })
  }
}

async function handle(
  provider: TronProvider,
  req: IncomingMessage,
  res: ServerResponse,
  bindHost: string,
) {
  const log = providerCore(provider).log
  setCommonHeaders(res)
  // a version this connection cannot speak is answered before the target is
  // read; the parser lets it through because the request line is well formed
  if (req.httpVersionMajor >= 2) {
    res.writeHead(426, { 'content-length': 0 })
    res.end()
    return
  }
  const url = targetURL(req.url ?? '/')
  const path = pathOf(url)
  if (path === undefined) {
    res.writeHead(400, { connection: 'close', 'content-length': 0 })
    res.end()
    return
  }
  const httpMethod = req.method ?? 'GET'
  const controlRoute = isControlRoute(path)

  if (controlRoute) {
    const fetchSite = req.headers['sec-fetch-site']
    if (
      !isAllowedControlHost(req.headers.host, bindHost) ||
      req.headers.origin !== undefined ||
      fetchSite === 'cross-site'
    ) {
      sendForbidden(res)
      return
    }
  } else {
    setCors(res)
  }

  const isExtension = dialect.isExtension(path)
  const kind = isExtension ? dialect.extensionKind(path) : dialect.routeKind(path)
  const registered = dialect.hasHandler(path) || dialect.isRPCEnvelope(path)

  if (httpMethod === 'OPTIONS') {
    // a preflight never reaches a handler, whatever the route. The verb list is
    // what the path's servlet declared; the not-found servlet writes no type
    res.writeHead(200, {
      ...(isExtension ? {} : { allow: allowHeader(kind) }),
      ...(kind === undefined && !isExtension ? {} : { 'content-type': JSON_CONTENT_TYPE }),
    })
    res.end()
    return
  }

  if (!dialect.isRPCEnvelope(path) || httpMethod !== 'POST') {
    log.start(url.pathname)
  }

  // TRACE is answered by the container, before any path lookup — so a path
  // that no servlet claims is echoed just like one that does
  if (httpMethod === 'TRACE') {
    sendTraceEcho(req, res, url.pathname)
    return
  }

  const outcome = methodOutcome(httpMethod, kind)
  if (outcome === '404') {
    // no such path on the served surface
    sendJSON(dialect, res, 404, { Error: `${path} not found` })
    return
  }
  if (outcome === 'method-not-allowed') {
    // the verbs a servlet declares but does not accept carry an explanation;
    // the ones no servlet declares at all carry nothing, not even a type
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(
      `${JSON.stringify({
        servlet: `${CLIENT_NAME}:${kind === undefined ? '404' : path}`,
        message: `HTTP method ${httpMethod} is not supported by this URL`,
        url: `/${path}`,
        status: '405',
      })}\n`,
    )
    return
  }
  if (outcome === '405' || outcome === '501') {
    res.writeHead(outcome === '405' ? 405 : 501)
    res.end()
    return
  }
  if (outcome === 'empty') {
    // the servlet ran, its doGet just wrote nothing — the type it declared
    // on the way in stands
    res.writeHead(200, { 'content-type': JSON_CONTENT_TYPE })
    res.end()
    return
  }
  if (!registered) {
    if (isExtension) {
      sendJSON(dialect, res, 404, { success: false, error: 'Not found' })
      return
    }
    // declared on the surface; this node does not serve it
    sendJSON(dialect, res, 501, { Error: `${path} is not implemented` })
    return
  }

  let read: Promise<string> | undefined
  const facts: RequestFacts = {
    httpMethod,
    path,
    query: url.searchParams,
    body: () => (read ??= readBody(req)),
    formEncoded: isFormEncoded(req),
    accept: req.headers.accept ?? '',
  }

  let params: HandlerParams
  try {
    params = await dialect.readParams(facts)
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      res.writeHead(413, { 'content-type': JSON_CONTENT_TYPE })
      res.end()
      return
    }
    if (err instanceof BodyFormatError) {
      log.failure('Invalid request body')
      sendJSON(dialect, res, 200, { Error: err.message })
      return
    }
    throw err
  }

  if (dialect.isRPCEnvelope(path)) {
    await serveRPC(provider, dialect, res, params)
    return
  }

  try {
    dialect.prepare(facts, params)
    const result = await requestWire(provider, { method: path, params })
    if (result instanceof TextBody) {
      res.writeHead(200, { 'content-type': result.contentType })
      res.end(result.text)
      return
    }
    sendJSON(dialect, res, 200, dialect.render(facts, result))
  } catch (err) {
    log.failure('Request rejected')
    if (err instanceof MethodNotFoundError) {
      sendJSON(dialect, res, 501, { Error: `${path} is not implemented` })
      return
    }
    // every other failure — a rejected request and an internal fault alike —
    // arrives as 200 + {Error} carrying the message alone
    sendJSON(dialect, res, 200, { Error: servletFault(err) })
  }
}

export function createHttpServer(provider: TronProvider, opts: { host?: string } = {}): Server {
  const log = providerCore(provider).log
  const bindHost = opts.host ?? '127.0.0.1'
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    const http = { method: 'HTTP', path: '' }
    void log.scope(async () => {
      try {
        http.method = req.method ?? 'GET'
        http.path = targetURL(req.url ?? '/').pathname
        await handle(provider, req, res, bindHost)
      } catch (err) {
        log.failure('HTTP response failed', 'ERROR')
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': JSON_CONTENT_TYPE })
        }
        res.end(`${JSON.stringify({ Error: servletFault(err) })}\n`)
      } finally {
        log.httpResult(res.statusCode)
      }
    }, http)
  })
  // a request the parser refuses never reaches a handler, so the status line is
  // written straight onto the socket
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    if (socket.writableEnded || socket.destroyed) return
    const packet = (err as { rawPacket?: Buffer }).rawPacket?.toString('latin1') ?? ''
    const [status, reason] = parseFailure(err, packet)
    log.scope(() => log.failure(`HTTP parser rejected request status=${status}`))
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  })
  // an idle keep-alive connection is closed after the servlet container's idle
  // timeout; a client reusing a connection judges it fresh well inside that
  server.keepAliveTimeout = 30_000
  return server
}

export interface StartedServer {
  server: Server
  port: number
  url: string
}

/** `host: '*'` binds every interface, dev keys and open admin surface included. */
export async function startHttpServer(
  provider: TronProvider,
  opts: { host?: string; port?: number } = {},
): Promise<StartedServer> {
  const host = opts.host ?? '127.0.0.1'
  const server = createHttpServer(provider, { host })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // '*' → no bind address → dual-stack wildcard (v4 + v6)
      if (host === '*') {
        server.listen(opts.port ?? 9090, () => resolve())
      } else {
        server.listen(opts.port ?? 9090, host, () => resolve())
      }
    })
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 9090)
  // the url is for connecting, so wildcard binds surface as loopback
  const connectHost = host === '*' ? '127.0.0.1' : host
  return {
    server,
    port,
    url: `http://${isIP(connectHost) === 6 ? `[${connectHost}]` : connectHost}:${port}`,
  }
}
