/**
 * The server's half of this package — the tags a document carries.
 *
 * `@elvel/vite`'s default export is the Vite plugin and runs inside
 * `vite.config.ts` under Node. This entry runs in the application, under Bun, and
 * is what a view imports:
 *
 * ```tsx
 * import { vite } from '@elvel/vite/tags'
 *
 * <head>{vite(['resources/js/app.ts'])}</head>
 * ```
 *
 * Two entry points rather than one, so a client project depending on the plugin
 * does not install a server framework it never loads — `@elvel/core` is an
 * optional peer for exactly that reason.
 *
 * This lived in `@elvel/view` until now. The manifest, the hot file and the asset
 * URLs are Vite's, not the view layer's; what `@elvel/view` still needs from Vite
 * is one config key, `vite.buildDirectory`, which it reads for the cache headers on
 * hashed filenames.
 */
export { Vite } from './tags.ts'
export { vite } from './tags-helper.ts'
