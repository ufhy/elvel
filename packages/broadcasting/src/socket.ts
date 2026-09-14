import { requestSlot } from '@elvel/core'

/**
 * The socket that caused the request being handled.
 *
 * `toOthers()` is the first thing everybody reaches for and the loop had no
 * ends: the server never told a socket its id, and nothing read one back. So
 * the client that posted the message received its own broadcast and rendered it
 * twice — the first bug everybody writes.
 *
 * Request-scoped, because it belongs to the request the browser sent while
 * holding that socket, not to the process.
 */
const slot = requestSlot<string>('broadcasting.socket')

/** The header a client echoes its id back on. */
export const SOCKET_HEADER = 'x-socket-id'

/** Set for this request. Called by the plugin from a synchronous hook. */
export function enterSocket(id: string): void {
  slot.set(id)
}

/** The socket id this request carried, if any. */
export function currentSocket(): string | undefined {
  return slot.get()
}

/**
 * Run `body` as though a socket had sent the request.
 *
 * For a test, and for a command that wants a broadcast to skip somebody.
 */
export function withSocket<T>(id: string, body: () => T): T {
  return slot.run(id, body)
}
