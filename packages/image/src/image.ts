import { inflateSync } from 'node:zlib'
import { app } from '@elvel/core'
import {
  type Encoding,
  type Fit,
  type ImageDriver,
  ImageError,
  type Transformation
} from './contracts.ts'
import type { ImageDisk } from './manager.ts'
import { type ImageInfo, probe } from './probe.ts'

/**
 * An image and the steps queued against it.
 *
 * Nothing happens until something asks for bytes. That is what lets a chain of
 * six transformations become one call to a backend instead of six, and it is why
 * `width()` and `height()` describe the *source*: the result's dimensions are not
 * known until the work is done, and pretending otherwise would mean running the
 * pipeline behind a getter.
 */
export class Image {
  private readonly steps: Transformation[] = []
  private encoding: Encoding = {}
  private info?: ImageInfo

  constructor(
    private readonly bytes: Uint8Array,
    private readonly driver?: ImageDriver
  ) {}

  // ------------------------------------------------------------- inspection

  /** Format and dimensions of the source, read from its header. */
  probe(): ImageInfo {
    if (!this.info) this.info = probe(this.bytes)

    return this.info
  }

  get width(): number {
    return this.probe().width
  }

  get height(): number {
    return this.probe().height
  }

  get format(): ImageInfo['format'] {
    return this.probe().format
  }

  get mimeType(): string {
    return this.probe().mimeType
  }

  dimensions(): { width: number; height: number } {
    const { width, height } = this.probe()

    return { width, height }
  }

  /** The queued steps, for a caller inspecting what would happen. */
  pending(): Transformation[] {
    return [...this.steps]
  }

  /** The format and quality it would be written with. Beside `pending()`. */
  encodingOptions(): Encoding {
    return { ...this.encoding }
  }

  // ---------------------------------------------------------- transformations

  /** Exact dimensions, ignoring the aspect ratio when both are given. */
  resize(width?: number, height?: number): this {
    if (width === undefined && height === undefined) {
      throw new ImageError('resize() needs a width, a height, or both.')
    }

    this.steps.push({ op: 'resize', width, height })

    return this
  }

  /** Fill the box, losing whatever overflows it. */
  cover(width: number, height: number): this {
    this.steps.push({ op: 'fit', fit: 'cover', width, height })

    return this
  }

  /** Fit inside the box, keeping all of the image. */
  contain(width: number, height: number): this {
    this.steps.push({ op: 'fit', fit: 'contain', width, height })

    return this
  }

  fit(fit: Fit, width: number, height: number): this {
    this.steps.push({ op: 'fit', fit, width, height })

    return this
  }

  scale(factor: number): this {
    if (factor <= 0) throw new ImageError('scale() needs a factor above zero.')

    this.steps.push({ op: 'scale', factor })

    return this
  }

  crop(width: number, height: number, x?: number, y?: number): this {
    this.steps.push({ op: 'crop', width, height, x, y })

    return this
  }

  rotate(degrees: number): this {
    this.steps.push({ op: 'rotate', degrees })

    return this
  }

  flipHorizontally(): this {
    this.steps.push({ op: 'flip', axis: 'horizontal' })

    return this
  }

  flipVertically(): this {
    this.steps.push({ op: 'flip', axis: 'vertical' })

    return this
  }

  grayscale(): this {
    this.steps.push({ op: 'grayscale' })

    return this
  }

  blur(radius = 5): this {
    this.steps.push({ op: 'blur', radius })

    return this
  }

  sharpen(amount = 1): this {
    this.steps.push({ op: 'sharpen', amount })

    return this
  }

  /** Apply the EXIF orientation, so a phone photo is the way up it looked. */
  orient(): this {
    this.steps.push({ op: 'orient' })

    return this
  }

  // -------------------------------------------------------------- encoding

  quality(quality: number): this {
    if (quality < 1 || quality > 100) throw new ImageError('quality() takes 1 to 100.')

    this.encoding = { ...this.encoding, quality }

    return this
  }

