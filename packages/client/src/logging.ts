import { AsyncLocalStorage } from 'node:async_hooks'

import type { BlockRecord } from './core/blockStore.ts'

/** Receives formatted runtime log lines. `console` is a compatible logger. */
export interface Logger {
  log(message: string): void
}
type Level = 'INFO' | 'WARN' | 'ERROR'

type RequestLog = {
  method?: string
  failed: boolean
  http?: { method: string; path: string }
  failure?: { reason: string; level: 'WARN' | 'ERROR' }
}

const FAILURE_CODES = new Set([
  'SIGERROR',
  'CONTRACT_VALIDATE_ERROR',
  'CONTRACT_EXE_ERROR',
  'BANDWITH_ERROR',
  'DUP_TRANSACTION_ERROR',
  'TAPOS_ERROR',
  'TOO_BIG_TRANSACTION_ERROR',
  'TRANSACTION_EXPIRATION_ERROR',
  'SERVER_BUSY',
  'NO_CONNECTION',
  'NOT_ENOUGH_EFFECTIVE_CONNECTION',
  'OTHER_ERROR',
  'REVERT',
  'OUT_OF_ENERGY',
  'OUT_OF_TIME',
  'ILLEGAL_OPERATION',
  'INVALID_CODE',
  'BAD_JUMP_DESTINATION',
  'OUT_OF_MEMORY',
  'PRECOMPILED_CONTRACT',
  'STACK_TOO_SMALL',
  'STACK_TOO_LARGE',
  'JVM_STACK_OVER_FLOW',
  'TRANSFER_FAILED',
  'UNKNOWN',
])

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function failureCode(value: unknown): string | undefined {
  return typeof value === 'string' && FAILURE_CODES.has(value) ? value : undefined
}

/** Log fixed categories; exception messages and response text can contain input values. */
function failureReason(error: unknown): string {
  const code = failureCode(object(object(error)?.reply)?.code)
  if (code !== undefined) return code
  if (error instanceof TypeError || error instanceof RangeError) return 'Invalid parameters'
  const name = error instanceof Error ? error.constructor.name : ''
  if (name === 'InvalidParamsError') return 'Invalid parameters'
  if (name === 'MethodNotFoundError') return 'Method not found'
  return 'Request failed'
}

function resultFailure(method: string, value: unknown): string | undefined {
  const reply = object(value)
  if (reply === undefined) return undefined
  if (reply.Error !== undefined) return 'Request rejected'
  if (
    (method === 'wallet/broadcasttransaction' || method === 'wallet/broadcasthex') &&
    reply.result === false
  ) {
    return failureCode(reply.code) ?? 'Transaction rejected'
  }
  if (
    ![
      'wallet/triggersmartcontract',
      'wallet/triggerconstantcontract',
      'wallet/estimateenergy',
    ].includes(method)
  )
    return undefined
  const ret = object(reply.transaction)?.ret
  if (Array.isArray(ret) && ret.some((entry) => object(entry)?.ret === 'FAILED'))
    return 'Contract reverted'
  const result = object(reply.result)
  if (result !== undefined && (result.code !== undefined || result.result === false)) {
    return failureCode(result.code) ?? 'Contract call failed'
  }
  return undefined
}

function formatLine(level: Level, message: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const timestamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())}|${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return `[${timestamp}] ${level} ${message}`
}

/** Keep request names recognizable, bounded and on a single terminal line. */
function requestName(value: string): string {
  const escaped = JSON.stringify(String(value))
    .slice(1, -1)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`)
  return escaped.length > 160 ? `${escaped.slice(0, 160)}…` : escaped
}

/** Node-local runtime output; nested dispatch shares one request record. */
export class NodeLog {
  private readonly logger: Logger | undefined
  private readonly callLogger: <T>(callback: () => T) => T
  private readonly request = new AsyncLocalStorage<RequestLog>()

  constructor(logger?: Logger, callLogger: <T>(callback: () => T) => T = (callback) => callback()) {
    this.logger = logger
    this.callLogger = callLogger
  }

  private write(level: Level, message: string, fallback = false): void {
    const line = formatLine(level, message)
    if (this.logger !== undefined) {
      try {
        void Promise.resolve(this.callLogger(() => this.logger!.log(line))).catch(() => {})
      } catch {
        // Output failures leave node operations intact.
      }
    }
    if (fallback && this.logger === undefined) {
      try {
        // eslint-disable-next-line no-console -- Background failures remain visible without a configured logger.
        console.error(line)
      } catch {
        // The next interval still runs when the output stream fails.
      }
    }
  }

  scope<T>(action: () => T, http?: RequestLog['http']): T {
    return this.request.run({ failed: false, http }, action)
  }

  start(method: string): void {
    const request = this.request.getStore()
    if (request?.method !== undefined) return
    const name =
      request?.http === undefined
        ? requestName(method)
        : `${requestName(request.http.method)} ${requestName(method)}`
    if (request !== undefined) request.method = name
    this.write('INFO', name)
  }

  run<T>(method: string, action: () => T, resultMethod = method): T {
    if (this.request.getStore() === undefined)
      return this.scope(() => this.run(method, action, resultMethod))
    this.start(method)
    const completed = (result: T): T => {
      const failure = resultFailure(resultMethod, result)
      if (failure !== undefined) this.failure(failure)
      return result
    }
    try {
      const result = action()
      if (result instanceof Promise) {
        return result.then(completed, (error) => {
          this.failure(failureReason(error))
          throw error
        }) as T
      }
      return completed(result)
    } catch (error) {
      this.failure(failureReason(error))
      throw error
    }
  }

  failure(reason: string, level: 'WARN' | 'ERROR' = 'WARN'): void {
    const request = this.request.getStore()
    if (request?.http !== undefined) {
      if (request.failure === undefined || level === 'ERROR') request.failure = { reason, level }
      return
    }
    if (request?.failed === true) return
    if (request !== undefined) request.failed = true
    this.write(level, request?.method === undefined ? reason : `${request.method}: ${reason}`)
  }

  httpResult(status: number): void {
    const request = this.request.getStore()
    if (request?.http === undefined) return
    const name =
      request.method ??
      [requestName(request.http.method), requestName(request.http.path)].filter(Boolean).join(' ')
    if (status >= 400) {
      this.write(status >= 500 && status !== 501 ? 'ERROR' : 'WARN', `${name} status=${status}`)
    } else if (request.failure !== undefined) {
      this.write(request.failure.level, `${name}: ${request.failure.reason}`)
    }
  }

  committed(block: BlockRecord): void {
    this.write('INFO', `Produced block number=${block.number} txs=${block.txs.length}`)
    for (const tx of block.txs) {
      const ret = object(tx.transaction)?.ret
      const status = Array.isArray(ret) ? object(ret[0])?.contractRet : undefined
      if (typeof status === 'string' && status !== 'SUCCESS') {
        this.write(
          'WARN',
          `Transaction failed txid=${tx.txid} reason=${failureCode(status) ?? 'Execution failed'}`,
        )
      }
    }
  }

  dropped(txid: string, error: unknown): void {
    this.write('WARN', `Transaction dropped txid=${txid} reason=${failureReason(error)}`)
  }

  intervalFailure(): void {
    this.write('ERROR', 'Interval mining failed', true)
  }
}
