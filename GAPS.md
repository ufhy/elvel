# Gaps

What a scaffolded application carries that it never uses.

Laravel can ship every config file and an empty `database/` directory for free,
because `laravel/framework` is a single Composer package: the code for Eloquent,
Queue, Mail and Broadcasting lands in `vendor/` whether or not the application
touches it, so a file listing its settings costs nothing but text.

This framework is twenty-six packages. Here the cost is not the folder — it is
the dependency list and the provider list, and both are the same for every kit.
`--kit=none`, an application that serves one static page with no database and no
auth, installs all twenty-six `@elyvel/*` packages plus `better-auth`, and its
`config/app.ts` statically imports and registers twenty-three service providers.

That is also why the `sideEffects` work does not help here. A bundler may drop a
module nobody reached; every provider is reached, by a real import that runs on
every boot.

Measured on `--kit=none` — a landing page with no auth and no database:

    1165 modules   5.2 MB of source   ->   3.65 MB out

    kysely                                250   659.8 KB  12.4%
    nodemailer                             35   492.3 KB   9.3%
    @sinclair/typebox                     236   385.8 KB   7.3%
    @elyvel/database                      55   347.9 KB   6.5%
    elysia                                 25   346.8 KB   6.5%
    better-auth                            59   331.5 KB   6.2%
    @opentelemetry/semantic-conventions     9   317.4 KB   6.0%
    zod                                    20   271.2 KB   5.1%
    @better-auth/core                      80   224.7 KB   4.2%
    @elyvel/queue                         31   140.4 KB   2.6%

Three things that table settles.

The expensive part is not our code. Every `@elyvel/*` package together is about
1.6 MB of the 5.2; the rest is what they drag behind them — `kysely` through
`@elyvel/database`, `nodemailer` through `@elyvel/mail`, and `better-auth`
with `@better-auth/*`, `zod`, `jose` and `@noble/*` adding up to roughly 1.06 MB
through `@elyvel/auth`, in an application that has no auth.

The difference is exactly the provider list. What a landing page actually
reaches is `@elyvel/core`, `view`, `support` and `scheduler` — 326 modules,
1.0 MB. Adding `config/app.ts` takes it to 1165 modules and 5.2 MB.

That 326-module figure is also what a bundle used to contain, and the reason the
first measurement here was wrong. `bootstrap/app.ts` did not import `config/` at
all — configuration was found at run time by `readdir` — so the build omitted
every provider and produced something that could not boot. Naming the files in
`withConfig` fixed it, and moved the honest number from 0.86 MB to 3.72 MB.

And `file-type`, with `strtok3` and the tokenizer packages behind it, is not
ours to remove: it is a peer dependency of Elysia itself.

Rows are deleted as they are closed, never narrowed — a list that cannot shrink
hides all progress. One left.

---

## 1. Every package ships as source, and two things block changing it

`main` and `exports` point at `./src/index.ts`, so an application installing
`@elyvel/mail` gets sixteen TypeScript modules to transpile rather than one file
to parse. Across twenty-six packages that is about 311 of the thousand-odd
modules a boot loads.

Measured rather than estimated, by building all twenty-six to single files and
repointing `main` at them:

    plain   2047 ms -> 1650 ms   (-19%)
    auth    4121 ms -> 2293 ms   (-44%)

Both applications still answered `/health` with 200 on the built packages, so
the numbers are of something that works. The auth kit nearly halves, which is
almost twice what the module count suggested — `@sinclair/typebox` at 236
modules and `kysely` at 250 still arrive from npm as many small files and are
untouched by any of this.

Three obstacles, all verified rather than assumed.

**`"sideEffects": false` makes `bun build` produce a broken bundle.** Given an
entry that only re-exports — which every `src/index.ts` here is — Bun 1.3.14
emits 0.55 KB containing an export list and nothing else, and importing it throws
`SyntaxError: Exported binding 'CARRIES_RESPONSE' needs to refer to a top-level
declared variable`. Removing the field from that package turns the same command
into a correct 0.78 MB bundle. There is no `--ignore-annotations` to pass. So the
build has to strip the field, build, and put it back — and the field cannot
simply go, because it is what lets an *application's* bundler drop what it does
not import.

**`bun pm pack` ignores `publishConfig`.** The obvious way to publish `dist`
while developing against `src` is `publishConfig.exports`, and the tarball comes
out with `exports` still pointing at `./src/index.ts` and `publishConfig` left in
the manifest unused. So the switch has to happen in `scripts/release.ts`.

**And a built package needs types it cannot currently emit.** Pointing `exports`
at `dist/index.js` means pointing `types` at `dist/index.d.ts`, and TypeScript
does produce them — `tsc --declaration --emitDeclarationOnly --noEmit false`
across the whole repository emits without a single error. What it emits is
unusable: because the source imports carry extensions, every line comes out as
`export { Config } from './config.ts'`, and a consumer resolving that looks for
`config.ts.d.ts`. So this needs a `.d.ts` bundler, or dropping `.ts` from every
relative import in twenty-six packages.

That is why `1.0.0-alpha.1` ships source, as `0.1.0-alpha.6` did. The release
works and the types are exact; the boot cost stays.
