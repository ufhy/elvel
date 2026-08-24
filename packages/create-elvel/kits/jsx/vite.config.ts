import elvel from '@elvel/vite'
import tailwindcss from '@tailwindcss/vite'

/**
 * The Vite half of this application.
 *
 * Exported as a plain object rather than through `defineConfig`, so this file
 * needs no import from `vite` — which means `bun run typecheck` works in a
 * checkout that has not installed the front-end dependencies yet.
 *
 * `@elvel/vite` settles what an application should not have to decide: the hot
 * file the server reads, a full reload when a view changes, `base` per command,
 * where the build writes and what its manifest is called. Anything set in this
 * file wins over it.
 */
export default {
  plugins: [
    /**
     * Tailwind v4, as its own Vite plugin rather than through PostCSS.
     *
     * It finds class names by scanning every text file in the project — `.tsx`
     * included, because it reads them as text rather than parsing them — so
     * there is no `content` list to keep in step with where the views live.
     *
     * Where it looks is pinned in `resources/css/app.css`, with
     * `@import "tailwindcss" source("../")`, and that line is worth the trouble of
     * understanding. Left to choose for itself, Tailwind reached outside the
     * application: a cold `bun run dev` took 108 seconds to serve the stylesheet
     * against 2.4 pinned, and generated 34 kB of utilities nothing here uses.
     *
     * An earlier version of this comment claimed the opposite — that a scaffold
     * inside the Elvel repository is invisible to Tailwind because `.gitignore`
     * covers it, and comes out nearly empty. Measured, it is not: the views were
     * found, and so was a great deal else.
     */
    tailwindcss(),

    elvel({ input: ['resources/css/app.css', 'resources/js/app.ts'] })
  ]
}
