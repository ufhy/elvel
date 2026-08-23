import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { staticPlugin } from '@elysiajs/static'
import { Elysia } from 'elysia'
import { compressedAssets } from '../src/compression.ts'

/**
 * `@elysiajs/static` serves the bytes on disk and ignores `accept-encoding`.
 *
 * Measured on a built application: a page transferred 150 kB where 42 kB would
 * have done — four fifths of a first visit, and more than ten times the largest
 * difference any architectural choice made in the same measurements. These tests
 * exist because the fix has to sit in an unusual place to work at all.
 */
const root = mkdtempSync(join(tmpdir(), 'elvel-compression-'))

/** Compresses well and is comfortably over the threshold. */
const script = `// build output\n${'export const value = 1;\n'.repeat(500)}`

writeFileSync(join(root, 'app.js'), script)
writeFileSync(join(root, 'tiny.js'), 'export const a = 1\n')
writeFileSync(join(root, 'logo.png'), Buffer.alloc(4096, 7))
writeFileSync(join(root, 'secret.env'), 'APP_KEY=do-not-serve\n')

// A build directory, where every name carries a hash of its contents.
mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'app.js'), script)
writeFileSync(join(root, 'build', 'logo.png'), Buffer.alloc(4096, 7))

const server = async (options?: {
  prefix?: string
  cache?: boolean
  hashedPrefix?: string
  headers?: (request: Request) => Record<string, string>
}) =>
  new Elysia()
    .use(
      compressedAssets({
        root,
        prefix: options?.prefix ?? '/',
        directive: 'public',
        maxAge: 86_400,
        hashedPrefix: options?.hashedPrefix,
        cache: options?.cache ?? false,
        headers: options?.headers
      })
    )
    .use(await staticPlugin({ assets: root, prefix: options?.prefix ?? '/', indexHTML: false }))