  toFormat(format: ImageInfo['format'], quality?: number): this {
    this.encoding = { ...this.encoding, format, ...(quality === undefined ? {} : { quality }) }

    return this
  }

  toPng(): this {
    return this.toFormat('png')
  }
  toJpeg(quality?: number): this {
    return this.toFormat('jpeg', quality)
  }
  toWebp(quality?: number): this {
    return this.toFormat('webp', quality)
  }
  toGif(): this {
    return this.toFormat('gif')
  }
  toAvif(quality?: number): this {
    return this.toFormat('avif', quality)
  }
  toHeic(quality?: number): this {
    return this.toFormat('heic', quality)
  }

  // ---------------------------------------------------------------- output

  /**
   * Do the work.
   *
   * With nothing queued and no format change this hands back the original bytes
   * untouched, rather than round-tripping them through a backend — a re-encode
   * that changes nothing still loses quality on a lossy format.
   */
  async toBytes(): Promise<Uint8Array> {
    if (
      this.steps.length === 0 &&
      this.encoding.format === undefined &&
      this.encoding.quality === undefined
    ) {
      return this.bytes
    }

    if (!this.driver) {
      throw new ImageError(
        'Transforming an image needs a driver. None is available: install "sharp", ' +
          'install ImageMagick, or run on macOS where sips is built in. ' +
          'Reading dimensions and format needs no driver and still works.'
      )
    }

    const unsupported = this.steps.filter((step) => !this.driver?.supports(step.op))
    if (unsupported.length > 0) {
      throw new ImageError(
        `The ${this.driver.name} driver cannot ${unsupported.map((step) => `[${step.op}]`).join(', ')}. ` +
          `Use a driver that can, or drop the step — it will not be skipped silently.`
      )
    }

    return this.driver.apply(this.bytes, this.steps, this.encoding)
  }

  async toBase64(): Promise<string> {
    return Buffer.from(await this.toBytes()).toString('base64')
  }

  async toDataUri(): Promise<string> {
    const bytes = await this.toBytes()
    const mime = this.encoding.format ? `image/${this.encoding.format}` : this.mimeType

    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
  }

  /** A response with the right `content-type` and length. */
  async toResponse(headers: Record<string, string> = {}): Promise<Response> {
    const bytes = await this.toBytes()
    const mime = this.encoding.format ? `image/${this.encoding.format}` : this.mimeType

    return new Response(bytes as unknown as BodyInit, {
      headers: { 'content-type': mime, 'content-length': String(bytes.length), ...headers }
    })
  }

  /** Write it to the local filesystem, and hand back what was written. */
  async store(path: string): Promise<Uint8Array> {
    const bytes = await this.toBytes()
    await Bun.write(path, bytes)

    return bytes
  }

  /**
   * Write it to a configured disk, under a generated name.
   *
   * Answers the path it went to, so the caller has something to store. The name
   * carries nothing the client chose — see `hashName`.
   */
  async storeOn(
    directory = '',
    options: { disk?: string; visibility?: string; extension?: string } = {}
  ): Promise<string> {
    return this.storeOnAs(directory, this.hashName(options.extension), options)
  }

  async storeOnAs(
    directory: string,
    name: string,
    options: { disk?: string; visibility?: string } = {}
  ): Promise<string> {
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new ImageError(`[${name}] is not a filename. Pass the directory separately.`)
    }

    const folder = directory.replace(/^\/+|\/+$/g, '')
    const path = folder === '' ? name : `${folder}/${name}`

    await this.disks()
      .disk(options.disk)
      .put(path, await this.toBytes(), {
        ...(options.visibility === undefined ? {} : { visibility: options.visibility })
      })

