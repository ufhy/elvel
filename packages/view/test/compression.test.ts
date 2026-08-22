import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

const server = async (options?: { prefix?: string; cache?: boolean }) =>
  new Elysia()
    .use(
      compressedAssets({
        root,
        prefix: options?.prefix ?? '/',
        directive: 'public',
        maxAge: 86_400,
        cache: options?.cache ?? false
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
