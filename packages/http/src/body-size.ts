import { HttpException } from '@elvel/core'
import { Elysia } from 'elysia'

export class PayloadTooLargeError extends HttpException {
  constructor(
    readonly limit: number,
    readonly declared?: number
  ) {
    super(
      413,
      declared === undefined
        ? `The request body is larger than the ${limit} bytes this route accepts.`
        : `The request declares ${declared} bytes and this route accepts ${limit}.`
    )
    this.name = 'PayloadTooLargeError'
  }
}

export type BodySizeOptions = {
  /** Bytes. `0` turns the check off. */
  max: number
  /** Paths that may exceed it — an upload endpoint. A trailing `*` is a prefix. */
  except?: readonly string[]
}

/**
 * Refuse a body whose declared length is over the limit.
 *
 * `maxRequestBodySize` on the server refuses the same thing earlier, and
 * `listen()` sets it from the same config. This exists for the two things it
 * cannot do: render the application's own `413` rather than Bun's, and hold a
 * **lower** limit on one path than the server's — a JSON endpoint behind a
 * server configured for uploads.
 *
 * The socket limit already covers a chunked body: Bun refuses it the moment a
 * handler reads past the limit. This adds the declared case, earlier and with
 * the application's own message.
 *
 * Counting a chunked body here was tried and removed. A stream put on
 * `request.body` is not what `request.text()` reads, so Elysia parsed the
 * original and answered `Bad Request` for every streamed body, over the limit
 * or under it.
 */
export function bodySizePlugin(options: BodySizeOptions) {
  const { max, except = [] } = options

  return new Elysia({ name: 'elvel:body-size' }).onRequest(async ({ request }) => {
    if (max <= 0) return
    if (!mayCarryBody(request.method)) return
    if (exempt(new URL(request.url).pathname, except)) return

    const declared = request.headers.get('content-length')

    if (declared !== null) {
      const length = Number(declared)

      // A declared length is the cheap check and the common case: refused
      // before a single byte of the body is read.
      if (Number.isFinite(length) && length > max) throw new PayloadTooLargeError(max, length)

      return
    }

    // No declared length means chunked, and nothing here can measure it: a
    // stream put on `request.body` is not what `request.text()` reads, so
    // Elysia parsed the original and answered `Bad Request` for every streamed
    // body, over the limit or under it. Tried, measured, removed — and not
    // needed, because the socket limit refuses one as the handler reads it.
  })
}

/** GET and HEAD carry no body worth measuring. */
function mayCarryBody(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

function exempt(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern
  )
}
