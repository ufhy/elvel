# Processes

Run a command, get a result. `@elvel/process` is Laravel's `Process` facade on
Bun's spawn.

```ts
import { process } from '@elvel/process'

const result = await process().run('echo hello')

result.successful()   // true
result.exitCode       // 0
result.output         // 'hello\n'
result.errorOutput    // ''
```

::: tip `exitCode`, `output` and `errorOutput` are properties
`successful()`, `failed()`, `throw()`, `lines()` and `json()` are methods.
`result.exitCode()` fails with `exitCode is not a function`.
:::

## When it fails

```ts
const failed = await process().run('sh -c "echo oops >&2; exit 3"')

failed.failed()      // true
failed.exitCode      // 3
failed.errorOutput   // 'oops\n'

failed.throw()       // ProcessFailedError
```

```
The command [sh -c "echo oops >&2; exit 3"] exited with code 3…
```

`throwIf(condition)` is the conditional form. `seeInOutput`, `seeInErrorOutput`,
`all()` (both streams), `lines()` and `json()` read the result.

Binary output is available as `bytes` when the command asked for `binary()` —
empty otherwise, which is the honest answer rather than a decoded string
re-encoded, since that round trip is what destroys the data.

## Building the command

```ts
process()
  .path('/srv/app')                 // working directory
  .env({ NODE_ENV: 'production' })
  .timeout(30_000)                 // milliseconds; 0 disables it
  .input('data on stdin')
  .quietly()                        // do not inherit the parent's streams
  .binary()
  .run('git status')
```

## Pipes

Each step's stdout becomes the next one's stdin:

```ts
const sorted = await process()
  .pipe((pipe) => pipe.add('printf "b\\na\\nc"').add('sort'))
  .run()

sorted.output   // 'a\nb\nc\n'
```

A failed step stops the pipe rather than feeding its empty output onward.

## Pools

Several at once:

```ts
const pool = await process()
  .pool((p) => p.add('echo one').add('echo two'))
  .run()

pool.all().map((r) => r.output.trim())   // ['one', 'two']
pool.successful()                        // true
pool.failed()                            // the results that did not
pool.throw()                             // names which step failed
```

`concurrently(['echo a', 'echo b'])` is the short form when the steps need no
names or configuration:

```ts
(await process().concurrently(['echo a', 'echo b'])).all()   // ['a', 'b']
```

`start()` on a pool hands back the handles without waiting, for when you want to
watch them yourself.

## Long-running commands

```ts
const invoked = process().start('bun elvel queue:work', (chunk) => log(chunk))

invoked.running()          // still going?
invoked.output()           // what it has written so far
invoked.errorOutput()
invoked.signal('SIGTERM')  // or any signal
invoked.onFinished((result) => …)

const result = await invoked.wait()
```

`start()` takes an output handler, so a long-running command can be followed
while it runs rather than only read at the end.

## Testing

```ts
process().fake({ 'git status': 'nothing to commit' })

(await process().run('git status')).output   // 'nothing to commit'

process().assertRan('git status')
```

Nothing is spawned. `assertRan`, `assertRanCount`, `assertDidntRun` and
`assertNothingRan` cover the rest, and a fake definition can be a string, an
object with `output`/`errorOutput`/`exitCode`, or a function of the command.
