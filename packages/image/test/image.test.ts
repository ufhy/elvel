import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application } from '@elysian/core'
import {
  Image,
  ImageError,
  ImageManager,
  ImageServiceProvider,
  MagickDriver,
  probe,
  SipsDriver,
  tryProbe
} from '../src/index.ts'

const fixtures = join(import.meta.dir, 'fixtures')
const bytesOf = async (name: string) =>
  new Uint8Array(await Bun.file(join(fixtures, name)).arrayBuffer())

/**
 * Every fixture is a real file at a known size.
 *
 * Seven were produced with `sips` from a macOS desktop picture and measured with
 * `sips -g pixelWidth -g pixelHeight`, so the expected numbers come from a second
 * implementation rather than from this one.
 */
const files: Array<[string, string, number, number]> = [
  ['sample.png', 'png', 60, 40],
  ['sample.jpeg', 'jpeg', 60, 40],
  ['sample.gif', 'gif', 60, 40],
  ['sample.bmp', 'bmp', 60, 40],
  ['sample.tiff', 'tiff', 60, 40],
  ['sample.heic', 'heic', 60, 40],
  ['sample.avif', 'avif', 60, 40],
  ['webp-vp8x.webp', 'webp', 60, 40],
  ['webp-vp8l.webp', 'webp', 60, 40],
  ['webp-vp8.webp', 'webp', 60, 40]
]

describe('probe', () => {
  for (const [name, format, width, height] of files) {
    test(`reads ${name}`, async () => {
      const info = probe(await bytesOf(name))

      expect(info.format).toBe(format as never)
      expect(info.width).toBe(width)
      expect(info.height).toBe(height)
      expect(info.mimeType).toBe(`image/${format}`)
    })
  }

  test('accepts an ArrayBuffer as well as a view', async () => {
    const buffer = await Bun.file(join(fixtures, 'sample.png')).arrayBuffer()

    expect(probe(buffer).width).toBe(60)
  })

  test('refuses bytes that are not an image', () => {
    expect(() => probe(new TextEncoder().encode('this is not a picture'))).toThrow(
      /not an image this can read/
    )
  })

  test('refuses a truncated header rather than inventing a size', () => {
    // The PNG signature and nothing after it.
    const stub = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    expect(() => probe(stub)).toThrow(/not an image/)
  })

  test('tryProbe answers undefined instead of throwing', async () => {
    expect(tryProbe(new TextEncoder().encode('nope'))).toBeUndefined()
    expect(tryProbe(await bytesOf('sample.png'))?.format).toBe('png')
  })

  /**
   * The header is the file; the extension and the content-type are claims.
   *
   * A PNG renamed to `.jpg` and uploaded with `content-type: image/jpeg` is still
   * a PNG, and this is the only thing in the request that knows.
   */
  test('does not believe a mislabelled file', async () => {
    const png = await bytesOf('sample.png')

    expect(probe(png).format).toBe('png')
    expect(probe(png).mimeType).toBe('image/png')
  })
})

describe('the fluent image, without a driver', () => {
  test('reports the source without touching a backend', async () => {
    const image = new Image(await bytesOf('sample.png'))

    expect(image.width).toBe(60)
    expect(image.height).toBe(40)
    expect(image.format).toBe('png')
    expect(image.mimeType).toBe('image/png')
    expect(image.dimensions()).toEqual({ width: 60, height: 40 })
  })

  test('queues steps without running them', async () => {
    const image = new Image(await bytesOf('sample.png')).resize(10).grayscale().rotate(90)

    expect(image.pending().map((step) => step.op)).toEqual(['resize', 'grayscale', 'rotate'])
    // The source is unchanged: nothing has been applied.
    expect(image.width).toBe(60)
  })

  test('hands back the original bytes when nothing was asked for', async () => {
    const bytes = await bytesOf('sample.png')

    // A re-encode that changes nothing still loses quality on a lossy format.
    expect(await new Image(bytes).toBytes()).toBe(bytes)
  })

  test('says what is missing when a transformation needs a driver', async () => {
    const image = new Image(await bytesOf('sample.png')).resize(10)

    await expect(image.toBytes()).rejects.toThrow(/needs a driver/)
    // And says the half that still works.
    await expect(image.toBytes()).rejects.toThrow(/dimensions and format needs no driver/)
  })

  test('refuses a resize with no dimensions at all', async () => {
    expect(() => new Image(new Uint8Array()).resize()).toThrow(ImageError)
  })

  test('refuses a quality outside 1–100 and a scale of zero', async () => {
    expect(() => new Image(new Uint8Array()).quality(0)).toThrow(/1 to 100/)
    expect(() => new Image(new Uint8Array()).scale(0)).toThrow(/above zero/)
  })
})

