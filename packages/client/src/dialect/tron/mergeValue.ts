import { TronWeb } from 'tronweb'

import { INT32_MAX, INT32_MIN, INT64_MAX, INT64_MIN } from '../../intBounds.ts'
import { RAW_BODY } from '../registry.ts'

import type { HandlerParams } from '../registry.ts'

/**
 * The merge stage reads a request body as JSON tokens, and every failure it
 * reports names the token it stopped at. Reproducing those messages needs the
 * request text itself: the value's own spelling (`1.5`, `"abc"`, `true`) and
 * the line and column it starts at.
 */
export interface MergeToken {
  /** the value's text as it was written, quotes included for a string */
  text: string
  /** whether the token is a quoted string, which is what a bytes field wants */
  quoted: boolean
  line: number
  column: number
  /** Source text and offset when this token came from an HTTP JSON body. */
  body?: string
  at?: number
}

/** JSON text for a direct provider value.  Native `JSON.stringify` cannot
 * descend through a bigint held in a nested message; protobuf sees those
 * digits as an integer token, not as a quoted string. */
function syntheticJSON(value: unknown): string | undefined {
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => syntheticJSON(item) ?? 'null').join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value)
      .flatMap(([key, item]) => {
        const text = syntheticJSON(item)
        return text === undefined ? [] : [`${JSON.stringify(key)}:${text}`]
      })
      .join(',')
    return `{${fields}}`
  }
  return JSON.stringify(value)
}

/**
 * A value the request text cannot be consulted for. A query string is merged
 * as a one-field object, which puts the value right after `{"<field>":`.
 */
export function syntheticToken(field: string, value: unknown): MergeToken {
  // a bigint is an int64 that kept its digits; its token is those digits
  const text = syntheticJSON(value)
  const sourceText = text === undefined ? String(value) : text
  return {
    text: sourceText,
    quoted: typeof value === 'string',
    line: 1,
    column: field.length + 5,
    body: sourceText,
    at: 0,
  }
}

/**
 * Every newline offset in the body being read, held while it is the one being
 * read. A request merges in one synchronous pass, so the whole pass shares an
 * index.
 */
let indexedBody = ''
let indexedNewlines: number[] = []

function newlinesOf(body: string): number[] {
  if (body === indexedBody) return indexedNewlines
  const offsets: number[] = []
  for (let at = body.indexOf('\n'); at >= 0; at = body.indexOf('\n', at + 1)) offsets.push(at)
  indexedBody = body
  indexedNewlines = offsets
  return offsets
}

function positionOf(body: string, at: number): { line: number; column: number } {
  const newlines = newlinesOf(body)
  let low = 0
  let high = newlines.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (newlines[mid] < at) low = mid + 1
    else high = mid
  }
  return { line: low + 1, column: at - (low === 0 ? -1 : newlines[low - 1]) }
}

/** the span of one JSON value starting at `at`, as the tokenizer would read it */
function readToken(body: string, at: number): { text: string; quoted: boolean; end: number } {
  if (body[at] === '"') {
    let index = at + 1
    while (index < body.length && body[index] !== '"') {
      index += body[index] === '\\' ? 2 : 1
    }
    return { text: body.slice(at, index + 1), quoted: true, end: index + 1 }
  }
  // a scalar field handed an object stops the parser at the brace itself
  if (body[at] === '{') return { text: '{', quoted: false, end: at + 1 }
  const bare = /^[^\s,\]}]*/.exec(body.slice(at))
  const text = bare === null ? '' : bare[0]
  return { text, quoted: false, end: at + text.length }
}

/**
 * The offset just past one whole value, braces and brackets balanced. A token
 * only ever names where a value starts, so stepping to the next one needs the
 * whole span.
 */
