import { requireInteger } from './validation.ts'

/**
 * Injectable clock: the core never calls Date.now() directly, so tests can
 * pin or fast-forward time deterministically (dev-node requirement).
 */
export class Clock {
  private readonly source: () => number
  private offsetMs: number

  constructor(source: () => number = () => Date.now()) {
    this.source = source
    this.offsetMs = 0
  }

  nowMs(): number {
    const source = this.source()
    requireInteger(source, 'clock source')
    const now = source + this.offsetMs
    requireInteger(now, 'clock time')
    return now
  }

  advanceMs(ms: number): void {
    requireInteger(ms, 'time increase')
    requireInteger(this.nowMs() + ms, 'clock time')
    const nextOffset = this.offsetMs + ms
    requireInteger(nextOffset, 'clock offset')
    this.offsetMs = nextOffset
  }

  snapshot(): number {
    return this.offsetMs
  }

  restore(offsetMs: number): void {
    requireInteger(offsetMs, 'clock offset')
    this.offsetMs = offsetMs
  }
}
