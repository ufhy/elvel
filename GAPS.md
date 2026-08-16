# Gaps

What a scaffolded application carries that it never uses.

Laravel can ship every config file and an empty `database/` directory for free,
because `laravel/framework` is a single Composer package: the code for Eloquent,
Queue, Mail and Broadcasting lands in `vendor/` whether or not the application
touches it, so a file listing its settings costs nothing but text.

This framework is twenty-six packages. Here the cost is not the folder — it is
the dependency list and the provider list, and both are the same for every kit.
`--kit=none`, an application that serves one static page with no database and no
auth, installs all twenty-six `@elysian/*` packages plus `better-auth`, and its
`config/app.ts` statically imports and registers twenty-three service providers.

That is also why the `sideEffects` work does not help here. A bundler may drop a
module nobody reached; every provider is reached, by a real import that runs on
every boot.

Measured on `--kit=none` — a landing page with no auth and no database:

    1165 modules   5.2 MB of source   ->   3.65 MB out

    kysely                                250   659.8 KB  12.4%
    nodemailer                             35   492.3 KB   9.3%
    @sinclair/typebox                     236   385.8 KB   7.3%
    @elysian/database                      55   347.9 KB   6.5%
    elysia                                 25   346.8 KB   6.5%
    better-auth                            59   331.5 KB   6.2%
    @opentelemetry/semantic-conventions     9   317.4 KB   6.0%
    zod                                    20   271.2 KB   5.1%
    @better-auth/core                      80   224.7 KB   4.2%
    @elysian/queue                         31   140.4 KB   2.6%

Three things that table settles.

The expensive part is not our code. Every `@elysian/*` package together is about
1.6 MB of the 5.2; the rest is what they drag behind them — `kysely` through
`@elysian/database`, `nodemailer` through `@elysian/mail`, and `better-auth`
with `@better-auth/*`, `zod`, `jose` and `@noble/*` adding up to roughly 1.06 MB
through `@elysian/auth`, in an application that has no auth.

The difference is exactly the provider list. What a landing page actually
reaches is `@elysian/core`, `view`, `support` and `scheduler` — 326 modules,
1.0 MB. Adding `config/app.ts` takes it to 1165 modules and 5.2 MB.

That 326-module figure is also what a bundle used to contain, and the reason the
first measurement here was wrong. `bootstrap/app.ts` did not import `config/` at
all — configuration was found at run time by `readdir` — so the build omitted
every provider and produced something that could not boot. Naming the files in
`withConfig` fixed it, and moved the honest number from 0.86 MB to 3.72 MB.

And `file-type`, with `strtok3` and the tokenizer packages behind it, is not
ours to remove: it is a peer dependency of Elysia itself.

Rows are deleted as they are closed, never narrowed — a list that cannot shrink
hides all progress.

---

## 1. Which providers an application cannot boot without

Strip the provider list one at a time against `--kit=none` until what remains is
what the application genuinely needs — the guess is core, http, view, log,
events, encryption and session, and a guess is exactly what this is meant to
replace. The survivors become the core list, held up by evidence rather than by
taste.

## 2. `config/app.ts` per kit

`--kit=none` registers the core list; `auth` and `api` each add what they need.
This is the row that makes tree-shaking work at all, because a provider that is
never imported is finally droppable.

Touches both existing kits and their tests.

## 3. Dependencies per kit

`_package.json` stops naming all twenty-six packages unconditionally.
`--kit=none` installs no `better-auth`, and no `@elysian/database` if row 1 finds
it is not required. This is the part no amount of tree-shaking can reach: an
unused dependency is still downloaded, still resolved, still in the lockfile.

## 4. `artisan config:publish`

Laravel's, whose signature is:

    config:publish {name?} {--all} {--force}

With no name it offers a choice; `--all` writes every one. Its source is the
framework's own `config/` directory — the sixteen files the skeleton no longer
ships.

Ours has to work the same way for every config file the template stops sending,
which means each package keeps its defaults where the command can find them.
Prerequisite for row 5: Laravel could slim its skeleton because it had this
first.

## 5. Trim the template's `config/` to ten files

Laravel 11 slimmed its skeleton deliberately, and ships:

    app  auth  cache  database  filesystems  logging  mail  queue
    services  session

We send nineteen — those ten plus `broadcasting`, `concurrency`, `cors`,
`hashing`, `http`, `image`, `notifications`, `view`, `vite`. For a landing page
with no auth, not one of the nine is read.

Every config read in the framework already carries a default —
`config.get<string>('queue.default', 'sync')` and its like — so a missing file
is not a missing setting.

## 6. Hold the number

Re-measure the `--kit=none` bundle and lock it with a test, the way
`tests/side-effects.test.ts` locks the `sideEffects` claim. Today it is 1165
modules and 5.2 MB of source for a landing page; whatever rows 1 to 3 bring it
down to is the number to assert.

A number that is never asserted is a number that quietly goes back up, and
nothing about a scaffolded application would break loudly when it does.

## 7. The no-auth story

Only after the rows above, because the answer moves. Three directions:

- leave `--kit=none` empty, as Laravel leaves it;
- have `none` ship one working data chain — model, migration, factory, seeder;
- add a fourth kit and leave `none` as bare as it is.

If row 3 concludes that `--kit=none` should not install `@elysian/database` at
all, the second direction stops being a matter of taste and starts being a
contradiction.
