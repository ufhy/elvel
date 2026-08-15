import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Where a descriptor's module actually is, as something `import()` accepts.
 *
 * A descriptor names a path — relative to the application's base path, or
 * absolute — and both drivers have to turn that into the same specifier, or the
 * same descriptor means two different files depending on which driver ran it.
 *
 * Neither half of this is decoration. `resolve` is what makes `./x.ts` mean
 * *the base path's* `x.ts` rather than one beside whichever source file called
 * `import()`; `pathToFileURL` is what makes it work on Windows. This used to
 * build `file://${base}/${module}` by hand and take the `.pathname` back off it,
 * which on Windows produced `/D:/app/x.ts` — a path with a leading slash in
 * front of a drive letter, which resolves to nothing. Every task run through
 * either driver failed there, and only there.
 */
export function specifierFor(module: string, basePath: string): string {
  // `resolve` returns an absolute argument untouched, so this handles both
  // shapes without asking which one it has.
  return pathToFileURL(resolve(basePath, module)).href
}
