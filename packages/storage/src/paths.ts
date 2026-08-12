import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

/** Thrown when a path tries to leave the disk it belongs to. */
export class PathOutsideDiskError extends Error {
  constructor(path: string) {
    super(
      `Path [${path}] leaves the disk's root. A path is always relative to the disk, and traversal is refused rather than resolved.`
    )
    this.name = 'PathOutsideDiskError'
  }
}

/**
 * The relative path a disk should use, or an error.
 *
 * Refused rather than normalised, and deliberately so. Flysystem does this for
 * Laravel; without it a path that came from a request — `../../.env`, or an
 * absolute `/etc/passwd` — would be read or written outside the disk. Stripping
 * the `..` segments instead would silently turn a hostile path into a valid one,
 * which is worse than an error: the caller never learns their input was wrong.
 */
export function normalisePath(path: string): string {
  const trimmed = path.replaceAll('\\', '/').replace(/^\.\//, '').trim()

  if (trimmed === '' || trimmed === '.') return ''

  if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) throw new PathOutsideDiskError(path)

  // A NUL byte truncates a filename in some syscalls, so a path containing one
  // cannot be trusted to mean what it reads as.
  if (trimmed.includes('\0')) throw new PathOutsideDiskError(path)

  const normalised = normalize(trimmed)

  if (normalised === '..' || normalised.startsWith(`..${sep}`) || normalised.startsWith('../')) {
    throw new PathOutsideDiskError(path)
  }

  return normalised.replaceAll(sep, '/')
}

/**
 * Join a disk root and a relative path, checking the result really is inside.
 *
 * The second check is not redundant: a symlink inside the root can point out of
 * it, and a root that is itself a relative path has to be resolved before the
 * comparison means anything.
 */
export function withinRoot(root: string, path: string): string {
  const absoluteRoot = resolve(root)
  const target = resolve(join(absoluteRoot, normalisePath(path)))

  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + sep)) {
    throw new PathOutsideDiskError(path)
  }

  return target
}

/** A name that will not collide, keeping the original extension. */
export function randomFilename(original?: string): string {
  const extension = original?.includes('.') ? original.slice(original.lastIndexOf('.')) : ''

  return `${crypto.randomUUID().replaceAll('-', '')}${extension}`
}

/** Guess a content type from the extension, for drivers that store one. */
export function guessContentType(path: string): string | undefined {
  const types: Record<string, string> = {
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    xml: 'application/xml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    zip: 'application/zip',
    gz: 'application/gzip',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg'
  }

  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''

  return types[extension]
}
