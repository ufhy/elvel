import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { LogDriver, LogRecord } from '@elvel/contracts'

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
  /** Paths whose directory has been created, so the check is paid once. */
  private static readonly ensured = new Set<string>()

  private queue: Promise<unknown> = Promise.resolve()

  constructor(protected readonly path: string) {}

  write(record: LogRecord): Promise<void> {
    return this.append(this.resolvePath(record), formatLine(record))
  }

  protected resolvePath(_record: LogRecord): string {
    return this.path
  }

  /**
   * Append the line, and only the line.
   *
   * This used to read the whole file and write it back with the line on the end,
   * which made logging quadratic in the size of the log: measured, four batches of
   * doubling size took 173ms, 369ms, 1,056ms and 4,377ms — four times longer each
   * time the file doubled. At 1.9MB that is already 1.1ms per line, and a 100MB
   * `elvel.log` would cost around 58ms for one `log.info()`.
   *
   * The promise chain stays. It is not about the file size but about ordering:
   * two appends racing to the same file can interleave mid-line.
   *
   * `mkdir` because `Bun.write` created missing parents and `appendFile` does not
   * — dropping it would break the first write into a fresh `storage/logs`. It is
   * paid once per path, not once per line.
   */
  protected append(path: string, line: string): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!FileDriver.ensured.has(path)) {
        await mkdir(dirname(path), { recursive: true })
        FileDriver.ensured.add(path)
      }

      await appendFile(path, line)
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
 * `logs/elvel.log` becomes `logs/elvel-2026-08-11.log`, and files beyond
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
