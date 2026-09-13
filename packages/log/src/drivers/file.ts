import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { LogDriver, LogRecord } from '@elvel/contracts'

function formatLine(record: LogRecord): string {
  const context = Object.keys(record.context).length > 0 ? ` ${JSON.stringify(record.context)}` : ''

  return `[${record.time.toISOString()}] ${record.channel}.${record.level.toUpperCase()}: ${record.message}${context}\n`
}

/**
 * Append to one file.
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
}

/**
 * One file per day.
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
    return time.toISOString().slice(0, 10)
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

/** How often a rotating file starts a new one. */
export type RotationPeriod = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'never'

export type RotatingDriverOptions = {
  period?: RotationPeriod
  /**
   * Start a new file once this one passes this many bytes.
   *
   * The half `daily` cannot do: a busy application writing a gigabyte a day gets
   * one file for it, and a quiet one gets 365 tiny files a year. Size and period
   * combine — whichever comes first starts a new file.
   */
  maxBytes?: number
  /** How many files to keep. 0 keeps everything. */
  maxFiles?: number
}

/**
 * One file per period, per size, or both.
 *
 * `logs/elvel.log` becomes `logs/elvel-2026-08-11.log`, and with `maxBytes` set,
 * `logs/elvel-2026-08-11.1.log` when the first one fills.
 */
export class RotatingDriver extends FileDriver {
  private current = ''
  private index = 0

  constructor(
    path: string,
    private readonly rotation: RotatingDriverOptions = {}
  ) {
    super(path)
  }

  override async write(record: LogRecord): Promise<void> {
    const period = this.periodFor(record.time)
    const rotated = period !== this.current

    if (rotated) this.index = 0

    this.current = period

    await this.rollIfFull()
    await super.write(record)

    // Pruned after writing, not before: the newest file has to exist first or
    // the retention count is off by one.
    if (rotated) await this.prune()
  }

  /**
   * The index is padded and always present once size rotation is on.
   *
   * Both because the names have to sort: `elvel-2026-08-11.1.log` sorts *before*
   * `elvel-2026-08-11.log`, so a prune that trusted the sort would delete the
   * newer file. Same width, always there, and the sort is the age again.
   */
  protected override resolvePath(_record: LogRecord): string {
    const sized = (this.rotation.maxBytes ?? 0) > 0
    const parts = [this.current, sized ? String(this.index).padStart(3, '0') : '']

    const suffix = parts.filter((part) => part !== '').join('.')

    return join(dirname(this.path), `${this.baseName()}${suffix === '' ? '' : `-${suffix}`}.log`)
  }

  /** Ask the filesystem, because another process may be writing the same file. */
  private async rollIfFull(): Promise<void> {
    const max = this.rotation.maxBytes ?? 0

    if (max <= 0) return

    while ((await Bun.file(this.resolvePath({} as LogRecord)).size) >= max) this.index += 1
  }

  private baseName(): string {
    return basename(this.path).replace(/\.log$/, '')
  }

  private periodFor(time: Date): string {
    const at = time
    const iso = at.toISOString()

    switch (this.rotation.period ?? 'daily') {
      case 'never':
        return ''
      case 'hourly':
        return `${iso.slice(0, 10)}-${iso.slice(11, 13)}`
      case 'monthly':
        return iso.slice(0, 7)
      case 'weekly':
        return isoWeek(at)
      default:
        return iso.slice(0, 10)
    }
  }

  private async prune(): Promise<void> {
    const maxFiles = this.rotation.maxFiles ?? 14

    if (maxFiles <= 0) return

    const directory = dirname(this.path)

    let entries: string[]

    try {
      entries = await readdir(directory)
    } catch {
      return
    }

    const pattern = new RegExp(`^${this.baseName()}-.+\\.log$`)
    const found = entries.filter((entry) => pattern.test(entry)).sort()

    for (const stale of found.slice(0, Math.max(0, found.length - maxFiles))) {
      await unlink(join(directory, stale)).catch(() => {})
    }
  }
}

/**
 * `2026-W33`, ISO-8601.
 *
 * Weeks belong to the year holding their Thursday, so the first days of January
 * can be week 52 of the year before — writing `2026-W01` for them would put two
 * different weeks in one file.
 */
function isoWeek(at: Date): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))

  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)

  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}
