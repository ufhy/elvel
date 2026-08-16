/**
 * What TypeScript needs to believe about the things Vite can import.
 *
 * `import './widget.css'` is a Vite feature, not a TypeScript one, so without
 * this the compiler refuses a stylesheet as a module it cannot find. Vite ships
 * the same declarations in `vite/client`, referenced by name — but that only
 * resolves once the front-end dependencies are installed, and `bun run
 * typecheck` should work in a fresh checkout.
 */
declare module '*.css' {
  const url: string
  export default url
}

declare module '*.svg' {
  const url: string
  export default url
}
