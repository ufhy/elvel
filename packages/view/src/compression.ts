import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Elysia } from 'elysia'

/**
 * Compression for the files `public/` serves.
 *
 * `@elysiajs/static` answers with the bytes on disk and ignores
 * `accept-encoding` — measured on a built application, a page asked for 150 kB
 * and would have taken 42 kB compressed. That is 80–90% of what a first visit
 * transfers, and it dwarfs any difference between the ways an application can be
 * written: the largest architectural gap measured in the same session was 5 kB.
 *
 * This cannot be an `onAfterHandle`. The static plugin's routes do not run the
 * surrounding lifecycle — measured, in both `alwaysStatic` modes: the hook never
 * fired. `onRequest` does run first, and returning a `Response` from it answers
 * the request outright, so compression sits *in front of* the plugin and hands
 * everything it does not want back to it untouched.
 *
 * Only files are compressed here, never a rendered page. A response that mixes a
 * secret with something the caller controls — a CSRF token beside a reflected
 * search term — is what makes compressing dynamic HTML a subtle question, and
 * nothing on the static path has that shape. The measured waste was all in
 * `.js` and `.css` anyway.
 */

/** Types worth compressing. Everything else is already compressed or too small. */
const COMPRESSIBLE = new Set([
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.map',
  '.svg',
  '.txt',
  '.xml',
  '.html',
  '.wasm'
])

export type CompressedAssetsOptions = {
  /** The directory the static plugin serves. */
  root: string

  /** The prefix it serves under, so a request outside it is left alone. */
  prefix: string

  /** `Cache-Control` directive, kept the same as the static plugin's. */
  directive: string

  /**
   * Where the build writes, e.g. `/build/`. Everything under it is cached hard.
   *
   * Vite puts a hash of the content in the filename, so a file under this prefix
   * cannot go stale: change the content and the name changes with it. That makes
   * `no-cache` there protect nothing and cost everything — measured in
   * development, every navigation re-downloaded the same 32 kB script because the
   * whole of `public/` was treated as if its names could be reused.
   *
   * The rest of `public/` is a different matter: `favicon.svg`, an image, a
   * `robots.txt` all keep their names when their contents change, so they keep
   * the environment's directive.
   */
  hashedPrefix?: string

  /** `max-age`, in seconds. */
  maxAge: number

  /**
   * Below this, compression costs more than it saves.
   *
   * A response smaller than a network packet arrives in one either way, and gzip
   * adds 18 bytes of framing — so tiny files can come out *larger*.
   */
  minimumBytes?: number

  /**
   * Keep compressed bytes in memory.
   *
   * Vite writes content-hashed filenames, so a path identifies its content for
   * as long as the build lives and the entry can never go stale. Off in
   * development, where a file changes under a name that does not.
   */
  cache: boolean
}

/**
 * `Uint8Array<ArrayBuffer>`, not the default `ArrayBufferLike`.
 *
 * A view over a `SharedArrayBuffer` is not a valid response body, and TypeScript
 * is right to refuse it. `Bun.gzipSync` never returns one, so the narrowing below
 * is a statement of that fact rather than a cast that hides a risk.
 */
type Entry = { bytes: Uint8Array<ArrayBuffer>; type: string; etag: string }

/**
 * Resolve a request path to a file inside the root, or nothing.
 *
 * The `startsWith` check is the whole point: `%2e%2e%2f` decodes to `../` after
 * `decodeURIComponent`, and a path built by concatenation would happily walk out
 * of `public/` and serve `.env`. Comparing the *resolved* path against the
 * resolved root is what makes that impossible rather than merely unlikely.
 */
function fileFor(pathname: string, prefix: string, root: string): string | undefined {
  const relative = pathname.slice(prefix.length)

  let decoded: string

  try {
    decoded = decodeURIComponent(relative)
  } catch {
    // A malformed escape is not a path. Let the static plugin answer it.
    return undefined
  }

  if (decoded.includes('\0')) return undefined

  const base = resolve(root)
  const candidate = resolve(join(base, normalize(decoded)))

  if (candidate !== base && !candidate.startsWith(base + sep)) return undefined
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined

  return candidate
}

/** Does the caller accept gzip? `identity;q=0` and friends are not parsed here. */
function acceptsGzip(header: string | null): boolean {
  return header?.toLowerCase().includes('gzip') ?? false
}

/**
 * A plugin that answers compressible static files with compressed bytes.
 *
 * Mount it **before** the static plugin. Anything it declines — an unknown
 * extension, a caller that did not ask for gzip, a file that came out no smaller
 * — falls through, so the static plugin remains the one implementation of range
 * requests, 404s and everything else it already does well.
 */
