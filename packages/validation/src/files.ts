/**
 * What an upload is, in this runtime.
 *
 * A `multipart/form-data` body parses to web `File` objects — Bun gives us the
 * standard type, so there is no `UploadedFile` wrapper here and no temporary path
 * to clean up. The one thing that has to be said out loud is that `file.type` is
 * what the *client* claimed; see `sniff` below.
 */
export function isFile(value: unknown): value is File {
  return typeof File !== 'undefined' && value instanceof File
}

/** Kilobytes, the unit every file size rule is written in. */
export function kilobytes(file: File): number {
  return file.size / 1024
}

/** The filename's extension, lowercased, or `''`. */
export function extensionOf(file: File): string {
  const dot = file.name.lastIndexOf('.')

  return dot === -1 ? '' : file.name.slice(dot + 1).toLowerCase()
}

/**
 * Extensions the framework knows a media type for.
 *
 * Deliberately short. A long table is a maintenance burden and gives a false
 * sense of coverage; `mimetypes:` takes a media type directly for anything not
 * here, which is the honest escape hatch.
 */
const MEDIA_TYPES: Record<string, string[]> = {
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  bmp: ['image/bmp', 'image/x-ms-bmp'],
  avif: ['image/avif'],
  svg: ['image/svg+xml'],
  ico: ['image/x-icon', 'image/vnd.microsoft.icon'],
  pdf: ['application/pdf'],
  txt: ['text/plain'],
  csv: ['text/csv', 'application/csv'],
  json: ['application/json'],
  xml: ['application/xml', 'text/xml'],
  zip: ['application/zip', 'application/x-zip-compressed'],
  gz: ['application/gzip'],
  mp3: ['audio/mpeg'],
  mp4: ['video/mp4'],
  webm: ['video/webm'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
}

/** The media types an extension may legitimately carry. */
export function mediaTypesFor(extension: string): string[] {
  return MEDIA_TYPES[extension.toLowerCase()] ?? []
}

/** Extensions the framework refuses to accept unless they are asked for by name. */
const EXECUTABLE_EXTENSIONS = new Set([
  'php',
  'php3',
  'php4',
  'php5',
  'php7',
  'php8',
  'phtml',
  'phar',
  'exe',
  'sh',
  'bat',
  'cmd',
  'com',
  'cgi',
  'pl'
])

export function looksExecutable(file: File): boolean {
  return EXECUTABLE_EXTENSIONS.has(extensionOf(file))
}

export type SniffedImage = { type: string; width: number; height: number }

/**
 * Read a file's real type, and an image's real dimensions, from its bytes.
 *
 * `file.type` is a header the client sent; a `.php` renamed to `.png` arrives
 * claiming `image/png` and nothing about the object contradicts it. Laravel
 * guesses the type from content with `finfo` for exactly this reason, so `mimes`
 * and `image` here believe the bytes over the claim whenever the bytes are
 * legible — and only fall back to the claim for formats this cannot read.
 *
 * Only the header is read: 32 bytes is enough for every signature below, and for
 * every dimension except WebP's, which needs 30.
 */
export async function sniff(file: File): Promise<SniffedImage | undefined> {
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer())

  if (starts(header, [0x89, 0x50, 0x4e, 0x47])) return png(header)
  if (starts(header, [0xff, 0xd8, 0xff])) return jpeg(file)
  if (starts(header, [0x47, 0x49, 0x46])) return gif(header)
  if (starts(header, [0x42, 0x4d])) return bmp(header)
  if (starts(header, [0x52, 0x49, 0x46, 0x46]) && starts(header.slice(8), [0x57, 0x45, 0x42, 0x50]))
    return webp(header)

  return undefined
}

function starts(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function png(header: Uint8Array): SniffedImage {
  // IHDR is always the first chunk: width and height are big-endian at 16 and 20.
  const data = view(header)

  return { type: 'image/png', width: data.getUint32(16), height: data.getUint32(20) }
}

function gif(header: Uint8Array): SniffedImage {
  const data = view(header)

  // Little-endian, right after the six-byte signature.
  return { type: 'image/gif', width: data.getUint16(6, true), height: data.getUint16(8, true) }
}

function bmp(header: Uint8Array): SniffedImage {
  const data = view(header)

  return { type: 'image/bmp', width: data.getUint32(18, true), height: data.getUint32(22, true) }
}

function webp(header: Uint8Array): SniffedImage {
  const data = view(header)
  const format = String.fromCharCode(...header.slice(12, 16))

  // Only the lossy form ("VP8 ") keeps its size where a fixed offset can find it;
  // the others are reported as an image with no dimensions rather than guessed at.
  if (format === 'VP8 ') {
    return {
      type: 'image/webp',
      width: data.getUint16(26, true) & 0x3fff,
      height: data.getUint16(28, true) & 0x3fff
    }
  }

  return { type: 'image/webp', width: 0, height: 0 }
}

/**
 * JPEG keeps its size in a start-of-frame marker, which can be anywhere.
 *
 * So this walks the segment chain rather than reading a fixed offset — a comment
 * or an EXIF block before the frame is normal, and assuming otherwise reads the
 * wrong two numbers rather than failing.
 */
async function jpeg(file: File): Promise<SniffedImage> {
  // 64KB covers the EXIF block of a photograph from a phone.
  const bytes = new Uint8Array(await file.slice(0, 65_536).arrayBuffer())
  const data = view(bytes)

  let offset = 2

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }

    const marker = bytes[offset + 1] as number

    // SOF0..SOF15, excluding the four that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        type: 'image/jpeg',
        height: data.getUint16(offset + 5),
        width: data.getUint16(offset + 7)
      }
    }

    offset += 2 + data.getUint16(offset + 2)
  }

  return { type: 'image/jpeg', width: 0, height: 0 }
}
