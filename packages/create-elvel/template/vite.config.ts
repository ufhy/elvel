import elvel from '@elvel/vite'

/**
 * The Vite half of this application.
 *
 * Exported as a plain object rather than through `defineConfig`, so this file
 * needs no import from `vite` — which means `bun run typecheck` works in a
 * checkout that has not installed the front-end dependencies yet.
 *
 * `@elvel/vite` settles what an application should not have to decide: the hot
 * file the server reads, a full reload when a view changes, `base` per command,
 * where the build writes and what its manifest is called. Add plugins beside it,
 * and override any of it in this file — anything set here wins.
 */
export default {
  plugins: [elvel({ input: ['resources/css/app.css', 'resources/js/app.ts'] })]
}