const get = (app: Elysia, path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://localhost${path}`, { headers }))

describe('compressed static assets', () => {
  test('a script a caller can decompress arrives compressed', async () => {
    const response = await get(await server(), '/app.js', {
      'accept-encoding': 'gzip, deflate, br'
    })
    const body = await response.arrayBuffer()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(body.byteLength).toBeLessThan(Buffer.byteLength(script) / 4)

    // The bytes have to be the file, not merely smaller than it.
    expect(Bun.gunzipSync(new Uint8Array(body))).toEqual(new Uint8Array(Buffer.from(script)))
  })

  /**
   * Without `Vary`, a shared cache can hand compressed bytes to a client that
   * never asked for them and cannot read them.
   */
  test('the response tells caches what it varies on', async () => {
    const response = await get(await server(), '/app.js', { 'accept-encoding': 'gzip' })

    expect(response.headers.get('vary')).toBe('Accept-Encoding')
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
  })

  test('a caller that did not ask for gzip gets the file', async () => {
    const response = await get(await server(), '/app.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.text()).toBe(script)
  })

  /**
   * Two ways of coming out no smaller, both of which must fall through.
   *
   * gzip adds framing, so a file below one packet can grow; a `.png` is already
   * compressed and would grow too — except it never reaches the compressor,
   * because its extension is not on the list.
   */
  test('what compression cannot help is left alone', async () => {
    const tiny = await get(await server(), '/tiny.js', { 'accept-encoding': 'gzip' })
    const image = await get(await server(), '/logo.png', { 'accept-encoding': 'gzip' })

    expect(tiny.headers.get('content-encoding')).toBeNull()
    expect(image.headers.get('content-encoding')).toBeNull()
    expect(image.status).toBe(200)
  })

  /**
   * The reason the resolved path is compared with the resolved root.
   *
   * `%2e%2e%2f` is `../` after `decodeURIComponent`, and a path assembled by
   * concatenation would walk straight out of `public/`. Every one of these must
   * fail to produce a compressed body — whatever the static plugin then answers
   * with is its own business, but it must not be a file from outside the root.
   */
  test('a path cannot climb out of the served directory', async () => {
    const app = await server()

    for (const attempt of [
      '/../secret.env',
      '/%2e%2e%2fsecret.env',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/..%2f..%2fpackage.json',
      '/subdir/../../secret.env'
    ]) {
      const response = await get(app, attempt, { 'accept-encoding': 'gzip' })

      expect<string>(`${attempt}: ${response.headers.get('content-encoding')}`).toBe(
        `${attempt}: null`
      )
    }
  })

  test('a request outside the prefix is not touched', async () => {
    const app = await server({ prefix: '/static' })

    const outside = await get(app, '/app.js', { 'accept-encoding': 'gzip' })
    const inside = await get(app, '/static/app.js', { 'accept-encoding': 'gzip' })

    expect(outside.headers.get('content-encoding')).toBeNull()
    expect(inside.headers.get('content-encoding')).toBe('gzip')
  })

  /**
   * A cached entry has to be the same bytes, not a stale hit under a reused name.
   *
   * The key carries size and mtime precisely so that a file replaced in place —
   * which is development, not production — cannot be served from the old entry.
   */
  test('caching serves the current file, not the one it replaced', async () => {
    const app = await server({ cache: true })
    const path = join(root, 'swapped.js')

    writeFileSync(path, `// first\n${'export const first = 1;\n'.repeat(500)}`)

    const before = await get(app, '/swapped.js', { 'accept-encoding': 'gzip' })
    const first = Bun.gunzipSync(new Uint8Array(await before.arrayBuffer()))

    const second = `// second\n${'export const second = 2;\n'.repeat(500)}`

    writeFileSync(path, second)

    const after = await get(app, '/swapped.js', { 'accept-encoding': 'gzip' })
    const latest = Bun.gunzipSync(new Uint8Array(await after.arrayBuffer()))

    expect(Buffer.from(first).toString()).toContain('first')
    expect(Buffer.from(latest).toString()).toBe(second)
  })

  /**
   * A validator, and a 304 when the caller already has the bytes.
   *
   * Measured before this existed: a conditional request for an 81 kB script came
   * back 200 with all 31 kB of it, every time. The tag also has to differ from
   * the one the static plugin puts on the *uncompressed* file — they are two
   * representations, and one tag for both lets a cache hand gzipped bytes to a
   * caller that asked for none.
   */
  test('a revalidation is answered with 304 and no body', async () => {
    const app = await server()

    const first = await get(app, '/app.js', { 'accept-encoding': 'gzip' })
    const etag = first.headers.get('etag')

    expect(etag).toBeTruthy()
    expect(etag).toContain('gzip')

    const again = await get(app, '/app.js', {
      'accept-encoding': 'gzip',
      'if-none-match': etag ?? ''
    })

    expect(again.status).toBe(304)
    expect((await again.arrayBuffer()).byteLength).toBe(0)

    // A 304 still has to carry what a cache needs to keep the entry usable.
    expect(again.headers.get('etag')).toBe(etag)
    expect(again.headers.get('vary')).toBe('Accept-Encoding')
    expect(again.headers.get('cache-control')).toBe('public, max-age=86400')
  })

  test('a stale validator gets the file, not a 304', async () => {
    const app = await server()

    const response = await get(app, '/app.js', {
      'accept-encoding': 'gzip',
      'if-none-match': 'W/"something-else-gzip"'
    })

    expect(response.status).toBe(200)
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  /**
   * A hashed name cannot go stale, so `no-cache` there protects nothing.
   *
   * Vite writes the content's hash into the filename: change the file and the URL
   * changes with it. Treating those like the rest of `public/` — where a name
   * outlives its contents — cost a re-download of every asset on every
   * navigation in development, measured at 3,825 B for one stylesheet, every
   * time, for bytes the browser already had.
   */
  describe('caching what carries its own version', () => {
    const hashed = { hashedPrefix: '/build/', prefix: '/' }

    test('a file under the build prefix is cached for a year', async () => {
      const app = await server(hashed)
      const response = await get(app, '/build/app.js', { 'accept-encoding': 'gzip' })

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    })

    /**
     * Not only the compressed ones.
     *
     * An image or a font under the same prefix is just as unable to go stale, and
     * would otherwise fall through to the static plugin and be told `no-cache`.
     */
    test('an image under the prefix is cached too, uncompressed', async () => {
      const app = await server(hashed)
      const response = await get(app, '/build/logo.png', { 'accept-encoding': 'gzip' })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect((await response.arrayBuffer()).byteLength).toBe(4096)
    })

    test('a caller that already has it gets a 304', async () => {
      const app = await server(hashed)
      const first = await get(app, '/build/logo.png')
      const etag = first.headers.get('etag')

      expect(etag).toBeTruthy()

      const again = await get(app, '/build/logo.png', { 'if-none-match': etag ?? '' })

      expect(again.status).toBe(304)
      expect((await again.arrayBuffer()).byteLength).toBe(0)
    })

    /** Outside the prefix, the environment still decides. */
    test('the rest of public keeps the environment directive', async () => {
      const app = await server(hashed)
      const response = await get(app, '/app.js', { 'accept-encoding': 'gzip' })

      expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
    })

    /** A range request is the static plugin's job, and stays there. */
    test('a range request is left alone', async () => {
      const app = await server(hashed)
      const response = await get(app, '/build/app.js', {
        'accept-encoding': 'gzip',
        range: 'bytes=0-99'
      })

      expect(response.headers.get('cache-control')).not.toBe('public, max-age=31536000, immutable')
    })
  })

  test('a HEAD request answers the headers without the body', async () => {
    const response = await (await server()).handle(
      new Request('http://localhost/app.js', {
        method: 'HEAD',
        headers: { 'accept-encoding': 'gzip' }
      })
    )

    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })
})

/**
 * A static file could not be given a header, and that was the hole.
 *
 * The static plugin's routes skip the surrounding lifecycle — measured in both
 * `alwaysStatic` modes — so a security header set globally never reached a served
 * file. Everything this plugin can resolve is answered here now, which is what
 * makes the header possible at all.
 */
describe('headers a static file could not otherwise carry', () => {
  const policy = () => ({ 'content-security-policy': "default-src 'self'" })

  test('on a compressed response', async () => {
    const app = await server({ headers: policy })
    const response = await get(app, '/app.js', { 'accept-encoding': 'gzip' })

    expect<string | null>(response.headers.get('content-encoding')).toBe('gzip')
    expect<string | null>(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'"
    )
  })

  /**
   * And on the file that used to fall through.
   *
   * A `.png` is not compressible and carries no hash, so the plugin declined it
   * and the static plugin answered — with no policy, and no way to add one.
   */
  test('on an image, which nothing could reach before', async () => {
    const app = await server({ headers: policy })
    const response = await get(app, '/logo.png')

    expect<number>(response.status).toBe(200)
    expect<string | null>(response.headers.get('content-type')).toBe('image/png')
    expect<string | null>(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'"
    )
  })

  test('on a file too small to be worth compressing', async () => {
    const app = await server({ headers: policy })
    const response = await get(app, '/tiny.js', { 'accept-encoding': 'gzip' })

    expect<string | null>(response.headers.get('content-encoding')).toBeNull()
    expect<string | null>(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'"
    )
  })

  test('and on a caller that never asked for gzip', async () => {
    const app = await server({ headers: policy })
    const response = await get(app, '/app.js')

    expect<string | null>(response.headers.get('content-encoding')).toBeNull()
    expect<string | null>(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'"
    )
  })

  /**
   * The nonce in the policy is this response's, so it is read per request.
   *
   * A policy computed once at boot would name a nonce no page carries.
   */
  test('the headers are asked for per request', async () => {
    let asked = 0
    const app = await server({
      headers: () => {
        asked += 1

        return { 'x-asked': String(asked) }
      }
    })

    expect<string | null>((await get(app, '/logo.png')).headers.get('x-asked')).toBe('1')
    expect<string | null>((await get(app, '/logo.png')).headers.get('x-asked')).toBe('2')
  })
})

/**
 * Answering everything it resolves brought conditional requests with it.
 *
 * `@elysiajs/static` sets an `ETag` and then ignores `If-None-Match`: measured on
 * a built application, a conditional request for an 81 kB script came back **200
 * with all 81,048 bytes**, every time.
 */
describe('revalidating a file that is not compressed', () => {
  test('an image answers 304 with no body', async () => {
    const app = await server()
    const first = await get(app, '/logo.png')
    const etag = first.headers.get('etag') ?? ''

    expect<boolean>(etag.length > 0).toBe(true)

    const second = await get(app, '/logo.png', { 'if-none-match': etag })

    expect<number>(second.status).toBe(304)
    expect<number>((await second.arrayBuffer()).byteLength).toBe(0)
  })

  /**
   * A path with no extension is not stat'd at all.
   *
   * Every address a client router owns arrives here — `/dashboard`, `/invoices/9`
   * — and none of them is a file. Asking the filesystem about each one is a
   * syscall per page view for an answer that is always no.
   */
  test('a path with no extension is left alone', async () => {
    let asked = 0
    const app = await server({
      headers: () => {
        asked += 1

        return {}
      }
    })

    const response = await get(app, '/dashboard')

    expect<number>(response.status).toBe(404)
    expect<number>(asked).toBe(0)
  })

  /** The traversal guard still refuses, and still refuses first. */
  test('a file outside the root is refused', async () => {
    const app = await server({ headers: () => ({ 'x-seen': 'yes' }) })
    const response = await get(app, '/%2e%2e%2fsecret.env')

    expect<boolean>(response.status === 200).toBe(false)
  })
})
