import { ProcessManager } from '@elysian/process'
import { type Encoding, type ImageDriver, ImageError, type Transformation } from '../contracts.ts'
import { probe } from '../probe.ts'
import { throughFiles } from './files.ts'

/**
 * ImageMagick, through its CLI.
 *
 * The complete backend: it is the only one here that can blur, sharpen and
 * grayscale. Not installed on this machine, which is why the tests skip it with a
 * message rather than pretending — the argument building is still covered,
 * because that is the part with decisions in it.
 *
 * Through temporary files rather than pipes, for the same reason as `sips`:
 * `@elysian/process` hands back a command's output as text, and a PNG does not
 * survive being decoded as UTF-8.
 */
export class MagickDriver implements ImageDriver {
  readonly name = 'magick'

  constructor(
    private readonly runner = new ProcessManager(),
    /** `magick` on v7, `convert` on v6. */
    private readonly binary = 'magick'
  ) {}

  supports(): boolean {
    return true
  }

  async available(): Promise<boolean> {
    return (
      (
        await this.runner.run(['command', '-v', this.binary]).catch(() => undefined)
      )?.successful() ?? false
    )
  }

  async apply(bytes: Uint8Array, steps: Transformation[], encoding: Encoding): Promise<Uint8Array> {
    const source = probe(bytes)
    const format = encoding.format ?? source.format

    return throughFiles(bytes, source.format, format, async (input, output) => {
      const result = await this.runner.run([
        this.binary,
        input,
        ...this.arguments(steps, encoding),
        output
      ])

      if (result.failed()) {
        throw new ImageError(
          `${this.binary} failed (${result.exitCode}): ${result.errorOutput.trim() || 'no output'}`
        )
      }
    })
  }

  /** The steps as ImageMagick operators, in order. */
  arguments(steps: Transformation[], encoding: Encoding): string[] {
    const argv: string[] = []

    for (const step of steps) {
      switch (step.op) {
        case 'resize':
          // `WxH!` ignores the aspect ratio; a lone dimension keeps it.
          argv.push(
            '-resize',
            step.width !== undefined && step.height !== undefined
              ? `${step.width}x${step.height}!`
              : step.width !== undefined
                ? `${step.width}x`
                : `x${step.height}`
          )
          break

        case 'scale':
          argv.push('-resize', `${step.factor * 100}%`)
          break

        case 'fit':
          if (step.fit === 'contain') {
            argv.push('-resize', `${step.width}x${step.height}`)
          } else {
            // `^` fills the box, then the crop takes the middle of the overflow.
            argv.push(
              '-resize',
              `${step.width}x${step.height}^`,
              '-gravity',
              'center',
              '-extent',
              `${step.width}x${step.height}`
            )
          }
          break

        case 'crop':
          argv.push(
            '-crop',
            `${step.width}x${step.height}+${step.x ?? 0}+${step.y ?? 0}`,
            '+repage'
          )
          break

        case 'rotate':
          argv.push('-rotate', String(step.degrees))
          break

        case 'flip':
          // ImageMagick's names are the other way round from everyone else's:
          // `-flip` is vertical and `-flop` is horizontal.
          argv.push(step.axis === 'vertical' ? '-flip' : '-flop')
          break

        case 'grayscale':
          argv.push('-colorspace', 'Gray')
          break

        case 'blur':
          argv.push('-blur', `0x${step.radius}`)
          break

        case 'sharpen':
          argv.push('-sharpen', `0x${step.amount}`)
          break

        case 'orient':
          argv.push('-auto-orient')
          break

        default:
          throw new ImageError(`The magick driver cannot [${(step as { op: string }).op}].`)
      }
    }

    if (encoding.quality !== undefined) argv.push('-quality', String(encoding.quality))

    return argv
  }
}
