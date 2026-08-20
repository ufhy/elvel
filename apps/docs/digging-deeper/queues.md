# Queues

A queue is how a request returns before the work is done. `@elvel/queue` is
Laravel's queue with one honest difference, and the rest of this page is mostly
about what follows from it.

## Jobs carry data, not themselves

```ts
import { Job } from '@elvel/queue'

export class SendWelcomeEmail extends Job<{ userId: string }> {
  static override tries = 3
  static override backoff = [5, 30, 120]

  async handle(): Promise<void> {
    const user = await User.findOrFail(this.data.userId)
    // …
  }
}
```

```ts
import { dispatch } from '@elvel/queue'

await dispatch(new SendWelcomeEmail({ userId: user.id }))
await dispatch(new SendWelcomeEmail({ userId: user.id }), { delay: 60, queue: 'mail' })
```

Laravel serialises the job **object**; PHP can `serialize($job)` and TypeScript
cannot. So the base class owns `data`, and it is `data` that is written to the
queue and read back. The class is found by name when a worker picks the payload
up, which is why a job has to be registered:

```ts
queue().jobs.register(SendWelcomeEmail)
```

`bun elvel make:job SendWelcomeEmail` writes the class, and the scaffolded
application registers what it generates.

## Running one now

`dispatchSync()` runs a job in this process whatever the configured connection
is, and `QUEUE_CONNECTION=sync` makes that the default for everything — no worker
to run, and a failure throws where you can see it. That is the setting a
scaffolded application starts with, on purpose.

## Chains

Each job runs only once its predecessor succeeded:

```ts
import { chain } from '@elvel/queue'

await chain([new ConvertVideo({ id }), new GenerateThumbnails({ id }), new Notify({ id })])
```

## Batches

Many jobs, counted together, with callbacks when they finish:

```ts
const batch = await queue()
  .batch([new ImportRow({ row: 1 }), new ImportRow({ row: 2 })])
  .name('nightly import')
  .onSuccess(NotifyImportFinished)
  .onFailure(AlertOncall)
  .dispatch()
```

Three things differ from Laravel, each for a reason.

**The callbacks are job classes, not closures.** Laravel serialises a closure
into the batch row; a closure cannot be rebuilt in the worker that would run it.
Naming a job is the honest version of the same idea, and it means a callback gets
retries and a failure record like anything else that runs in a worker.

**`onSuccess` rather than `then`.** A class with a `then` member *is* a thenable,
so `await queue().batch([...])` would call it with `resolve`/`reject` instead of
your job classes. A chainable builder must not be mistakable for a promise.

**The returned batch is a snapshot.** Read it again to see progress:

```ts
const now = await batch.fresh()

now?.progress      // 100
now?.processedJobs // 2
now?.finished      // true
```

An entry may itself be an array, meaning "these, in order":

```ts
await queue().batch([
  [new Fetch({ id: 1 }), new Parse({ id: 1 })],
  [new Fetch({ id: 2 }), new Parse({ id: 2 })]
]).dispatch()
```

That is most bulk work — each item has its own steps in order, and the items do
not wait for each other — and neither a plain batch nor a plain chain says it.
A chain counts as all of its links, so `onSuccess` fires when the last one lands
rather than when the first chain is merely queued.

Failures stop the rest by default, as Laravel has it. `allowFailures()` keeps
going. Cancelling does not delete queued jobs — a worker cannot reach into
another queue and remove them — they are skipped at reservation instead, so a job
of a cancelled batch never reaches `handle()`.

## The transaction bug this avoids

```ts
export class SendWelcomeEmail extends Job<{ userId: string }> {
  static override afterCommit = true
}
```

A controller opens a transaction, writes a row, dispatches a job about it, and
commits. A worker is faster than the commit: it reserves the job, looks for the
row, and does not find it — reliably on a busy queue, never on a laptop.
`afterCommit` holds the push until the outermost transaction commits, and a
rollback drops the job entirely, because the rows it was about never existed.
Outside a transaction there is nothing to wait for and it pushes at once.

## When a job should not run

Middleware wraps `handle()`:

```ts
import { RateLimited, Skip, WithoutOverlapping } from '@elvel/queue'

middleware(): JobMiddleware[] {
  return [new WithoutOverlapping(cache(), `import:${this.data.accountId}`)]
}
```

