/**
 * Image — dimensions everywhere, transformations where a backend exists.
 *
 * Bun has no image API: no `createImageBitmap`, no `OffscreenCanvas`, nothing
 * native. So this package is deliberately two halves.
 *
 * `probe()` reads format and dimensions out of the bytes in pure TypeScript, for
 * png, jpeg, gif, webp, bmp, tiff, avif and heic. No dependency, no driver, works
 * anywhere — and it is the check most applications actually need, since the file
 * extension and the `content-type` a client sent are claims and the header is the
 * file.
 *
 * Transforming needs a backend, and one is looked for rather than assumed:
 * `sharp` if installed, ImageMagick if on the machine, `sips` on macOS. A driver
 * that cannot perform a queued step says so instead of quietly skipping it.
 */
export {
  type Encoding,
  type Fit,
  type ImageDriver,
  ImageError,
  type Transformation,
  WRITABLE
} from './contracts.ts'
export { MagickDriver } from './drivers/magick.ts'
export { SharpDriver } from './drivers/sharp.ts'
export { SipsDriver } from './drivers/sips.ts'
export { image } from './helpers.ts'
export { Image } from './image.ts'
export { type ImageDriverFactory, ImageManager } from './manager.ts'
export { type ImageInfo, probe, tryProbe } from './probe.ts'
export { ImageServiceProvider } from './provider.ts'
