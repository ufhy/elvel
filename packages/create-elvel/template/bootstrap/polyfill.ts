/**
 * Nothing, unless a kit needs something loaded before anything else.
 *
 * `elvel.ts` imports this file first, with a literal specifier, so whatever it
 * contains is evaluated before the application is. Here it contains nothing —
 * most applications need no polyfill and should not carry one.
 *
 * A kit that does replaces this file wholesale. That is the whole mechanism: a
 * layer wins per file, so the auth layer ships its own copy with the one import it
 * needs, and every other kit keeps this one.
 *
 * The alternative was a guarded dynamic import in `elvel.ts` —
 * `try { await import(name) } catch {}` with the specifier in a variable, so
 * `tsc` would not resolve a package most kits do not have. It could not be
 * bundled: a specifier the bundler cannot see stays a runtime `import()`, which
 * then has to resolve from `dist/`, and in a kit whose `workspaces` entry makes
 * Bun install in the isolated layout it does not. The `catch` swallowed that and
 * the failure surfaced much later, from a package the application never imported.
 */

export {}