export function compressedAssets(options: CompressedAssetsOptions) {
  const prefix = options.prefix.endsWith('/') ? options.prefix : `${options.prefix}/`
  const minimum = options.minimumBytes ?? 1024
  const cached = new Map<string, Entry>()

  const hashed = options.hashedPrefix

  /**
   * A year, and `immutable`, for a name that carries its own version.
   *
   * `immutable` is the half that matters in a browser: without it a reload
   * revalidates every asset even inside `max-age`, which is a round trip per file
   * for an answer that cannot have changed.
   */
  const IMMUTABLE = 'public, max-age=31536000, immutable'

  return new Elysia({ name: 'elvel:compressed-assets' }).onRequest(({ request }) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return

    const { pathname } = new URL(request.url)

    if (!pathname.startsWith(prefix)) return

    /**
     * Ranges are left to the static plugin, which already implements them.
     *
     * A partial response has to agree with what was asked for, and answering one
     * from a compressed buffer — or with a whole file — is worse than not
     * answering it here at all.
     */
    if (request.headers.get('range') !== null) return

    const underHash = hashed !== undefined && pathname.startsWith(hashed)
    const compressible = COMPRESSIBLE.has(extname(pathname).toLowerCase())
    const wantsGzip = acceptsGzip(request.headers.get('accept-encoding'))

    // Nothing to add: not a hashed asset, and not something to compress.
    if (!underHash && !(compressible && wantsGzip)) return

    const path = fileFor(pathname, prefix, options.root)

    if (path === undefined) return

    const stats = statSync(path)
    const cacheControl = underHash ? IMMUTABLE : `${options.directive}, max-age=${options.maxAge}`

    /**
     * A hashed file that will not be compressed still gets the header it needs.
     *
     * An image, a font, a caller that sent no `accept-encoding` — all of them
     * would otherwise fall through to the static plugin and be told `no-cache` in
     * development, which is the whole complaint.
     */
    if (!wantsGzip || !compressible || stats.size < minimum) {
      if (!underHash) return

      const etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`
      const headers: Record<string, string> = {
        'content-type': Bun.file(path).type,
        etag,
        'cache-control': cacheControl
      }

      const presented = request.headers.get('if-none-match')

      if (presented?.split(',').some((tag) => tag.trim() === etag)) {
        return new Response(null, { status: 304, headers })
      }

      return new Response(request.method === 'HEAD' ? null : Bun.file(path), { headers })
    }

    /** The cache key carries the file's identity, not just its name. */
    const key = `${path}:${stats.size}:${stats.mtimeMs}`
    const hit = options.cache ? cached.get(key) : undefined

    const entry =
      hit ??
      (() => {
        const compressed = Bun.gzipSync(readFileSync(path))
        const bytes = new Uint8Array(
          compressed.buffer as ArrayBuffer,
          compressed.byteOffset,
          compressed.byteLength
        )

        /**
         * A validator of its own, because this is a different representation.
         *
         * The static plugin sets an `ETag` on the file it serves; a compressed
         * response is not that file, so reusing its tag would let a cache answer
         * an `Accept-Encoding: identity` request with gzipped bytes. Weak, and
         * built from size and mtime rather than a hash of the content: hashing
         * every asset on the first request costs more than a revalidation saves.
         */
        const etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}-gzip"`

        return { bytes, type: Bun.file(path).type, etag }
      })()

    /**
     * A file that does not shrink is served as it is.
     *
     * Already-compressed bytes under a compressible extension — an inlined
     * `.map` of random-looking base64, a `.wasm` a build already packed — come
     * out bigger, and sending more bytes plus a decompression step for both ends
     * is worse than sending the file.
     */
    if (entry.bytes.byteLength >= stats.size) return

    if (options.cache && hit === undefined) cached.set(key, entry)

    const headers: Record<string, string> = {
      'content-type': entry.type,
      'content-encoding': 'gzip',
      etag: entry.etag,
      /**
       * Without this, a shared cache can hand these bytes to a client that
       * never asked for gzip and cannot read them.
       */
      vary: 'Accept-Encoding',
      'cache-control': cacheControl
    }

    /**
     * Answer a revalidation with nothing, which is the point of a validator.
     *
     * Measured before this existed: a conditional request for an 81 kB script
     * came back 200 with all 31 kB of it compressed, every time — a browser
     * revalidating on reload, or after `max-age` ran out, paid full price for a
     * file it already had.
     */
    const presented = request.headers.get('if-none-match')

    if (presented?.split(',').some((tag) => tag.trim() === entry.etag)) {
      return new Response(null, { status: 304, headers })
    }

    return new Response(request.method === 'HEAD' ? null : entry.bytes, {
      headers: {
        ...headers,
        'content-length': String(entry.bytes.byteLength)
      }
    })
  })
}
