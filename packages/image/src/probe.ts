/** What can be learned from an image's first few bytes. */
export type ImageInfo = {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'heic' | 'tiff'
  mimeType: string
  width: number
  height: number
}

const MIME: Record<ImageInfo['format'], string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  tiff: 'image/tiff'
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length))
}

/**
 * Read format and dimensions out of the bytes themselves.
 *
 * No dependency and no driver: every format below states its size in a header,
 * so this is arithmetic on the first few dozen bytes. That matters because it is
 * the half of this package that works everywhere — a machine with no ImageMagick
 * and no `sharp` can still validate an upload's dimensions before deciding to
 * store it, which is the check most applications actually need.
 *
 * The file extension and the `content-type` a client sent are both claims. This
 * is the file.
 */
export function probe(input: Uint8Array | ArrayBuffer): ImageInfo {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const found =
    png(bytes, view) ??
    gif(bytes, view) ??
    bmp(bytes, view) ??
    webp(bytes, view) ??
    riffless(bytes, view) ??
    tiff(bytes, view) ??
    jpeg(bytes, view)

  if (!found) {
    throw new Error(
      'The bytes are not an image this can read. ' +
        'Supported: png, jpeg, gif, webp, bmp, avif, heic, tiff.'
    )
  }

  return { ...found, mimeType: MIME[found.format] }
}

/** `probe()` without the throw, for a caller deciding whether it is an image. */
export function tryProbe(input: Uint8Array | ArrayBuffer): ImageInfo | undefined {
  try {
    return probe(input)
  } catch {
    return undefined
  }
}

type Partial_ = Omit<ImageInfo, 'mimeType'>

function png(bytes: Uint8Array, view: DataView): Partial_ | undefined {
  if (bytes.length < 24) return undefined
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return undefined

  // IHDR is always the first chunk, so width and height sit at a fixed offset.
  return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) }
}

function gif(bytes: Uint8Array, view: DataView): Partial_ | undefined {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'GIF') return undefined

  // Little-endian, unlike PNG — the logical screen descriptor.
  return { format: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

function bmp(bytes: Uint8Array, view: DataView): Partial_ | undefined {
  if (bytes.length < 26 || ascii(bytes, 0, 2) !== 'BM') return undefined

  // Signed: a negative height means the rows are stored top-down.
  return {
    format: 'bmp',
    width: Math.abs(view.getInt32(18, true)),
    height: Math.abs(view.getInt32(22, true))
  }
}

/**
 * WebP, whose three sub-formats state their size differently.
 *
 * `VP8 ` is lossy, `VP8L` lossless, `VP8X` an extended container. Reading only
 * the first would give up on most animated and alpha-bearing files.
 */
function webp(bytes: Uint8Array, view: DataView): Partial_ | undefined {
  if (bytes.length < 16 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return undefined
  }

  const chunk = ascii(bytes, 12, 4)

  /**
   * The length each sub-format needs, not one figure for all three.
   *
   * A blanket minimum of 30 bytes was wrong: a lossless header is 25 bytes, so
   * the smallest legitimate `VP8L` file was reported as "not an image".
   */
  if (chunk === 'VP8X' && bytes.length < 30) return undefined
  if (chunk === 'VP8L' && bytes.length < 25) return undefined
  if (chunk === 'VP8 ' && bytes.length < 30) return undefined

  if (chunk === 'VP8X') {
    // Three bytes each, minus one, little-endian.
    const width =
      1 + (bytes[24] as number) + ((bytes[25] as number) << 8) + ((bytes[26] as number) << 16)
    const height =
      1 + (bytes[27] as number) + ((bytes[28] as number) << 8) + ((bytes[29] as number) << 16)

    return { format: 'webp', width, height }
  }

  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true)

    return { format: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }

  if (chunk === 'VP8 ') {
    return {
      format: 'webp',
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff
    }
  }

  return undefined
}

/**
 * AVIF and HEIC, which share the ISO base media container.
 *
 * The dimensions live in an `ispe` box nested several levels down, so the box
 * tree is walked rather than read at a fixed offset — there is no fixed offset
 * to read.
 */
function riffless(bytes: Uint8Array, view: DataView): Partial_ | undefined {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') return undefined

  const brand = ascii(bytes, 8, 4)
  const format: ImageInfo['format'] | undefined = brand.startsWith('avi')
    ? 'avif'
    : brand.startsWith('hei') || brand.startsWith('mif') || brand.startsWith('msf')
      ? 'heic'
      : undefined

  if (!format) return undefined

  const size = findIspe(bytes, view, 0, bytes.length)
  if (!size) return undefined

  return { format, width: size.width, height: size.height }
}

/** Walk the box tree for the first `ispe`. */
function findIspe(
  bytes: Uint8Array,
  view: DataView,
  from: number,
  to: number
): { width: number; height: number } | undefined {
  let at = from

  while (at + 8 <= to) {
    const size = view.getUint32(at)
    const type = ascii(bytes, at + 4, 4)

    if (type === 'ispe' && at + 20 <= to) {
      // Four bytes of version and flags, then the two dimensions.
      return { width: view.getUint32(at + 12), height: view.getUint32(at + 16) }
    }

    // Containers worth descending into. Anything else is skipped whole, which is
    // what keeps this from walking pixel data byte by byte.
    if (['meta', 'iprp', 'ipco', 'iinf'].includes(type)) {
      const inner = findIspe(bytes, view, at + (type === 'meta' ? 12 : 8), Math.min(at + size, to))
      if (inner) return inner
    }

    // A zero or nonsense size would loop forever.
    if (size < 8) return undefined
    at += size
  }

  return undefined
}

function tiff(bytes: Uint8Array, view: DataView): Partial_ | undefined {
  if (bytes.length < 8) return undefined

  const little = ascii(bytes, 0, 2) === 'II'
  const big = ascii(bytes, 0, 2) === 'MM'
  if (!little && !big) return undefined
  if (view.getUint16(2, little) !== 42) return undefined

  const ifd = view.getUint32(4, little)
  if (ifd + 2 > bytes.length) return undefined

  const count = view.getUint16(ifd, little)
  let width: number | undefined
  let height: number | undefined

  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > bytes.length) break

    const tag = view.getUint16(entry, little)
    const type = view.getUint16(entry + 2, little)
    const value = type === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little)

    if (tag === 0x0100) width = value
    if (tag === 0x0101) height = value
  }

  return width && height ? { format: 'tiff', width, height } : undefined
}

/**
 * JPEG, which requires walking the segments.
 *
 * There is no header field for the size: it is in whichever start-of-frame
 * marker appears, and where that is depends on how much EXIF and how many
 * thumbnails came first. `0xFFC0`–`0xFFCF` are the frame markers, excluding
 * `C4`, `C8` and `CC`, which are tables rather than frames — reading one of
 * those as a frame is the classic way to get nonsense dimensions.
 */
function jpeg(bytes: Uint8Array, view: DataView): Partial_ | undefined {
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return undefined

  let at = 2

  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1
      continue
    }

    const marker = bytes[at + 1] as number

    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (at + 9 > bytes.length) return undefined

      return { format: 'jpeg', height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
    }

    // Markers with no payload; anything else carries a two-byte length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2
      continue
    }

    at += 2 + view.getUint16(at + 2)
  }

  return undefined
}
