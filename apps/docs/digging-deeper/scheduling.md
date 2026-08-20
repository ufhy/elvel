# Task scheduling

One place that describes everything recurring, instead of a crontab per task.

```ts
// app/Providers/AppServiceProvider.ts
const schedule = this.app.make('schedule')

schedule.command('cache:prune', ['--store', 'database'])
  .hourly()
  .withoutOverlapping()
  .description('Delete expired rows from the database cache store')

schedule.job(new SendArticleDigest({})).dailyAt('02:00')

schedule.call(() => rebuildSearchIndex(), 'search index').everyFifteenMinutes()
```

Four ways in — `command`, `job`, `call` and `exec` (a shell command) — and they
all produce the same
kind of entry: a callback plus a cron expression. That is what keeps
`schedule:run` small enough to trust.

```bash
bun elvel schedule:list
```

```
EXPRESSION  TASK                                                       NEXT RUN
0 * * * *   Delete expired rows from the database cache store          2026-08-20 13:00
0 0 * * *   Drop batch records that are no longer worth keeping        2026-08-21 00:00
10 3 * * *  Delete session files older than the configured lifetime    2026-08-21 03:10
0 2 * * *   Queue the nightly article digest                           2026-08-21 02:00
```

## Nothing runs on its own

Two ways to make the schedule tick, and you need exactly one of them:

```cron
* * * * * cd /path/to/app && bun elvel schedule:run >> /dev/null 2>&1
```

```bash
bun elvel schedule:work    # a long-lived process, no crontab
```

::: warning `schedule:run` must be called **every** minute
It runs what is due *in that minute*. Calling it every five minutes silently
drops four minutes of entries. That is cron's contract, not a limitation added
here.
:::

`bun elvel dev` runs the server, a queue worker and the scheduler together, which
is what you want while developing.

## Frequencies

```ts
.everyMinute()  .everyFiveMinutes()  .everyFifteenMinutes()  .everyThirtyMinutes()
.hourly()  .hourlyAt(15)  .everyThreeHours()  .everyOddHour()
.daily()  .dailyAt('02:30')  .twiceDaily(1, 13)
.weekly()  .weeklyOn(1, '8:00')  .mondays()  .weekdays()  .weekends()
.monthly()  .monthlyOn(15, '9:00')  .twiceMonthly(1, 16)  .lastDayOfMonth('23:00')
.quarterly()  .yearly()  .yearlyOn(6, 1, '0:00')
.cron('*/7 4 * * *')
```

Verified rather than described:

```
dailyAt('02:30')     at 02:30 → true    at 02:31 → false
everyFifteenMinutes  at 10:15 → true    at 10:16 → false
lastDayOfMonth       Aug 31   → true    Aug 30   → false
```

Sub-minute frequencies exist too — `everySecond`, `everyFiveSeconds`,
`repeatEvery(seconds)` — and they only mean anything under `schedule:work`, which
is running continuously. A crontab cannot call anything more often than once a
minute.

## The day-of-month / day-of-week rule is POSIX's

This is the one that catches people, so it is worth stating plainly. When
**both** fields are restricted, an expression matches if **either** matches:

```
'0 0 1 * MON'   →  the 1st, and every Monday
```

```
the 1st, a Tuesday   → true
Monday the 7th       → true
Wednesday the 9th    → false
```

The intuitive reading — "the 1st, but only when it is a Monday" — would turn that
schedule into one that almost never runs. `L` and `W` are supported in the
day-of-month field: the last day of the month, and the weekday nearest a date.

## Timezones

```ts
schedule.command('reports:send').dailyAt('06:00').timezone('Asia/Makassar')
```

The whole schedule takes `app.timezone` from `config/app.ts`, so "daily at 3am"
means the same thing to every entry unless one says otherwise. Without a
configured zone the machine's own applies — which is a real difference between a
laptop and a server, and the reason to set it.

## Not running when it should not

```ts
.withoutOverlapping(1440)     // a lock, held for at most this many minutes
.onOneServer()                // one node of several takes it
.when(() => shouldRun())      // run only if
.skip(() => isHoliday())      // skip if
.between('9:00', '17:00')
.unlessBetween('0:00', '4:00')
.environments('production', 'staging')
.evenInMaintenanceMode()
```

`withoutOverlapping` and `onOneServer` both need a cache store with locks — the
second is what stops every node of a deploy running the nightly import at once.
By default the schedule stops entirely while the application is down, and
`evenInMaintenanceMode()` is the opt-out for the entry that brings it back.

`schedule:clear-cache` releases the mutexes when a run was killed rather than
finishing, and `schedule:pause` / `schedule:resume` stop the scheduler running
anything without stopping the scheduler.

## Slow tasks, and the minute

Entries run in the scheduler's **own process**, one after another. There is no
second runtime to start and the exit code comes back directly — the cost is that
a slow task holds the minute.

```ts
schedule.command('reports:build').daily().runInBackground()
```

That spawns a child running the application's own `elvel`. Only a **command** can
do it: a closure cannot be handed to a fresh process, which is why the entry
remembers the command name and its arguments separately from its callback.

## Output and hooks

```ts
.sendOutputTo('storage/logs/digest.log')
.appendOutputTo('storage/logs/digest.log')
.emailOutputTo('ops@example.com')
.emailOutputOnFailure('ops@example.com')

.before(() => …)  .after(() => …)  .onSuccess(() => …)  .onFailure(() => …)
```

And pinging a monitor:

```ts
.pingBefore(url)  .thenPing(url)  .pingOnSuccess(url)  .pingOnFailure(url)
```

::: tip A failed ping is swallowed on purpose
A monitor being unreachable must not turn a backup that worked into a run that
failed. Pinging is also the only reporting a schedule can have that survives the
schedule not running at all — no hook inside the process fires when the process
never starts.
:::

## Trying one now

```bash
bun elvel schedule:test                 # pick from a list
bun elvel schedule:test 'cache:prune'   # by name or description
bun elvel schedule:test --all
```

It ignores the expression and every filter, which is the point: you are asking
whether the task works, not whether it is due.

`schedule:interrupt` stops the current run after the entry it is on.
