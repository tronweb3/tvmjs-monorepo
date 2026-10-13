/** Numeric bounds for development block production and the injectable clock. */
export function requireInteger(
  value: number,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (typeof value !== 'number') throw new TypeError(`${label} must be a number`)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be a safe integer between ${min} and ${max}`)
  }
}

export const MAX_MINE_BLOCKS = 100
export const MAX_BLOCK_TIME_SECONDS = 60
