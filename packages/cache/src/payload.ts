/**
 * How values are written to a driver that only holds text.
 *
 * JSON, not a binary format: it stays readable in `redis-cli` and in the cache
 * table, and every runtime this framework targets can parse it. The trade is
 * real and documented — a `Date` comes back as an ISO string, and a `Map` or a
 * class instance loses its identity. Values that must survive intact should be
 * cached as plain data.
 */
export function encode(value: unknown): string {
  // `JSON.stringify(undefined)` is `undefined`, not a string. Both null and
  // undefined already mean "not cached" at the Repository level.
  return value === undefined ? 'null' : JSON.stringify(value)
}

export function decode<T = unknown>(text: string | null): T | null {
  if (text === null) return null

  try {
    return JSON.parse(text) as T
  } catch {
    // A truncated or hand-edited entry is a miss, not a crash.
    return null
  }
}

/** Seconds until `expiresAt`, floored at zero. */
export function secondsUntil(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
}

/**
 * A UNIX timestamp for `seconds` from now, where `0` means forever.
 *
 * Forever is `9999999999` — the same sentinel Laravel writes, so a payload stays
 * comparable with a plain integer compare and never needs a special case.
 */
export const FOREVER = 9_999_999_999

export function expiresAt(seconds: number): number {
  if (seconds <= 0) return FOREVER

  const at = Math.floor(Date.now() / 1000) + seconds

  return at > FOREVER ? FOREVER : at
}
