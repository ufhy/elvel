import type { ApplicationContract } from '@elvel/contracts'
import { type ImageDriver, ImageError } from './contracts.ts'
import { MagickDriver } from './drivers/magick.ts'
import { SharpDriver } from './drivers/sharp.ts'
import { SipsDriver } from './drivers/sips.ts'
import { Image } from './image.ts'

export type ImageDriverFactory = () => ImageDriver

/**
 * Opens images and picks a backend.
 *
 * The default is `auto`, and it earns its place: a runtime shipping an image
 * library can assume it. Nothing ships with Bun, so
 * the honest default is to look — `sharp` if the application installed it,
 * ImageMagick if the machine has it, `sips` if this is a Mac — and to say
 * clearly when the answer is none.
 */
/** Enough of a disk for an image; `@elvel/storage` satisfies it. */
export type ImageDisk = {
  bytes(path: string): Promise<Uint8Array | null>
  put(path: string, contents: Uint8Array, options?: { visibility?: string }): Promise<boolean>
}

export class ImageManager {
  private readonly drivers = new Map<string, ImageDriver>()
  private readonly custom = new Map<string, ImageDriverFactory>()
  private detected?: ImageDriver | null

  constructor(private readonly app?: ApplicationContract) {}

  /** Bytes in hand — an upload, a download, a file already read. */
  fromBytes(bytes: Uint8Array | ArrayBuffer): Image {
    return new Image(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      this.driverOrNothing()
    )
  }

  async fromFile(path: string): Promise<Image> {
    return this.fromBytes(await Bun.file(path).arrayBuffer())
  }

  async fromBase64(base64: string): Promise<Image> {
    return this.fromBytes(Buffer.from(base64, 'base64'))
  }

  async fromResponse(response: Response): Promise<Image> {
    return this.fromBytes(await response.arrayBuffer())
  }

  /** A multipart upload, straight from the `File` a form posted. */
  async fromUpload(file: Blob | File): Promise<Image> {
    return this.fromBytes(await file.arrayBuffer())
  }

  /**
   * A file on a configured disk.
   *
   * The ordinary path — accept an upload, resize it, put it back on S3 — was
   * manual at both ends: read the `File`, then `toBytes()` and `put()`, naming
   * the result by hand.
   */
  async fromStorage(path: string, disk?: string): Promise<Image> {
    const bytes = await this.disk(disk).bytes(path)

    if (bytes === null)
      throw new ImageError(`No image at [${path}] on the ${disk ?? 'default'} disk.`)

    return this.fromBytes(bytes)
  }

  /**
   * Fetched over HTTP.
   *
   * A failed fetch names the URL and the status: an image pipeline that answered
   * "not an image" for a 404 would send everybody looking in the wrong place.
   */
  async fromUrl(url: string, init?: RequestInit): Promise<Image> {
    const response = await fetch(url, init)

    if (!response.ok) {
      throw new ImageError(`Fetching [${url}] answered ${response.status}.`)
    }

    return this.fromResponse(response)
  }

  /**
   * The storage manager, asked for rather than imported.
   *
   * `@elvel/image` does not depend on `@elvel/storage`, and its absence is an
   * error naming what to register — an image that silently went nowhere is
   * worse than one that failed.
   */
  disk(name?: string): ImageDisk {
    if (this.app === undefined || !this.app.bound('storage' as never)) {
      throw new Error(
        'Reading or writing an image on a disk needs storage. Register StorageServiceProvider, or use fromBytes()/toBytes().'
      )
    }

    return (this.app.make('storage' as never) as { disk(name?: string): ImageDisk }).disk(name)
  }

  /**
   * The configured driver, or the first one that is actually installed.
   *
   * Detection runs once and is remembered, because it costs a process spawn per
   * candidate and the answer cannot change while the process is alive.
   */
  async detect(): Promise<ImageDriver | undefined> {
    if (this.detected !== undefined) return this.detected ?? undefined

    for (const name of ['sharp', 'magick', 'sips']) {
      const candidate = this.build(name)
      if (await candidate.available()) {
        this.detected = candidate
        this.drivers.set(name, candidate)

        return candidate
      }
    }

    this.detected = null

    return undefined
  }

  driver(name?: string): ImageDriver {
    const resolved = name ?? this.app?.config.get<string>('image.driver', 'auto') ?? 'auto'

    if (resolved === 'auto') {
      const found = this.detected
      if (!found) {
        throw new ImageError(
          'No image driver has been detected yet. Await detect() first, or name a driver.'
        )
      }

      return found
    }

    const cached = this.drivers.get(resolved)
    if (cached) return cached

    const built = this.build(resolved)
    this.drivers.set(resolved, built)

    return built
  }

  /** The driver if one is known, and nothing if not — `Image` reports it. */
  private driverOrNothing(): ImageDriver | undefined {
    const configured = this.app?.config.get<string>('image.driver', 'auto') ?? 'auto'

    if (configured !== 'auto') return this.driver(configured)

    return this.detected ?? undefined
  }

  extend(name: string, factory: ImageDriverFactory): this {
    this.custom.set(name, factory)
    this.drivers.delete(name)

    return this
  }

  private build(name: string): ImageDriver {
    const custom = this.custom.get(name)
    if (custom) return custom()

    switch (name) {
      case 'sharp':
        return new SharpDriver()
      case 'magick':
        return new MagickDriver()
      case 'convert':
        return new MagickDriver(undefined, 'convert')
      case 'sips':
        return new SipsDriver()
      default:
        throw new ImageError(
          `Image driver [${name}] is not supported. Register it with image().extend().`
        )
    }
  }
}