function valueEnd(body: string, at: number): number {
  const opener = body[at]
  if (opener !== '{' && opener !== '[') return readToken(body, at).end
  let depth = 0
  let index = at
  while (index < body.length) {
    const ch = body[index]
    if (ch === '"') {
      index = readToken(body, index).end
      continue
    }
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return index
}

/** The value tokens the merge sees at one object member, including a bare
 * value in place of a repeated field's list. */
function tokensAt(body: string, start: number): MergeToken[] {
  if (body[start] !== '[') {
    return [{ ...readToken(body, start), ...positionOf(body, start), body, at: start }]
  }
  const tokens: MergeToken[] = []
  let at = start + 1
  while (at < body.length) {
    const prevAt = at
    const skip = body.slice(at).search(/\S/)
    if (skip < 0) break
    at += skip
    if (body[at] === ']') break
    tokens.push({ ...readToken(body, at), ...positionOf(body, at), body, at })
    at = valueEnd(body, at)
    const next = body.slice(at).search(/\S/)
    if (next < 0) break
    at += next
    if (body[at] === ',') at += 1
    if (at <= prevAt) break
  }
  return tokens
}

/** the depth of nesting a body may state before the reader gives up */
const MAX_NESTING_DEPTH = 20

/** one member as the body wrote it: where its name starts, where its value does */
interface Member {
  key: number
  value: number
}

interface NestedMember extends Member {
  field: string
}

const MEMBERS = new WeakMap<object, Map<string, Member[]>>()

/**
 * Where each top-level member's value begins, by name, in the order the body
 * wrote them. The body is walked as JSON, so a member is a pair the outermost
 * object declares; the same characters inside a nested object or inside a
 * string are text, and the walk steps over them.
 *
 * A name stated more than once keeps every offset. The merge reads them in
 * order, so the last is the value that survives — what setting a singular
 * field twice means.
 */
function memberOffsets(body: string): Map<string, Member[]> {
  const found = new Map<string, Member[]>()
  let index = body.search(/\S/)
  if (index < 0 || body[index] !== '{') return found
  index += 1
  for (;;) {
    const skip = body.slice(index).search(/\S/)
    if (skip < 0) return found
    index += skip
    if (body[index] !== '"') return found
    const at = index
    const name = readToken(body, index)
    index = name.end
    const colon = body.slice(index).search(/\S/)
    if (colon < 0 || body[index + colon] !== ':') return found
    index += colon + 1
    const value = body.slice(index).search(/\S/)
    if (value < 0) return found
    index += value
    // the name is the token's text without its quotes, escapes as written
    const key = name.text.slice(1, -1)
    const stated = found.get(key)
    if (stated === undefined) found.set(key, [{ key: at, value: index }])
    else stated.push({ key: at, value: index })
    index = valueEnd(body, index)
    const after = body.slice(index).search(/\S/)
    if (after < 0) return found
    index += after
    if (body[index] !== ',') return found
    index += 1
  }
}

/** The raw members of an object nested below the request root.  Field names
 * are intentionally handled as the protobuf tokenizer handles identifiers:
 * quotes are removed, while other characters remain for the identifier check
 * to reject. */
function nestedMembers(body: string, start: number): NestedMember[] {
  const found: NestedMember[] = []
  if (body[start] !== '{') return found
  let index = start + 1
  for (;;) {
    const skip = body.slice(index).search(/\S/)
    if (skip < 0) return found
    index += skip
    if (body[index] === '}') return found
    if (body[index] !== '"') return found
    const key = index
    const name = readToken(body, index)
    index = name.end
    const colon = body.slice(index).search(/\S/)
    if (colon < 0 || body[index + colon] !== ':') return found
    index += colon + 1
    const valueSkip = body.slice(index).search(/\S/)
    if (valueSkip < 0) return found
    index += valueSkip
    found.push({ key, value: index, field: name.text.replace(/["']/g, '') })
    index = valueEnd(body, index)
    const after = body.slice(index).search(/\S/)
    if (after < 0) return found
    index += after
    if (body[index] === '}') return found
    if (body[index] !== ',') return found
    index += 1
  }
}

/** the members a name was written as, cached for the request that asked */
function membersOf(params: HandlerParams, field: string): Member[] {
  const raw = params[RAW_BODY]
  const body = typeof raw === 'string' ? raw : ''
  if (body === '') return []
  let members = MEMBERS.get(params)
  if (members === undefined) {
    members = memberOffsets(body)
    MEMBERS.set(params, members)
  }
  return members.get(field) ?? []
}

/** the offsets a field's values begin at */
function valueStarts(params: HandlerParams, field: string): number[] {
  return membersOf(params, field).map((member) => member.value)
}

/** the characters a name may hold; the token carries its quotes, so they are in the set */
const IDENTIFIER_CHAR = /[A-Za-z0-9_."]/

/**
 * A member's name, read as an identifier. The name is read before its value
 * is, so a character the set leaves out stops the body where the name stands,
 * whatever field it would have named.
 */
export function checkFieldName(params: HandlerParams, field: string): void {
  const raw = params[RAW_BODY]
  const body = typeof raw === 'string' ? raw : ''
  const member = membersOf(params, field)[0]
  if (body === '' || member === undefined) return
  for (const ch of field) {
    if (IDENTIFIER_CHAR.test(ch)) continue
    throw new MergeError(
      { text: '', quoted: false, ...positionOf(body, member.key) },
      `Expected identifier. -${ch}`,
    )
  }
}

/**
 * The tokens one field merges from. A list is stepped into rather than
 * rejected, so each element is a token of its own — every element is parsed,
 * and for a singular field the last one to parse is the value that survives.
 */
export function fieldTokens(params: HandlerParams, field: string): MergeToken[] {
  const raw = params[RAW_BODY]
  const body = typeof raw === 'string' ? raw : ''
  const starts = valueStarts(params, field)
  if (starts.length === 0) {
    const value = params[field]
    if (value === undefined) return []
    return Array.isArray(value)
      ? value.map((element) => syntheticToken(field, element))
      : [syntheticToken(field, value)]
  }
  return starts.flatMap((start) => tokensAt(body, start))
}

/** where a field's value begins, whatever shape it has */
export function fieldPosition(
  params: HandlerParams,
  field: string,
): { line: number; column: number } {
  const raw = params[RAW_BODY]
  const body = typeof raw === 'string' ? raw : ''
  // a name stated more than once is met where it was first written
  const start = valueStarts(params, field)[0]
  return start === undefined ? { line: 1, column: field.length + 5 } : positionOf(body, start)
}

export function tokenPosition(token: MergeToken): string {
  return `${token.line}:${token.column}`
}

/** the merge stage reporting where it stopped and what it wanted there */
export class MergeError extends Error {
  constructor(token: MergeToken, detail: string) {
    super(`${tokenPosition(token)}: ${detail}`)
  }
}

const DIGITS: Record<number, RegExp> = {
  8: /^[0-7]+$/,
  10: /^\d+$/,
  16: /^[0-9a-fA-F]+$/,
}

/** how many digits of each radix one 32-bit word holds */
const DIGITS_PER_WORD: Record<number, number> = { 8: 10, 10: 9, 16: 7 }

/**
 * What a failed parse reports. Up to fifteen characters the whole token is
 * read at once and named in full; beyond that it is read a word at a time, so
 * a stray sign is caught before any digits are and the first group is as far
 * as the parse otherwise gets.
 */
function integerFailure(numberText: string, radix: number): string {
  if (numberText.length < 16) return `For input string: "${numberText}"`
  const minus = numberText.lastIndexOf('-')
  const plus = numberText.lastIndexOf('+')
  if ((minus >= 0 && (minus !== 0 || plus >= 0)) || plus > 0) {
    return 'Illegal embedded sign character'
  }
  const per = DIGITS_PER_WORD[radix]
  return `For input string: "${numberText.slice(0, numberText.length % per || per)}"`
}

/**
 * An int64 field as `parseInteger` reads it: a leading `0x` marks hexadecimal
 * and a bare leading `0` octal, and a value too wide for 64 bits names its own
 * range rather than the text. The parser works on the token as written, so a
 * quoted string carries its quotes into the message it is blamed in.
 */
export function parseMergeInt64(token: MergeToken): bigint {
  return parseMergeInteger(token, true)
}

/** the same parse held to 32 bits, which is what an enum member is read as */
export function parseMergeInt32(token: MergeToken): bigint {
  return parseMergeInteger(token, false)
}

function parseMergeInteger(token: MergeToken, isLong: boolean): bigint {
  const text = token.text
  let pos = 0
  const negative = text.startsWith('-')
  if (negative) pos = 1
  let radix = 10
  if (text.startsWith('0x', pos)) {
    radix = 16
    pos += 2
  } else if (text.startsWith('0', pos)) {
    radix = 8
  }
  const numberText = text.slice(pos)
  if (!DIGITS[radix].test(numberText)) {
    throw new MergeError(token, `Couldn't parse integer: ${integerFailure(numberText, radix)}`)
  }
  const prefix = radix === 16 ? '0x' : radix === 8 ? '0o' : ''
  const magnitude = BigInt(
    `${prefix}${radix === 8 ? numberText.replace(/^0+(?=.)/, '') : numberText}`,
  )
  const value = negative ? -magnitude : magnitude
  const [max, min, width] = isLong ? [INT64_MAX, INT64_MIN, 64] : [INT32_MAX, INT32_MIN, 32]
  if (value > max || value < min) {
    throw new MergeError(
      token,
      `Couldn't parse integer: Number out of range for ${width}-bit signed integer: ${text}`,
    )
  }
  return value
}

/**
 * A whole int64 field. Every element of a list is parsed and each one
 * overwrites the last, so a singular field ends up holding the final element;
 * an absent field and an empty list both leave the protobuf default in place.
 */
export function mergeInt64Field(params: HandlerParams, field: string): bigint {
  let value = 0n
  for (const token of fieldTokens(params, field)) {
    if (token.text === 'null') continue
    value = parseMergeInt64(token)
  }
  return value
}

/**
 * An enum field. A numeric token is looked up by value; anything else is read
 * as an identifier, quotes stripped, and an all-lowercase spelling is
 * capitalised before the lookup — which is why `normal` resolves but `NORMAL`
 * does not.
 */
export function parseMergeEnum(
  token: MergeToken,
  enumName: string,
  values: Readonly<Record<string, number>>,
): number {
  if (/^[+-]?\d+$/.test(token.text) || /^-?\d*\.\d+$/.test(token.text)) {
    // the number is read as an int32 first, so a fraction or a value too wide
    // fails before the enum is consulted
    const number = Number(parseMergeInt32(token))
    if (!Object.values(values).includes(number)) {
      throw new MergeError(token, `Enum type "${enumName}" has no value with number ${number}.`)
    }
    return number
  }
  const offending = /[^A-Za-z0-9_."']/.exec(token.text)
  if (offending !== null) {
    throw new MergeError(token, `Expected identifier. -${offending[0]}`)
  }
  let id = token.text.replace(/["']/g, '')
  if (/^[a-z]+$/.test(id)) id = `${id[0].toUpperCase()}${id.slice(1)}`
  const value = values[id]
  if (value === undefined) {
    throw new MergeError(token, `Enum type "${enumName}" has no value named "${id}".`)
  }
  return value
}

/**
 * A repeated field's elements. The merge accepts a bare value where a list is
 * declared and treats it as a list of one, so a single object reaches the same
 * place a one-element array would.
 */
export function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * A field the target message does not declare. The merge still walks its value
 * to step over it, and that walk has its own grammar: an object must hold
 * `identifier: value` pairs, so an empty one stops at the closing brace, and a
 * list must hold values, so an empty one stops at the closing bracket.
 */
export function skipUnknownField(params: HandlerParams, field: string): void {
  const raw = params[RAW_BODY]
  const body = typeof raw === 'string' ? raw : ''
  if (body === '') return
  // every occurrence is stepped over: the reader meets each of them in turn
  for (const start of valueStarts(params, field)) walkSkipped(body, start, 0)
}

/** the offset just past the value at `at`, raising where the walk cannot go on */
function walkSkipped(body: string, at: number, depth: number): number {
  if (depth >= MAX_NESTING_DEPTH) {
    throw new MergeError(
      { text: '', quoted: false, ...positionOf(body, at) },
      'Hit recursion limit.',
    )
  }
  const opener = body[at]
  if (opener !== '{' && opener !== '[') {
    // whatever is left is read as one of four primitive shapes, chosen by the
    // first character: a token that starts with a digit or a sign is read as
    // an integer whatever follows, and only the last shape wants a quote
    const token = { ...readToken(body, at), ...positionOf(body, at) }
    if (token.text === 'null' || token.text === 'true' || token.text === 'false') {
      return token.end
    }
    if (!token.quoted && /^[-+0-9]/.test(token.text)) {
      parseMergeInt64(token)
      return token.end
    }
    if (!token.quoted) throw new MergeError(token, 'Expected string.')
    return token.end
  }
  const closer = opener === '{' ? '}' : ']'
  let index = at + 1
  for (;;) {
    const skip = body.slice(index).search(/\S/)
    index += skip < 0 ? 0 : skip
    if (opener === '{') {
      // the pair's name is read before its value, so there is no empty object
      if (body[index] !== '"') {
        throw new MergeError(
          { text: '', quoted: false, ...positionOf(body, index) },
          `Expected identifier. -${body[index] ?? ''}`,
        )
      }
      index = readToken(body, index).end
      const colon = body.slice(index).search(/\S/)
      index += colon < 0 ? 0 : colon
      if (body[index] === ':') index += 1
      const next = body.slice(index).search(/\S/)
      index += next < 0 ? 0 : next
    }
    index = walkSkipped(body, index, depth + 1)
    const after = body.slice(index).search(/\S/)
    index += after < 0 ? 0 : after
    if (body[index] === ',') {
      index += 1
      continue
    }
    return body[index] === closer ? index + 1 : index
  }
}

/**
 * One declared field against the type its message gives it. The merge reads a
 * token per type — a quoted string for bytes, a number for an integer, one of
 * two literals for a bool — and names what it wanted where the token failed.
 */
export interface MergeFieldContext {
  enums?: Readonly<Record<string, Readonly<Record<string, number>>>>
  enumNames?: Readonly<Record<string, string>>
  /** whether the request states addresses and names in their readable form */
  visible?: boolean
  /** what this bytes field carries, when it is not raw bytes */
  selfFormat?: 'address' | 'name'
  /** the field's fully qualified name, which an address failure states */
  fieldName?: string
  /** concrete message tables needed to validate a nested message */
  messageFields?: Readonly<Record<string, Readonly<Record<string, string>>>>
  messageFieldTypes?: Readonly<Record<string, Readonly<Record<string, string>>>>
  messageSelfFormats?: Readonly<Record<string, Readonly<Record<string, 'address' | 'name'>>>>
  /** the concrete nested message carried by this field */
  nestedMessage?: string
  /** nested-message depth; the merge grammar admits at most 20 levels */
  depth?: number
}

function checkNestedFieldName(body: string, field: string, at: number): void {
  for (const ch of field) {
    if (IDENTIFIER_CHAR.test(ch)) continue
    throw new MergeError(
      { text: '', quoted: false, ...positionOf(body, at) },
      `Expected identifier. -${ch}`,
    )
  }
}

/** One nested object, read under the grammar the request root uses: a declared
 * field is parsed by its type, and an unknown one is stepped over token by
 * token. */
function checkNestedMessage(token: MergeToken, message: string, context: MergeFieldContext): void {
  const body = token.body ?? token.text
  const start = token.at ?? 0
  const depth = context.depth ?? 0
  if (depth >= MAX_NESTING_DEPTH) throw new MergeError(token, 'Hit recursion limit.')
  const declared = context.messageFields?.[message]
  if (declared === undefined) return
  for (const member of nestedMembers(body, start)) {
    checkNestedFieldName(body, member.field, member.key)
    const kind = declared[member.field]
    if (kind === undefined) {
      walkSkipped(body, member.value, depth + 1)
      continue
    }
    for (const nested of tokensAt(body, member.value)) {
      checkMergeField(nested, kind, {
        ...context,
        selfFormat: context.messageSelfFormats?.[message]?.[member.field],
        fieldName: `protocol.${message}.${member.field}`,
        nestedMessage: context.messageFieldTypes?.[message]?.[member.field],
        depth: depth + 1,
      })
    }
  }
}

export function checkMergeField(
  token: MergeToken,
  kind: string,
  context: MergeFieldContext = {},
): void {
  if (token.text === 'null') return
  const repeated = kind.endsWith('[]')
  const base = repeated ? kind.slice(0, -2) : kind
  if (base === 'message') {
    // a message is stepped into, and its own fields are judged there
    // Direct provider calls have no raw JSON body to walk, so their synthetic
    // token holds the whole object rather than only its opening brace.
    if (!token.text.startsWith('{')) throw new MergeError(token, 'Expected "{".')
    if (context.nestedMessage !== undefined && context.messageFields !== undefined) {
      checkNestedMessage(token, context.nestedMessage, context)
    }
    return
  }
  if (base === 'bytes' || base === 'string') {
    if (!token.quoted) throw new MergeError(token, 'Expected string.')
    if (base === 'string') return
    const raw = token.text.slice(1, -1)
    if (raw === '') return
    // a name is the text it holds and an address is base58, but only where the
    // request says it states them that way
    if (context.visible === true && context.selfFormat === 'name') return
    if (context.visible === true && context.selfFormat === 'address') {
      // the visible form is base58check alone: a 41-hex address is decoded by
      // base58 rules here and fails like any other non-base58 text
      if (!(raw.startsWith('T') && TronWeb.isAddress(raw))) {
        throw new MergeError(token, `invalid address for field: ${context.fieldName ?? ''}`)
      }
      return
    }
    // the prefix is matched exactly, and what follows may be any number of hex
    // digits — an odd count is padded and none at all is empty bytes
    if (!/^[0-9a-fA-F]*$/.test(raw.startsWith('0x') ? raw.slice(2) : raw)) {
      throw new MergeError(token, 'INVALID hex String')
    }
    return
  }
  if (base === 'bool') {
    if (token.text !== 'true' && token.text !== 'false') {
      throw new MergeError(token, 'Expected "true" or "false".')
    }
    return
  }
  if (base.startsWith('enum:')) {
    const name = base.slice(5)
    parseMergeEnum(token, context.enumNames?.[name] ?? name, context.enums?.[name] ?? {})
    return
  }
  if (base === 'int32') {
    parseMergeInt32(token)
    return
  }
  parseMergeInt64(token)
}
