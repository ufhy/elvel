/**
 * The reflect polyfill, before anything the application imports.
 *
 * `tsyringe` checks for `Reflect.getMetadata` **while its module is evaluating**
 * and throws if it is missing. Nothing this kit writes uses it — it arrives
 * underneath passkeys, as `@better-auth/passkey` → `@peculiar/x509` → `tsyringe`,
 * and `@peculiar/x509` needs it for real: its ASN.1 decorators read metadata.
 *
 * From source the order never mattered, because Bun happened to evaluate the
 * polyfill first. `bun build` wraps each module in a lazy initialiser and reaches
 * `tsyringe` first, so a bundle without this line dies at boot naming a package
 * the application never imported.
 *
 * A literal import, so the bundler can see it and include it. This file exists
 * only in the kits that declare the dependency; everything else keeps the empty
 * one from the template.
 */

import 'reflect-metadata'
