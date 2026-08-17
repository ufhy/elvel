import type { LogDriver, LogRecord } from '@elvel/contracts'

/** Discards everything — Laravel's `null` driver, and the default under tests. */
export class NullDriver implements LogDriver {
  write(): void {
    // Intentionally nothing.
  }
}

/** Keeps records in memory. Useful in tests and for `Log::build()` probes. */
export class MemoryDriver implements LogDriver {
  readonly records: LogRecord[] = []

  write(record: LogRecord): void {
    this.records.push(record)
  }

  clear(): void {
    this.records.length = 0
  }
}

/** Fans one record out to several drivers — the `stack` driver. */
export class StackDriver implements LogDriver {
  constructor(private readonly drivers: LogDriver[]) {}

  async write(record: LogRecord): Promise<void> {
    // Sequential, so a stack of file drivers keeps a deterministic order.
    for (const driver of this.drivers) {
      await driver.write(record)
    }
  }
}

/**
 * Writes to stderr — Laravel's `errorlog`.
 *
 * The channel for a container: stderr is what a runtime collects, and a file
 * inside a container is a file nobody reads before it is destroyed. Distinct
 * from the `console` driver, which is coloured and shaped for a person; this one
 * writes one plain line per record so a collector can parse it.
 */
export class ErrorLogDriver implements LogDriver {
  write(record: LogRecord): void {
    const context =
      Object.keys(record.context).length > 0 ? ` ${JSON.stringify(record.context)}` : ''

    process.stderr.write(
      `[${record.time.toISOString()}] ${record.channel}.${record.level.toUpperCase()}: ${record.message}${context}\n`
    )
  }
}

/** What a Slack webhook driver needs. */
export type SlackDriverOptions = {
  url: string
  username?: string
  emoji?: string
  /** Only send records at or above this level. */
  level?: string
}

const LEVEL_ORDER = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency'
]

/**
 * Posts to a Slack incoming webhook.
 *
 * Meant to sit in a `stack` behind a level filter, and the filter is not
 * optional in practice: a channel that receives every `info` is a channel
 * everybody mutes, and a muted alert channel is worse than none because it
 * looks like coverage.
 *
 * Delivery is fire-and-forget. A logging call must not fail the request that
 * made it, and it must not wait on Slack either — a webhook that takes two
 * seconds would add two seconds to whatever was being logged.
 */
export class SlackDriver implements LogDriver {
  constructor(
    private readonly options: SlackDriverOptions,
    /** Where a delivery failure goes. Without it, a failure is silent. */
    private readonly report?: (error: unknown) => void
  ) {}

  write(record: LogRecord): void {
    const minimum = LEVEL_ORDER.indexOf(this.options.level ?? 'error')

    if (LEVEL_ORDER.indexOf(record.level) < minimum) return

    const context =
      Object.keys(record.context).length > 0
        ? `\n\`\`\`${JSON.stringify(record.context, null, 2).slice(0, 1500)}\`\`\``
        : ''

    void fetch(this.options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: this.options.username ?? 'Elvel',
        icon_emoji: this.options.emoji ?? ':boom:',
        text: `*${record.level.toUpperCase()}* [${record.channel}] ${record.message}${context}`
      })
    }).catch((error: unknown) => {
      // Reported rather than thrown: the request that logged this has moved on,
      // and an unhandled rejection here would take the process with it.
      this.report?.(error)
    })
  }
}