- **`WithoutOverlapping`** takes a lock, and releases the job back to the queue
  if it cannot get in. Needs a cache store with locks.
- **`RateLimited`** releases the job for exactly as long as the limiter says it
  has to wait, rather than burning an attempt.
- **`Skip`** deletes the job when a condition says the work is pointless now.

## Attempts, timeouts and deadlines

| Property | What it does |
| --- | --- |
| `tries` | Attempts allowed. `0` means retry until `retryFor` runs out. |
| `backoff` | Seconds before a retry; a list is indexed by attempt. |
| `maxExceptions` | Exceptions allowed even while attempts remain. |
| `timeout` | Seconds one attempt may run. |
| `failOnTimeout` | Fail a timed-out attempt instead of retrying it. |
| `retryFor` | Stop retrying this many seconds after the first dispatch. |
| `unique` / `uniqueFor` | One instance at a time, keyed by `uniqueId()`. |
| `encrypted` | Encrypt the payload where the queue stores it. |

`retryFor` is checked **before** `tries`, exactly as the worker does it: a job
with a deadline keeps its deadline even when attempts remain. And the default for
a timeout is to retry, because a timeout is often the network having a bad
minute — `failOnTimeout` is for the case where it is not, since work that takes
longer than the timeout will take just as long on every remaining attempt.

## Drivers

```ts
// config/queue.ts
default: env('QUEUE_CONNECTION', 'sync'),

connections: {
  sync: { driver: 'sync' },
  database: { driver: 'database', table: 'jobs', queue: 'default', retryAfter: 90 },
  redis: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379'), retryAfter: 90 }
}
```

There is an `sqs` driver too. `retryAfter` is how long a reservation is trusted:
**set it above your slowest job**, because a job still running when it expires is
picked up a second time.

The database driver's reservation is a `select … for update` inside a
transaction, and it is tested against real Postgres and MySQL on every push
including the two-workers-race case — SQLite serialises writes anyway, so it
would pass whether or not the lock were there.

```bash
bun elvel queue:table && bun elvel migrate
```

## Running workers

```bash
bun elvel queue:work                       # the default connection
bun elvel queue:work --queue=high,default  # priority order
bun elvel queue:work --once
bun elvel queue:work --stop-when-empty --max-jobs=100 --max-time=3600
bun elvel queue:listen                     # reloads code between jobs, for development
```

`queue:restart` asks every worker to stop after its current job, which is what a
deploy runs — a worker holds your code in memory and will keep running the old
version until it exits. `queue:pause` and `queue:resume` stop reservations
without stopping the workers.

## When a job fails for the last time

```bash
bun elvel queue:failed-table && bun elvel migrate   # config/queue.ts: failed.driver = database
bun elvel queue:failed
bun elvel queue:retry <id>        # or "all"
bun elvel queue:forget <id>
bun elvel queue:flush --hours=48
```

The job's own `failed(error)` runs once, after the last attempt. Failures are
discarded entirely unless a `failed` driver is configured — which is the default,
so turn it on before you need it.

## Testing without a queue

```ts
const fake = queue().fake()

await dispatch(new SendWelcomeEmail({ userId: 'u9' }), { delay: 60, queue: 'mail' })

fake.assertPushed('SendWelcomeEmail')
fake.assertPushedOn('mail', 'SendWelcomeEmail')
fake.assertPushedWithDelay('SendWelcomeEmail', 60)
fake.assertCount(1)
```

`assertPushed` returns the pushed job, so the payload can be checked directly:

```ts
const pushed = fake.assertPushed('SendWelcomeEmail')

expect(pushed.payload.data).toEqual({ userId: 'u9' })
```

There is also `assertNotPushed`, `assertPushedTimes`, `assertNothingPushed`, and
`pushed(job?)` for the raw list.

## Every command

`make:job` · `make:job-middleware` · `queue:work` · `queue:listen` ·
`queue:restart` · `queue:pause` · `queue:resume` · `queue:size` ·
`queue:monitor` · `queue:clear` · `queue:failed` · `queue:retry` ·
`queue:forget` · `queue:flush` · `queue:retry-batch` · `queue:prune-batches` ·
`queue:table` · `queue:failed-table` · `queue:batches-table`

`bun elvel <command> --help` prints the options for any of them.
