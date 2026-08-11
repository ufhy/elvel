import { readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { LogDriver, LogRecord } from '@elysian/contracts'

function formatLine(record: LogRecord): string {
  const context = Object.keys(record.context).length > 0 ? ` ${JSON.stringify(record.context)}` : ''

  return `[${record.time.toISOString()}] ${record.channel}.${record.level.toUpperCase()}: ${record.message}${context}\n`
}

/**
 * Append to one file — Laravel's `single` driver.
 *
 * Writes are serialised through a promise chain rather than fired in parallel,
 * because two concurrent appends to the same file can interleave mid-line.
 */
export class FileDriver implements LogDriver {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(protected readonly path: string) {}

  write(record: LogRecord): Promise<void> {
    return this.append(this.resolvePath(record), formatLine(record))
  }

  protected resolvePath(_record: LogRecord): string {
    return this.path
  }

  protected append(path: string, line: string): Promise<void> {
    this.queue = this.queue.then(async () => {
      const file = Bun.file(path)
      const existing = (await file.exists()) ? await file.text() : ''

      await Bun.write(path, existing + line)
    })

    return this.queue as Promise<void>
  }
}

export type DailyDriverOptions = {
  /** How many dated files to keep. 0 keeps everything. */
  maxFiles?: number
  /** Injectable clock, so retention is testable without waiting a day. */
  now?: () => Date
}

/**
 * One file per day — Laravel's `daily` driver.
 *
 * `logs/elysian.log` becomes `logs/elysian-2026-08-11.log`, and files beyond
 * `maxFiles` are pruned after each rotation.
 */
export class DailyDriver extends FileDriver {
  private lastDate = ''

  constructor(
    path: string,
    private readonly options: DailyDriverOptions = {}
  ) {
    super(path)
  }

  override async write(record: LogRecord): Promise<void> {
    const rotated = this.dateFor(record.time) !== this.lastDate

    await super.write(record)

    // Prune after writing, not before: today's file has to exist first or the
    // retention count is off by one and keeps maxFiles + 1 files.
    if (rotated) await this.prune(dirname(this.path), this.baseName())
  }

  protected override resolvePath(record: LogRecord): string {
    const date = this.dateFor(record.time)
    this.lastDate = date

    return join(dirname(this.path), `${this.baseName()}-${date}.log`)
  }

  private baseName(): string {
    return basename(this.path).replace(/\.log$/, '')
  }

  private dateFor(time: Date): string {
    const source = this.options.now ? this.options.now() : time

    return source.toISOString().slice(0, 10)
  }

  private async prune(directory: string, name: string): Promise<void> {
    const maxFiles = this.options.maxFiles ?? 14
    if (maxFiles <= 0) return

    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return
    }

    const pattern = new RegExp(`^${name}-\\d{4}-\\d{2}-\\d{2}\\.log$`)
    const dated = entries.filter((entry) => pattern.test(entry)).sort()

    for (const stale of dated.slice(0, Math.max(0, dated.length - maxFiles))) {
      await unlink(join(directory, stale)).catch(() => {})
    }
  }
}