describe('driver capabilities', () => {
  test('sips declares what it cannot do', () => {
    const sips = new SipsDriver()

    expect(sips.supports('resize')).toBe(true)
    expect(sips.supports('crop')).toBe(true)
    // The reason `supports` is on the contract: no backend here does everything.
    expect(sips.supports('blur')).toBe(false)
    expect(sips.supports('grayscale')).toBe(false)
    expect(sips.supports('sharpen')).toBe(false)
  })

  test('an unsupported step is refused, not skipped', async () => {
    const image = new Image(await bytesOf('sample.png'), new SipsDriver()).blur(3)

    // Skipping it would return an image that looks right and is not.
    await expect(image.toBytes()).rejects.toThrow(/cannot \[blur\]/)
    await expect(image.toBytes()).rejects.toThrow(/not be skipped silently/)
  })

  /**
   * ImageMagick is not installed here, so its arguments are asserted directly.
   *
   * The argument building is where the decisions are — including the one that
   * catches people out: `-flip` is vertical and `-flop` is horizontal, the
   * opposite of what the names suggest.
   */
  test('magick builds the operators its documentation asks for', () => {
    const magick = new MagickDriver()

    expect(magick.arguments([{ op: 'resize', width: 30, height: 20 }], {})).toEqual([
      '-resize',
      '30x20!'
    ])
    expect(magick.arguments([{ op: 'resize', width: 30 }], {})).toEqual(['-resize', '30x'])
    expect(magick.arguments([{ op: 'fit', fit: 'contain', width: 20, height: 20 }], {})).toEqual([
      '-resize',
      '20x20'
    ])
    expect(magick.arguments([{ op: 'fit', fit: 'cover', width: 20, height: 20 }], {})).toEqual([
      '-resize',
      '20x20^',
      '-gravity',
      'center',
      '-extent',
      '20x20'
    ])
    expect(magick.arguments([{ op: 'flip', axis: 'horizontal' }], {})).toEqual(['-flop'])
    expect(magick.arguments([{ op: 'flip', axis: 'vertical' }], {})).toEqual(['-flip'])
    expect(magick.arguments([{ op: 'grayscale' }], { quality: 75 })).toEqual([
      '-colorspace',
      'Gray',
      '-quality',
      '75'
    ])
  })
})

/**
 * The real transformations, against whichever backend this machine has.
 *
 * Skipped rather than failed where there is none, the same way the S3 and SQS
 * round trips are — and the skip says which backends would have counted.
 */
const detected = await new ImageManager().detect()

if (!detected) {
  console.log('skipping the image transformations: no sharp, no ImageMagick, no sips')
}

