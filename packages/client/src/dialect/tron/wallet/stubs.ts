import { Buffer } from 'node:buffer'
import { hexToBytes } from '@tvmjs/util'

import { TronWeb } from 'tronweb'
import { isVisible, parseTronAddress, tryParseTronAddress } from '../address.ts'

import { WITNESS_BROKERAGE } from '../../../core/witness.ts'
import { withVisibleAddresses } from '../visible.ts'
import { hexToUtf8Loose } from './asset.ts'
import { addressValueField, hexValueField, parseHexField } from './chain.ts'
import { HexDecodeError, JavaExceptionError, requireIntFields, requireLongParam } from './types.ts'

import type { NodeCore } from '../../../core/node.ts'
import type { HandlerParams, Registry } from '../../registry.ts'

/**
 * Fixed or empty views for features without mutable stores on this chain.
 *
 * The chain-wide brokerage keeps its default because it is a parameter, not a
 * measurement: an account that never changed it answers 20.
 */
export function registerStubHandlers(registry: Registry): void {
  // handwritten JSON: an otherwise-zero reward stays on the wire
  registry.register(
    'wallet/getReward',
    (node, params) => addressError(params) ?? { reward: rewardOf(node, params) },
    { solidity: true, verbatim: true },
  )
  // without an address there is no witness to report a share for
  registry.register(
    'wallet/getBrokerage',
    (node, params) => addressError(params) ?? brokerageOf(node, params),
    { solidity: true, verbatim: true, selfPrinted: true },
  )

  // committee and exchange: neither exists on a single-node chain
  // the confirmed surface does not carry this one
  registry.register('wallet/listproposals', () => ({}))
  // no proposal or exchange is ever created here, but the id still has to be
  // one before the store is consulted
  registry.register('wallet/getproposalbyid', (_node, params) => {
    requireLongParam(params, 'id')
    return {}
  })
  registry.register('wallet/getpaginatedproposallist', (_node, params) => {
    requireIntFields(params, ['offset', 'limit'])
    return {}
  })
  registry.register('wallet/listexchanges', () => ({}), { solidity: true })
  // the exchange lookup prints its result unconditionally, so a miss is a null
  // dereference rather than an empty object
  registry.register(
    'wallet/getexchangebyid',
    (_node, params) => {
      requireLongParam(params, 'id')
      throw new JavaExceptionError('null')
    },
    { solidity: true },
  )
  registry.register('wallet/getpaginatedexchangelist', (_node, params) => {
    requireIntFields(params, ['offset', 'limit'])
    return {}
  })

  // no market order can be placed here, so every market query is empty — but the argument
  // checks still run, because they happen before the store is consulted
  registry.register('wallet/getmarketpairlist', () => ({}), { solidity: true })
  registry.register(
    'wallet/getmarketorderbyaccount',
    (_node, params) => {
      addressValueField(params, 'value', true)
      return {}
    },
    { solidity: true },
  )
  registry.register(
    'wallet/getmarketorderbyid',
    (_node, params) => {
      // the store throws on a miss rather than reporting one
      if (hexValueField(params, 'value') === '') return {}
      throw new JavaExceptionError('order not found in store')
    },
    { solidity: true },
  )
  registry.register(
    'wallet/getmarketorderlistbypair',
    (_node, params) => {
      marketPair(params)
      return {}
    },
    { solidity: true },
  )
  registry.register(
    'wallet/getmarketpricebypair',
    (_node, params) => {
      const [sell, buy] = marketPair(params)
      // the reply echoes the pair it was asked about even when it holds no
      // prices, so both ids are on the wire whatever the store says
      return withVisibleAddresses({ sell_token_id: sell, buy_token_id: buy }, isVisible(params))
    },
    { solidity: true },
  )
  registry.register('wallet/totaltransaction', () => ({}))

  // handwritten JSON: the zero stays on the wire
  registry.register('wallet/getburntrx', (node) => ({ burnTrxAmount: node.burnedSun }), {
    solidity: true,
    verbatim: true,
  })

  /**
   * Pure address validation, no chain state involved. `message` mirrors the
   * three outcomes the endpoint distinguishes.
   */
  registry.register(
    'wallet/validateaddress',
    (_node, params) => {
      // Missing and null take the servlet's caught dereference branch; an
      // explicit empty string remains its separate, normal length error.
      if (params.address === undefined || params.address === null) {
        return {
          result: false,
          message: 'Cannot invoke "String.length()" because "input" is null',
        }
      }
      const input = String(params.address ?? '')
      // the three accepted encodings are told apart by length before anything
      // is decoded; every other length is a length error
      let decoded: Uint8Array | undefined
      let message: string
      try {
        if (input.length === 42) {
          if (!/^(?:[0-9a-fA-F]{2})*$/.test(input)) throw new HexDecodeError(input)
          decoded = hexToBytes(`0x${input}`)
          message = 'Hex string format'
        } else if (input.length === 34) {
          // a base58 decode that does not check out yields nothing rather than
          // raising, so the verdict below reports it as an invalid address
          const illegal = base58Failure(input)
          if (illegal !== undefined) return { result: false, message: illegal }
          try {
            decoded = Uint8Array.from([0x41, ...parseTronAddress(input).bytes])
          } catch {
            decoded = undefined
          }
          message = 'Base58check format'
        } else if (input.length === 28) {
          decoded = decodeBase64Address(input)
          message = 'Base64 format'
        } else {
          return { result: false, message: 'Length error' }
        }
      } catch (err) {
        return { result: false, message: (err as Error).message }
      }
      return decoded !== undefined && decoded.length === 21 && decoded[0] === 0x41
        ? { result: true, message }
        : { result: false, message: 'Invalid address' }
    },
    { verbatim: true, selfPrinted: true },
  )
}

