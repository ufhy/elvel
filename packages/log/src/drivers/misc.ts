import type { LogDriver, LogRecord } from '@elysian/contracts'

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
