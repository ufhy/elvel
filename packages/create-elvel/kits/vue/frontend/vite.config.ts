import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import elvel from '@elvel/vite'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'

/**
 * An ordinary Vite project, plus one plugin.
 *
 * `@elvel/vite` is what makes this a client for the application above it: it finds
 * that application by walking up for `elvel.ts`, writes the hot file the server
 * reads, builds into its `public/build` with a named manifest, and sets `base` so a
 * lazily imported chunk resolves. Nothing else in here knows the server exists.
 *
 * Everything a Vite project normally does still applies — add plugins, change the
 * dev port, upgrade Vite — and nothing about it is framework-specific.
 */
export default {
  plugins: [
    /**
     * Vue, and the reason this project pins classic TypeScript.
     *
     * `defineProps<SidebarProps>()` in a shadcn-vue component extends a type
     * imported from `reka-ui`, and the SFC compiler has to read that package to
     * find it. For a bare specifier it has exactly one way to do that — TypeScript's
     * own module resolution — and it says so: *"TypeScript is required as a peer dep
     * for vue in order to support resolving types from module imports."* There is no
     * filesystem-only path; passing `script.fs` covers relative imports and nothing
     * else.
     *
     * The framework runs on TypeScript 7, which is a native binary no JavaScript
     * runtime can import — so `ts.sys` comes back empty and the build fails with 23
     * errors, one per component with typed props. Hence `typescript@5` and `vue-tsc`
     * in *this* project's devDependencies, separate from the application's. It buys
     * something back, too: `vue-tsc` runs, so props are checked across a `.vue`
     * boundary rather than shimmed away.
     */
    vue(),

    /**
     * Tailwind v4, as its own Vite plugin rather than through PostCSS.
     *
     * It finds class names by scanning every text file it is pointed at — `.vue`
     * included, because it reads them as text rather than parsing them — so there
     * is no `content` list to keep in step with where the components live.
     *
     * Where it is pointed matters, and `src/style.css` pins it with
     * `@import "tailwindcss" source("./")`. Left to choose, Tailwind reached outside
     * the application: a cold `bun run dev` took 14.3 seconds to serve the
     * stylesheet against 3.1 pinned, and produced 41 kB of utilities nothing here
     * uses.
     */
    tailwindcss(),

    /**
     * Two entries, for the two halves of the application.
     *
     * `main.ts` is the Vue client. `server.ts` is what the server-rendered auth
     * pages load — one project, one manifest, one build, so there is never a
     * question of which of two configs wrote what.
     */
    elvel({ input: ['src/main.ts', 'src/auth.ts', 'src/server.ts'] })
  ],

  resolve: {
    alias: {
      /**
       * `@/components/ui/button` — the import path shadcn-vue writes.
       *
       * Its CLI reads this alias from `components.json` and refuses to run without
       * it, and every component it has already written imports through it. It must
       * agree with `paths` in `tsconfig.json`, or the editor and the bundler
       * disagree about the same import.
       *
       * Resolved from this file's own URL rather than from `process.cwd()`, and
       * through `fileURLToPath` rather than `new URL(…).pathname` — the latter
       * yields `/C:/…` on Windows, which resolves to nothing.
       */
      '@': resolve(fileURLToPath(new URL('.', import.meta.url)), 'src')
    }
  }
}
