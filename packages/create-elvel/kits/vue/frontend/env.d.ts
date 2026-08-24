/// <reference types="vite/client" />

/**
 * What `import Thing from './Thing.vue'` is.
 *
 * A single-file component is not TypeScript, so the compiler needs telling. This
 * is the shim `bun create vite` ships for the same reason.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<{}, {}, unknown>

  export default component
}
