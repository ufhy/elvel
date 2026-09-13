import type { Disk } from './contracts.ts'
import { guessContentType } from './paths.ts'

/**
 * `Content-Disposition`, with a filename that survives a non-ASCII name.
 *
 * The plain `filename` is stripped to ASCII for old clients, and `filename*`
 * carries the real one — RFC 6266. Quotes and backslashes are removed rather than
 * escaped: a filename that closes the quoted string early can inject a header
 * parameter of its own.
 */
export function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const safe = filename.replaceAll(/["\\\r\n]/g, '').replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(filename)

  return `${disposition}; filename="${safe}"; filename*=UTF-8''${encoded}`
}

/**
 * Stream a file from a disk as a `Response`.
 *
 * Streamed rather than read into memory: a download of a large file should not
 * cost the process the size of the file.
 */
export async function fileResponse(
  disk: Disk,
  path: string,
  options: {
    name?: string
    disposition?: 'inline' | 'attachment'
    headers?: Record<string, string>
    /** The request, when the caller wants `Range` honoured. */
    request?: Request
  } = {}
): Promise<Response | null> {
  const stream = await disk.readStream(path)
  if (!stream) return null

  const name = options.name ?? path.split('/').pop() ?? 'download'
  const size = await disk.size(path)

  const headers: Record<string, string> = {
    'content-type':
      (await disk.mimeType(path)) ?? guessContentType(path) ?? 'application/octet-stream',
    'content-disposition': contentDisposition(options.disposition ?? 'inline', name),
    // Advertised always: a client that does not know it may ask will not ask, so
    // a video served without this can never be seeked.
    'accept-ranges': 'bytes',
    ...options.headers
  }

  if (size !== null) headers['content-length'] = String(size)

  const asked = options.request?.headers.get('range') ?? null

  if (asked === null || size === null) return new Response(stream, { headers })

  const range = parseRange(asked, size)

  if (range === 'unsatisfiable') {
    // The stream is opened before the range is known; an unread one holds a file
    // handle until it is collected.
    await stream.cancel().catch(() => {})

    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' }
    })
  }

  if (range === undefined) return new Response(stream, { headers })

  await stream.cancel().catch(() => {})

  const [start, end] = range
  const slice = await disk.readRange(path, start, end)

  if (slice === null) return new Response(null, { status: 416 })

  return new Response(slice, {
    status: 206,
    headers: {
      ...headers,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`
    }
  })
}

/**
 * One byte range, or nothing.
 *
 * Only a single range: a multipart `206` is a `multipart/byteranges` body, and
 * no client that matters sends more than one — a browser seeking a video sends
 * `bytes=1000-`, and a resumed download sends `bytes=<n>-`. A header asking for
 * several is served whole, which is allowed and is what every server does.
 */
export function parseRange(
  header: string,
  size: number
): [number, number] | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())

  if (match === null) return undefined

  const [, from, to] = match

  // `bytes=-500` is the *last* 500 bytes, not "from the start to 500".
  if (from === '') {
    const length = Number(to)

    if (!Number.isFinite(length) || length <= 0) return 'unsatisfiable'

    return [Math.max(0, size - length), size - 1]
  }

  const start = Number(from)

  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'

  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)

  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'

  return [start, end]
}

/** The same, as an attachment. */
export function download(
  disk: Disk,
  path: string,
  name?: string,
  headers?: Record<string, string>
): Promise<Response | null> {
  return fileResponse(disk, path, { name, disposition: 'attachment', headers })
}
