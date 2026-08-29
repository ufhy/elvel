# Deployment

## The short version

```bash
bun install --production
bun elvel key:generate           # once, if the environment has no APP_KEY
bun elvel migrate --force
bun run build                    # assets, through Vite
bun elvel optimize               # config cache + the server bundle
bun dist/elvel.js serve
```

`--force` skips the confirmation `migrate` asks for in production, which is what
makes it runnable unattended. `--isolated` skips if another `migrate` already
holds the lock — the case being a deploy that runs this on every node at once,
where exactly one of them should do the work.

`--pretend` prints the migrations that *would* run. Worth doing first on anything
you have not deployed before.

## `optimize`, and why it matters more here than in Laravel

```bash
bun elvel optimize
```

```
 INFO  Cached 8 config file(s): bootstrap/cache/config.json
 INFO  Built dist/elvel.js (1.41 MB)
 INFO  Cached: config:cache, app:build.
```

**Booting is what costs**, because Bun re-transpiles every module in every
process and nothing is cached between runs. Measured on scaffolded applications:

| | from source | bundled |
| --- | --- | --- |
| `--kit=none` | 2047 ms | 221 ms |
| `--kit=jsx` | 4005 ms | 535 ms |
| `elvel list` | 4.019 s | 0.604 s |

The second row was measured before `auth` stopped being a kit of its own, and it
carries over because `jsx` **is** that application server-side: it layers on `auth`
and adds a stylesheet, a component set and one controller, none of which the server
loads differently.

Of that four seconds, **3761 ms is Bun loading and transpiling modules** and 244 ms
is config, provider registration, boot and routes. So a
quarter of a second of it is your application. `BUN_RUNTIME_TRANSPILER_CACHE_PATH`
does not help: it only holds files above 50 KB, and a framework of small modules
has almost none — measured with it set, the cache took ten entries and the boot
did not move.

Bundling is the cache PHP gets for free from opcache. It is also why there is no
`DeferrableProvider` here: deferring a provider saves the 244 ms, not the 3761.

`elvel.ts` hands over to `dist/elvel.js` **only when the bundle is newer than
every source file**, `package.json` and `bun.lock`. Nothing happens until somebody
builds one, and any edit makes it stale — a fast path used without being opted
into is one that eventually runs yesterday's code.

`optimize:clear` undoes both halves.

## What goes in the environment

```
APP_ENV=production
APP_DEBUG=false
APP_KEY=…              # elvel key:generate
AUTH_SECRET=…          # elvel auth:secret, and never the same value as APP_KEY
DATABASE_URL=…
```

`APP_DEBUG=false` matters: the exception handler renders a stack trace when it is
on. And `Env.boolean` reads `false` as false — a plain `process.env` check would
see the string `"false"` and switch debugging *on*, which is the bug that reading
env through `Env` exists to prevent.

For a repository that carries its own environment:

```bash
bun elvel env:encrypt --env=production
```

That writes an encrypted file safe to commit and prints the key, which goes
wherever your deployment keeps secrets — not next to it.

## Choices that change behind a load balancer

Three defaults are right for one machine and wrong for two.

**Sessions.** `file` keeps the session on whichever container wrote it, so half
the requests cannot find it and people are logged out at random — a failure that
looks like a bug in the auth code. Move to `database`, `redis` or `cache`:

```bash
bun elvel session:table && bun elvel migrate    # for database
```

**Broadcasting.** `memory` reaches only the sockets *this* process holds. With two
processes, half the browsers never hear the event. `redis` publishes to a bus every
process reads — see [broadcasting](/digging-deeper/broadcasting#more-than-one-process).

**Trusted proxies.** `X-Forwarded-For` is believed only from a proxy named in
`http.trustedProxies`. Unset it and every rate limit keyed by IP silently stops
working, because each request arrives with a different apparent address.

## Workers and the schedule

```cron
* * * * * cd /srv/app && bun elvel schedule:run >> /dev/null 2>&1
```

Or run `schedule:work` as a long-lived process. **Every minute** — `schedule:run`
runs what is due *in that minute*, so calling it every five drops four minutes of
entries.

```bash
bun elvel queue:work --tries=3 --max-time=3600
```

Under a process manager, and **`queue:restart` on every deploy**: a worker holds
your code in memory and keeps running the old version until it exits.

Something has to sweep the database-backed stores, which have no expiry of their
own:

```ts
schedule.command('cache:prune', ['--store', 'database']).hourly()
schedule.command('queue:prune-batches', ['--hours', '48']).daily()
```

## Health, and knowing it broke

```bash
bun elvel db:monitor --max=80 --json
bun elvel queue:monitor default --max=1000 --json
bun elvel about
```

Both take `--json` and fail above the threshold, so a scheduled entry can page
somebody. Remember a Bun SQL connection is a **pool** — ten by default — so
anything counting connections has to allow for its own.

`log:tail --level=error` follows the log without needing to know where the file
is.

## Maintenance mode

```bash
bun elvel down --retry=60 --except=/health --with-secret
bun elvel up
```

The payload lives in **a file**, because the reason to need maintenance mode is
often that the database is what broke.
`--render=errors.maintenance` bakes the page now so it can be served without
booting the view layer.

## One thing to know before depending on this

Nothing here has run in production. The suite covers SQLite, Postgres and MySQL,
both caches and the queue drivers, on three platforms, and the smoke run drives a
real application over a socket. None of that is a year of somebody else's traffic.

Packages also ship **TypeScript source**, so your `tsc` compiles their internals.
That makes the types exact and makes our problems yours: `@elvel/mail` once
imported an untyped subpath and applications failed their own typecheck while ours
passed. Building each package to one file would end that class of bug, and
measured, it also made boot 35–40% *slower* — so it is not done.
