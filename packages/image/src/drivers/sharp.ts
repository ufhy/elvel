import { type Encoding, type ImageDriver, ImageError, type Transformation } from '../contracts.ts'

type SharpInstance = {
  resize(options: Record<string, unknown>): SharpInstance
  extract(options: Record<string, number>): SharpInstance
  rotate(degrees?: number): SharpInstance
  flip(): SharpInstance
  flop(): SharpInstance
  grayscale(): SharpInstance
  blur(radius: number): SharpInstance
  sharpen(options: Record<string, number>): SharpInstance
  toFormat(format: string, options?: Record<string, unknown>): SharpInstance
  metadata(): Promise<{ width?: number; height?: number }>
  toBuffer(): Promise<Buffer>
}

type SharpFactory = (input: Uint8Array) => SharpInstance

/**
 * `sharp`, when the application installed it.
 *
 * The right backend in production — libvips in process, no spawn per image — and
 * an optional dependency rather than a required one, because it is a native
 * module that has to build or download a binary for the platform. It is imported
 * lazily so a machine without it can still use everything else here.
 */
export class SharpDriver implements ImageDriver {
  readonly name = 'sharp'
  private factory?: SharpFactory

  supports(): boolean {
    return true
  }

  async available(): Promise<boolean> {
    return (await this.load()) !== undefined
  }

  private async load(): Promise<SharpFactory | undefined> {
    if (this.factory) return this.factory

    try {
      /**
       * The specifier is a variable on purpose.
       *
       * `import('sharp')` is resolved at type-check time, so a repository without
       * the optional package fails to compile — which is the opposite of optional.
       * Held in a variable, the import stays dynamic and the absence becomes what
       * it should be: a driver that reports itself unavailable.
       */
      const specifier = 'sharp'
      const module = (await import(specifier)) as { default?: SharpFactory } & SharpFactory
      this.factory = (module.default ?? module) as SharpFactory

      return this.factory
    } catch {
      return undefined
    }
  }

  async apply(bytes: Uint8Array, steps: Transformation[], encoding: Encoding): Promise<Uint8Array> {
    const sharp = await this.load()
    if (!sharp) {
      throw new ImageError(
        'The sharp driver needs the "sharp" package. Install it, or use the magick or sips driver.'
      )
    }

    let pipeline = sharp(bytes)

    for (const step of steps) {
      switch (step.op) {
        case 'resize':
          pipeline = pipeline.resize({ width: step.width, height: step.height, fit: 'fill' })
          break

        case 'scale': {
          const { width, height } = await sharp(bytes).metadata()
          pipeline = pipeline.resize({
            width: Math.max(1, Math.round((width ?? 1) * step.factor)),
            height: Math.max(1, Math.round((height ?? 1) * step.factor))
          })
          break
        }

        case 'fit':
          pipeline = pipeline.resize({ width: step.width, height: step.height, fit: step.fit })
          break

        case 'crop':
          pipeline = pipeline.extract({
            left: step.x ?? 0,
            top: step.y ?? 0,
            width: step.width,
            height: step.height
          })
          break

        case 'rotate':
          pipeline = pipeline.rotate(step.degrees)
          break

        case 'flip':
          // sharp's `flip` is vertical and `flop` horizontal, as in ImageMagick.
          pipeline = step.axis === 'vertical' ? pipeline.flip() : pipeline.flop()
          break

        case 'grayscale':
          pipeline = pipeline.grayscale()
          break

        case 'blur':
          pipeline = pipeline.blur(step.radius)
          break

        case 'sharpen':
          pipeline = pipeline.sharpen({ sigma: step.amount })
          break

        case 'orient':
          // No argument means "use the EXIF orientation".
          pipeline = pipeline.rotate()
          break

        default:
          throw new ImageError(`The sharp driver cannot [${(step as { op: string }).op}].`)
      }
    }

    if (encoding.format) {
      pipeline = pipeline.toFormat(
        encoding.format === 'jpeg' ? 'jpeg' : encoding.format,
        encoding.quality === undefined ? undefined : { quality: encoding.quality }
      )
    }

    return new Uint8Array(await pipeline.toBuffer())
  }
}
