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
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  filename: string
): string {
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
    ...options.headers
  }

  if (size !== null) headers['content-length'] = String(size)

  return new Response(stream, { headers })
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
