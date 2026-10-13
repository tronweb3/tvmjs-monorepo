import type { NodeCore } from '../core/node.ts'

export const HTTP_METHOD: unique symbol = Symbol('httpMethod')
export const RAW_BODY: unique symbol = Symbol('rawBody')
export const ACCEPT: unique symbol = Symbol('accept')

/**
 * A request as a handler sees it: the fields it carried, plus what the
 * transport knows about how they arrived. The two are keyed apart — a field
 * name is a string, so a symbol key can never be one.
 */
export interface HandlerParams {
  [field: string]: unknown
  /**
   * The HTTP verb the request arrived on. A field's parsing rules differ
   * between the two: a query string is text that gets parsed, a JSON body is
   * already typed and the protobuf merge rejects the wrong type outright.
   */
  [HTTP_METHOD]?: string
  /**
   * The request body as it arrived. The protobuf merge reports the column a
   * failing value starts at, which is a property of the text rather than of
   * the parsed object.
   */
  [RAW_BODY]?: string
  /**
   * The `Accept` header as it arrived. A route that can answer in more than
   * one media type reads it to pick.
   */
  [ACCEPT]?: string
}

export type Handler = (node: NodeCore, params: HandlerParams) => Promise<unknown> | unknown

/**
 * A reply that is not JSON. The transport writes it as given, under the type
 * it names, instead of running it through the JSON serializer.
 */
export class TextBody {
  readonly text: string
  readonly contentType: string

  constructor(text: string, contentType: string) {
    this.text = text
    this.contentType = contentType
  }

  /** the declared media type, unspaced parameter and all */
  static plain(text: string): TextBody {
    return new TextBody(text, 'text/plain; charset=utf-8')
  }
}

export interface RegisterOpts {
  /** also expose under /walletsolidity — the confirmed mirror; with instant
   *  sealing "confirmed" and "latest" are the same state */
  solidity?: boolean
  /**
   * Skip the proto3 default-value omission. Handwritten-JSON routes keep
   * their zeros on the wire (`{"count": 0}`); routes
   * printed by `printTransaction` or `blockToJSON` have none left to drop.
   */
  verbatim?: boolean
  /**
   * The reply never passes through the protobuf JSON printer, so the printer's
   * options — `int64_as_string` among them — have nothing to act on.
   */
  selfPrinted?: boolean
}

/** One definition owns the input rules, handler and reply policy for all its names. */
export interface RegisteredMethod {
  readonly name: string
  readonly handler: Handler
  readonly verbatim: boolean
  readonly selfPrinted: boolean
}

/**
 * Dialect-neutral method table: REST paths ('wallet/getaccount')
 * and RPC method names ('tre_mine') share one namespace. Wallet paths are
 * case-sensitive (getReward/getBrokerage). Only explicitly registered aliases
 * share a definition.
 */
export class Registry {
  private entries: Map<string, RegisteredMethod> = new Map()

  register(path: string, handler: Handler, opts: RegisterOpts = {}): void {
    const paths = [path]
    if (opts.solidity === true) {
      if (!path.startsWith('wallet/')) throw new Error(`Not a wallet method: ${path}`)
      paths.push(path.replace(/^wallet\//, 'walletsolidity/'))
    }
    for (const name of paths) {
      if (this.entries.has(name)) throw new Error(`Method already registered: ${name}`)
    }
    const definition: RegisteredMethod = Object.freeze({
      name: path,
      handler,
      verbatim: opts.verbatim === true,
      selfPrinted: opts.selfPrinted === true,
    })
    for (const name of paths) this.entries.set(name, definition)
  }

  resolve(method: string): RegisteredMethod | undefined {
    return this.entries.get(method)
  }

  methods(): string[] {
    return [...this.entries.keys()]
  }
}