describe.if(detected !== undefined)(`transformations through ${detected?.name}`, () => {
  const open = async (name = 'sample.png') => new Image(await bytesOf(name), detected)

  test('resize takes exactly the dimensions given', async () => {
    const out = probe(await (await open()).resize(30, 20).toBytes())

    expect([out.width, out.height]).toEqual([30, 20])
  })

  test('resize with one dimension keeps the ratio', async () => {
    const out = probe(await (await open()).resize(30).toBytes())

    expect([out.width, out.height]).toEqual([30, 20])
  })

  /**
   * The distinction both exist for.
   *
   * `cover` fills the box and loses the overflow, so it is exactly 20x20.
   * `contain` fits inside and keeps everything, so a 3:2 source becomes 20x13.
   * Getting these the wrong way round silently crops a face out of a photo.
   */
  test('cover fills the box and contain fits inside it', async () => {
    const covered = probe(await (await open()).cover(20, 20).toBytes())
    const contained = probe(await (await open()).contain(20, 20).toBytes())

    expect([covered.width, covered.height]).toEqual([20, 20])
    expect([contained.width, contained.height]).toEqual([20, 13])
  })

  test('scale halves both sides', async () => {
    const out = probe(await (await open()).scale(0.5).toBytes())

    expect([out.width, out.height]).toEqual([30, 20])
  })

  test('a quarter turn swaps the dimensions', async () => {
    const out = probe(await (await open()).rotate(90).toBytes())

    expect([out.width, out.height]).toEqual([40, 60])
  })

  test('crop takes a region', async () => {
    const out = probe(await (await open()).crop(10, 10).toBytes())

    expect([out.width, out.height]).toEqual([10, 10])
  })

  test('converts format and leaves the size alone', async () => {
    const out = probe(await (await open()).toJpeg(80).toBytes())

    expect(out.format).toBe('jpeg')
    expect([out.width, out.height]).toEqual([60, 40])
  })

  test('reads one format and writes another', async () => {
    const out = probe(await (await open('sample.heic')).resize(20).toPng().toBytes())

    expect(out.format).toBe('png')
    expect(out.width).toBe(20)
  })

  test('a chain is one pass, in the order written', async () => {
    const out = probe(await (await open()).resize(40, 40).rotate(90).crop(10, 20).toBytes())

    expect([out.width, out.height]).toEqual([10, 20])
  })

  test('toResponse carries the right content type and length', async () => {
    const response = await (await open()).resize(20).toPng().toResponse()

    expect(response.headers.get('content-type')).toBe('image/png')
    const body = new Uint8Array(await response.arrayBuffer())
    expect(response.headers.get('content-length')).toBe(String(body.length))
    expect(probe(body).width).toBe(20)
  })

  test('a data URI names the format it encoded to', async () => {
    const uri = await (await open()).resize(4).toJpeg().toDataUri()

    expect(uri).toStartWith('data:image/jpeg;base64,')
  })

  test('store writes the transformed bytes', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `elysian-image-test-${process.pid}-stored.png`)

    try {
      await (await open()).resize(12, 8).store(path)
      expect(probe(new Uint8Array(await Bun.file(path).arrayBuffer()))).toMatchObject({
        width: 12,
        height: 8
      })
    } finally {
      await Bun.file(path)
        .delete()
        .catch(() => undefined)
    }
  })

  test('leaves nothing behind in the temporary directory', async () => {
    const before = new Bun.Glob('elysian-image-*').scanSync({
      cwd: process.env.TMPDIR ?? '/tmp',
      onlyFiles: false
    })
    const count = [...before].length

    await (await open()).resize(15).toBytes()

    /**
     * A failing command must not leak a directory either.
     *
     * The failure is a truncated file — a real PNG header with rubbish after it —
     * so `probe()` accepts it and the backend rejects it immediately. An absurd
     * crop was the first attempt and was a bad one: `sips` genuinely tries to
     * build the canvas, so the test timed out under load instead of failing fast.
     */
    const truncated = new Uint8Array(64)
    truncated.set((await bytesOf('sample.png')).subarray(0, 33), 0)
    await new Image(truncated, detected)
      .resize(10)
      .toBytes()
      .catch(() => undefined)

    const after = new Bun.Glob('elysian-image-*').scanSync({
      cwd: process.env.TMPDIR ?? '/tmp',
      onlyFiles: false
    })

    expect([...after].length).toBe(count)
  })
})

describe('the manager', () => {
  function managed(config: Record<string, unknown> = {}): ImageManager {
    const app = new Application(import.meta.dir)
    app.config.set('image', { driver: 'sips', ...config })

    return new ImageManager(app)
  }

  test('opens from bytes, a file and base64', async () => {
    const manager = managed()
    const bytes = await bytesOf('sample.png')

    expect(manager.fromBytes(bytes).width).toBe(60)
    expect((await manager.fromFile(join(fixtures, 'sample.png'))).width).toBe(60)
    expect((await manager.fromBase64(Buffer.from(bytes).toString('base64'))).width).toBe(60)
  })

  test('opens from a response', async () => {
    const bytes = await bytesOf('sample.png')
    const image = await managed().fromResponse(new Response(bytes as unknown as BodyInit))

    expect(image.format).toBe('png')
  })

  test('memoises drivers', () => {
    const manager = managed()

    expect(manager.driver()).toBe(manager.driver('sips'))
  })

  test('a custom driver can be registered', () => {
    const manager = managed({ driver: 'stub' })
    manager.extend('stub', () => ({
      name: 'stub',
      supports: () => true,
      available: async () => true,
      apply: async (bytes) => bytes
    }))

    expect(manager.driver().name).toBe('stub')
  })

  test('an unknown driver says how to add one', () => {
    expect(() => managed({ driver: 'photoshop' }).driver()).toThrow(/is not supported.*extend/s)
  })

  test('auto before detection says to detect first', () => {
    expect(() => managed({ driver: 'auto' }).driver()).toThrow(/Await detect\(\) first/)
  })

  test('detection is remembered rather than repeated', async () => {
    const manager = new ImageManager()

    expect(await manager.detect()).toBe((await manager.detect()) as never)
  })
})

describe('the provider', () => {
  test('binds one manager and detects at boot', async () => {
    const app = new Application(import.meta.dir)
    app.config.set('image', { driver: 'auto' })
    await app.register(ImageServiceProvider)
    await app.boot()

    expect(app.make('image')).toBe(app.make('image'))
    // Detection ran at boot, so `driver()` answers without awaiting anything.
    if (detected) expect(app.make('image').driver().name).toBe(detected.name)
  })
})
