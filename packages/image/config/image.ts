/**
 * Which backend transforms images.
 *
 * `auto` looks for one at boot — `sharp` if you installed it, ImageMagick if the
 * machine has it, `sips` on macOS — and reports honestly when there is none.
 * Nothing ships with Bun, so there is no safe default to assume.
 *
 * Reading an image's format and dimensions needs no backend at all and always
 * works, which covers validating an upload before storing it.
 */
export default {
  /** `auto`, `sharp`, `magick`, `convert`, or `sips`. */
  driver: process.env.IMAGE_DRIVER ?? 'auto'
}
