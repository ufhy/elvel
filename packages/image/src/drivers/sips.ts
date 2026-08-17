import { ProcessManager } from '@elyvel/process'
import { type Encoding, type ImageDriver, ImageError, type Transformation } from '../contracts.ts'
import { probe } from '../probe.ts'
import { throughFiles } from './files.ts'

/**
 * macOS's own `sips` — a backend that is already there.
 *
 * Worth having because it needs no install on any Mac, which is where most of
 * this framework's development happens. It is also the most limited: `sips` has
 * no blur, no sharpen and no grayscale, and `supports()` says so rather than
 * letting a step be dropped.
 *
 * Files rather than pipes, because `sips` reads and writes paths and has no
 * stdin mode. Each call gets its own directory and removes it afterwards.
 */
export class SipsDriver implements ImageDriver {
  readonly name = 'sips'

  private readonly supported = new Set<Transformation['op']>([
    'resize',
    'fit',
    'scale',
    'crop',
    'rotate',
    'flip',
    'orient'
  ])

  constructor(private readonly runner = new ProcessManager()) {}

  supports(op: Transformation['op']): boolean {
    return this.supported.has(op)
  }

  async available(): Promise<boolean> {
    return (
      (await this.runner.run(['command', '-v', 'sips']).catch(() => undefined))?.successful() ??
      false
    )
  }

  async apply(bytes: Uint8Array, steps: Transformation[], encoding: Encoding): Promise<Uint8Array> {
    const source = probe(bytes)

    return throughFiles(
      bytes,
      source.format,
      encoding.format ?? source.format,
      async (input, output) => {
        const argv = [
          'sips',
          ...this.arguments(steps, encoding, source.width, source.height),
          input,
          '--out',
          output
        ]

        const result = await this.runner.run(argv)
        if (result.failed()) {
          throw new ImageError(
            `sips failed (${result.exitCode}): ${result.errorOutput.trim() || result.output.trim()}`
          )
        }
      }
    )
  }

  /**
   * The steps as flags, in order.
   *
   * `sips` applies its flags in the order given, so the queue maps directly. The
   * exception is `fit`, which it has no flag for: `cover` and `contain` are
   * different enough that they are computed here from the source dimensions and
   * expressed as a resample plus, for `cover`, a crop.
   */
  private arguments(
    steps: Transformation[],
    encoding: Encoding,
    width: number,
    height: number
  ): string[] {
    const argv: string[] = []
    let currentWidth = width
    let currentHeight = height

    for (const step of steps) {
      switch (step.op) {
        case 'resize':
          if (step.width !== undefined && step.height !== undefined) {
            argv.push('--resampleHeightWidth', String(step.height), String(step.width))
            currentWidth = step.width
            currentHeight = step.height
          } else if (step.width !== undefined) {
            argv.push('--resampleWidth', String(step.width))
            currentHeight = Math.round((currentHeight * step.width) / currentWidth)
            currentWidth = step.width
          } else if (step.height !== undefined) {
            argv.push('--resampleHeight', String(step.height))
            currentWidth = Math.round((currentWidth * step.height) / currentHeight)
            currentHeight = step.height
          }
          break

        case 'scale': {
          const scaled = Math.max(1, Math.round(currentWidth * step.factor))
          argv.push('--resampleWidth', String(scaled))
          currentHeight = Math.max(1, Math.round((currentHeight * scaled) / currentWidth))
          currentWidth = scaled
          break
        }

        case 'fit': {
          /**
           * `cover` fills the box and loses the overflow; `contain` fits inside
           * it and keeps everything. The distinction is the whole reason both
           * exist, and getting it backwards silently crops a face out of a photo.
           */
          const ratio =
            step.fit === 'cover'
              ? Math.max(step.width / currentWidth, step.height / currentHeight)
              : Math.min(step.width / currentWidth, step.height / currentHeight)

          const resampledWidth = Math.max(1, Math.round(currentWidth * ratio))
          const resampledHeight = Math.max(1, Math.round(currentHeight * ratio))

          argv.push('--resampleHeightWidth', String(resampledHeight), String(resampledWidth))

          if (step.fit === 'cover') {
            argv.push('--cropToHeightWidth', String(step.height), String(step.width))
            currentWidth = step.width
            currentHeight = step.height
          } else {
            currentWidth = resampledWidth
            currentHeight = resampledHeight
          }
          break
        }

        case 'crop':
          argv.push('--cropToHeightWidth', String(step.height), String(step.width))
          if (step.x !== undefined && step.y !== undefined) {
            argv.push('--cropOffset', String(step.y), String(step.x))
          }
          currentWidth = step.width
          currentHeight = step.height
          break

        case 'rotate':
          argv.push('--rotate', String(step.degrees))
          if (step.degrees % 180 !== 0) {
            ;[currentWidth, currentHeight] = [currentHeight, currentWidth]
          }
          break

        case 'flip':
          argv.push('--flip', step.axis)
          break

        case 'orient':
          // `sips` honours the EXIF orientation on any re-encode, so this is
          // already done by the time anything is written.
          break

        default:
          throw new ImageError(`The sips driver cannot [${step.op}].`)
      }
    }

    if (encoding.format) argv.push('-s', 'format', encoding.format)
    if (encoding.quality !== undefined) {
      // `sips` takes a name, not a number.
      const name =
        encoding.quality >= 90
          ? 'best'
          : encoding.quality >= 70
            ? 'high'
            : encoding.quality >= 40
              ? 'normal'
              : 'low'
      argv.push('-s', 'formatOptions', name)
    }

    return argv
  }
}
