import elvel from '@elvel/vite'
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
    vue(),
    /**
     * Two entries, for the two halves of the application.
     *
     * `main.ts` is the Vue client. `server.ts` is what the server-rendered auth
     * pages load — one project, one manifest, one build, so there is never a
     * question of which of two configs wrote what.
     */
    elvel({ input: ['src/main.ts', 'src/server.ts'] })
  ]
}
