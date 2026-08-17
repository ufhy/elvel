import type { LogDriver, LogRecord } from '@elvel/contracts'

export type JsonDriverOptions = {
  /** Where to write. `stdout` by default; `stderr` suits container platforms. */
  stream?: 'stdout' | 'stderr'
}

/**
 * One JSON object per line (NDJSON) — the shape log collectors expect.
 */
export class JsonDriver implements LogDriver {
  constructor(private readonly options: JsonDriverOptions = {}) {}

  write(record: LogRecord): void {
    const line = JSON.stringify({
      time: record.time.toISOString(),
      level: record.level,
      channel: record.channel,
      message: record.message,
      ...record.context
    })

    if ((this.options.stream ?? 'stdout') === 'stderr') console.error(line)
    else console.log(line)
  }
}