    return path
  }

  storePublicly(
    directory = '',
    options: { disk?: string; extension?: string } = {}
  ): Promise<string> {
    return this.storeOn(directory, { ...options, visibility: 'public' })
  }

  storePubliclyAs(
    directory: string,
    name: string,
    options: { disk?: string } = {}
  ): Promise<string> {
    return this.storeOnAs(directory, name, { ...options, visibility: 'public' })
  }

  /**
   * A name nothing about the source decides, with the format's extension.
   *
   * The extension follows the *encoding* rather than the source: an image
   * converted to webp and stored as `.png` is one every CDN and every browser
   * will mislabel.
   */
  hashName(extension?: string): string {
    const format = extension ?? this.encoding.format ?? this.format
    const suffix = format === 'jpeg' ? 'jpg' : format

    return `${crypto.randomUUID().replaceAll('-', '')}.${suffix}`
  }

  // ------------------------------------------------------------- optimising

  /**
   * Re-encode at the best quality the format allows, and nothing else.
   *
   * The one call that makes an upload pipeline pay for itself: a phone camera's
   * JPEG is written at quality 95 or higher and looks identical at 82, which is
   * routinely half the bytes. No resize, no format change — the pixels are the
   * caller's business.
   *
   * A format with no quality dial is left alone rather than round-tripped: a
   * re-encode that changes nothing still costs a decode, and on a lossy format
   * it costs quality too.
   */
  optimize(): this {
    const format = this.encoding.format ?? this.format
    const best = BEST_QUALITY[format]

    if (best !== undefined) this.encoding.quality = this.encoding.quality ?? best

    return this
  }

  /**
   * The average colour, as `#rrggbb`.
   *
   * What a placeholder background is drawn from while the image loads. Read by
   * resizing to a single pixel and looking at it — an average rather than a
   * histogram's mode, which is what a placeholder wants: the mode of a photo of
   * a sunset is whichever band happens to be widest.
   */
  async dominantColor(): Promise<string> {
    const single = new Image(this.bytes, this.driver)

    single.steps.push(...this.steps, { op: 'resize', width: 1, height: 1 })
    single.encoding = { format: 'png' }

    return pixelOf(await single.toBytes())
  }

  private disks(): { disk(name?: string): ImageDisk } {
    const container = app()

    if (!container.bound('storage' as never)) {
      throw new Error(
        'Storing an image on a disk needs storage. Register StorageServiceProvider, or use store() for the local filesystem.'
      )
    }

    return container.make('storage' as never) as { disk(name?: string): ImageDisk }
  }
}

/**
 * The quality each lossy format is re-encoded at.
 *
 * Chosen where the difference stops being visible at ordinary viewing size, not
 * at the lowest number that still decodes. A format missing from this table has
 * no quality dial and is left alone.
 */
const BEST_QUALITY: Partial<Record<string, number>> = {
  jpeg: 82,
  webp: 80,
  avif: 63,
  heic: 80
}

/**
 * The one pixel of a 1×1 PNG.
 *
 * A PNG rather than a raw buffer because every driver can write one, and a
 * 1×1 image's IDAT is a handful of bytes: the zlib stream inflates to a filter
 * byte followed by the channels.
 */
function pixelOf(png: Uint8Array): string {
  const idat = chunkOf(png, 'IDAT')

  if (idat === undefined) throw new ImageError('The driver did not answer with a PNG.')

  // `node:zlib`, not `Bun.inflateSync`: IDAT is a zlib stream and that one wants
  // a raw deflate one — measured, it answers "invalid stored block lengths".
  const raw = inflateSync(idat)

  // Byte 0 is the row's filter type; a 1×1 image has nothing to filter against,
  // so every encoder writes 0 there and the channels follow.
  const [, red, green, blue] = raw

  if (red === undefined || green === undefined || blue === undefined) {
    throw new ImageError('The 1x1 re-encode did not carry three channels.')
  }

  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** One chunk's data out of a PNG, by its four-letter type. */
function chunkOf(png: Uint8Array, type: string): Uint8Array | undefined {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let at = 8

  while (at + 8 <= png.length) {
    const length = view.getUint32(at)
    const name = String.fromCharCode(...png.slice(at + 4, at + 8))

    if (name === type) return png.slice(at + 8, at + 8 + length)

    at += 12 + length
  }

  return undefined
}
