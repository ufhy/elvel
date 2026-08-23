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
     * One consequence worth knowing: it **skips anything `.gitignore` covers**.
     * An application scaffolded inside the Elvel repository lands under an
     * ignored directory, so its own views are invisible to Tailwind and the
     * stylesheet comes out nearly empty. Outside the repository — which is every
     * real application — there is nothing to do.
     */
    tailwindcss(),

    elvel({ input: ['resources/css/app.css', 'resources/js/app.ts'] })
  ]
}
