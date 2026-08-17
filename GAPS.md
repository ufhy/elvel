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

## 1. Hold the number

Re-measure the `--kit=none` bundle and lock it with a test, the way
`tests/side-effects.test.ts` locks the `sideEffects` claim. Today it is 1165
modules and 5.2 MB of source with every provider registered, and 1.47 MB built
once `--kit=none` registers only eleven; 1.47 MB now that a kit registers only what it
needs; that is the number to assert.

A number that is never asserted is a number that quietly goes back up, and
nothing about a scaffolded application would break loudly when it does.

## 2. The no-auth story

Only after the rows above, because the answer moves. Three directions:

- leave `--kit=none` empty, as Laravel leaves it;
- have `none` ship one working data chain — model, migration, factory, seeder;
- add a fourth kit and leave `none` as bare as it is.

If the pruning concludes that `--kit=none` should not install `@elysian/database` at
all, the second direction stops being a matter of taste and starts being a
contradiction.

## 3. Deferrable providers

Laravel's own answer to a long provider list, and one this framework has no
version of. `Mail`, `Cache`, `Queue`, `Validation`, `Broadcasting`, `Translation`
and `Hashing` all implement `DeferrableProvider`: they declare what they provide,
and the container registers them the first time one of those bindings is asked
for. A manifest maps binding to provider, so the class is not even loaded before
that.

It solves a different half of the problem than the rows above. Per-kit lists stop
an application installing and bundling what it cannot use; deferring stops it
*booting* what it has not used yet. Worth having once the lists are settled,
because the two compose: a kit that legitimately needs the mailer still should
not pay for it on a request that sends no mail.