/** the alphabet base58 decoding walks, reporting the first character outside it */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Validate the basic Base64 alphabet and final unit before decoding address bytes. */
function decodeBase64Address(input: string): Uint8Array {
  for (let at = 0; at < input.length; at++) {
    const char = input[at]
    if (/[A-Za-z0-9+/]/.test(char)) continue
    if (char !== '=') {
      const code = input.charCodeAt(at)
      const byte = code > 255 ? 63 : code > 127 ? code - 256 : code
      throw new Error(`Illegal base64 character ${byte.toString(16)}`)
    }
    const position = at % 4
    if (position === 0 || (position === 2 && input[at + 1] !== '=')) {
      throw new Error('Input byte array has wrong 4-byte ending unit')
    }
    if (position === 1) throw new Error('Last unit does not have enough valid bits')
    const end = at + (position === 2 ? 2 : 1)
    if (end < input.length) throw new Error(`Input byte array has incorrect ending byte at ${end}`)
    break
  }
  return Buffer.from(input, 'base64')
}

/**
 * A market pair as the servlets read it: each id is hex bytes, or the text of
 * those bytes under `visible`, and each must spell a token number — with `_`
 * standing for TRX.
 */
function marketPair(params: HandlerParams): [string, string] {
  const read = (key: string): string => {
    const raw = params[key]
    const hex = isVisible(params)
      ? TronWeb.fromUtf8(String(raw ?? '')).replace(/^0x/, '')
      : parseHexField(raw)
    return hex
  }
  const sell = read('sell_token_id')
  const buy = read('buy_token_id')
  for (const [hex, name] of [
    [sell, 'sellTokenId'],
    [buy, 'buyTokenId'],
  ] as const) {
    const text = hexToUtf8Loose(hex)
    // MarketUtils delegates the numeric branch to TransactionUtil.isNumber:
    // decimal text is necessary but not sufficient — a multi-byte id may not
    // start with zero.  That distinction occurs before either market store is
    // consulted, even on this intentionally orderless chain.
    if (text !== '_' && (!/^\d+$/.test(text) || (text.length > 1 && text.startsWith('0')))) {
      throw new JavaExceptionError(`${name} is not a valid number`)
    }
  }
  return [sell, buy]
}

/** every base58 address is this long, and a different length is not decoded at all */
const BASE58_ADDRESS_LENGTH = 34

/**
 * Base58 decoding as the shared helper performs it: the length is checked
 * first, so only a string of address length is walked — and there a character
 * outside the alphabet raises, while a checksum that does not check out simply
 * yields nothing.
 */
export function base58Failure(text: string): string | undefined {
  if (text.length !== BASE58_ADDRESS_LENGTH) return undefined
  for (let index = 0; index < text.length; index += 1) {
    if (!BASE58_ALPHABET.includes(text[index])) {
      return `Illegal character ${text[index]} at ${index}`
    }
  }
  return undefined
}

/**
 * The reward endpoints decode `41…` as hex and anything else as base58. Both
 * branches can raise — the hex decoder on a bad character or an odd length,
 * base58 on a character outside its alphabet — and the servlet wraps either in
 * an envelope of its own.
 */
function addressError(params: HandlerParams): Record<string, unknown> | undefined {
  const text = String(params.address ?? '')
  if (text === '') return undefined
  const envelope = (detail: string): Record<string, unknown> => ({
    Error: `INVALID address, ${detail}`,
  })
  if (text.startsWith('41')) {
    if (/^(?:[0-9a-fA-F]{2})+$/.test(text)) return undefined
    if (/^[0-9a-fA-F]+$/.test(text)) {
      // an odd digit count runs the decoder off the end of the string
      return envelope(`exception decoding Hex string: String index out of range: ${text.length}`)
    }
    return envelope('exception decoding Hex string: invalid characters encountered in Hex string')
  }
  const illegal = base58Failure(text)
  return illegal === undefined ? undefined : envelope(illegal)
}

/**
 * The allowance the queried account holds. A value that decodes but is not a
 * 21-byte address keys a store slot no account sits under, and reads as zero.
 */
function rewardOf(node: NodeCore, params: HandlerParams): bigint {
  // MortgageService.queryReward first checks this proposal gate.  The legacy
  // producer allowance can still accrue while delegation is disabled, but it
  // is deliberately not observable through getReward.
  if (node.config.chainParameters.allowChangeDelegation !== 1) return 0n
  const parsed = tryParseTronAddress(String(params.address ?? ''))
  return parsed === undefined ? 0n : node.rewardOf(parsed)
}

/** The source store accepts any decodable byte key. A short hex key simply
 * misses that store and therefore reads the protocol-default brokerage. */
function brokerageOf(node: NodeCore, params: HandlerParams): { brokerage: number } {
  if (!decodesToAddress(params)) return { brokerage: 0 }
  const address = tryParseTronAddress(String(params.address))
  return { brokerage: address === undefined ? WITNESS_BROKERAGE : node.brokerageOf(address) }
}

/** whether the address decodes to something the delegation store can be keyed by */
function decodesToAddress(params: HandlerParams): boolean {
  const text = String(params.address ?? '')
  if (text === '') return false
  if (text.startsWith('41')) return /^(?:[0-9a-fA-F]{2})+$/.test(text)
  return text.length === 34 && tryParseTronAddress(text) !== undefined
}
