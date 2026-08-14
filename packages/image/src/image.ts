import {
  type Encoding,
  type Fit,
  type ImageDriver,
  ImageError,
  type Transformation
} from './contracts.ts'
import { type ImageInfo, probe } from './probe.ts'

/**
 * An image and the steps queued against it — Laravel's `Image`.
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

  /** Write it, and hand back what was written. */
  async store(path: string): Promise<Uint8Array> {
    const bytes = await this.toBytes()
    await Bun.write(path, bytes)

    return bytes
  }
}
