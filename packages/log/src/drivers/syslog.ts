import { createSocket, type Socket } from 'node:dgram'
import { hostname } from 'node:os'
import type { LogDriver, LogLevel, LogRecord } from '@elvel/contracts'

/** RFC 5424 severities, which are not the PSR names and not in the same order. */
const SEVERITY: Record<LogLevel, number> = {
  emergency: 0,
  alert: 1,
  critical: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
  debug: 7
}

export type SyslogDriverOptions = {
  /** Where the collector is. Default: the local daemon. */
  host?: string
  port?: number
  /** The `facility` half of the priority. 16 is `local0`, the usual choice. */
  facility?: number
  /** What the collector files the lines under. */
  appName?: string
  /** Reported instead of thrown — a logging failure must not fail the request. */
  onError?: (error: unknown) => void
}

/**
 * Syslog over UDP, RFC 5424.
 *
 * UDP rather than the local `/dev/log` socket, which is a Unix *datagram*
 * socket and not something `node:dgram` can open. That rules out the local
 * daemon on a default Linux install and leaves the case syslog is usually
 * reached for anyway: a collector somewhere else, which is why the lines are
 * being sent off the machine at all.
 *
 * Fire and forget, like the protocol: a line that does not arrive is not worth
 * failing a request over, and back-pressure from a log collector is worse than
 * a missing line.
 */
export class SyslogDriver implements LogDriver {
  private socket: Socket | undefined
  private readonly host: string
  private readonly port: number
  private readonly facility: number
  private readonly appName: string
  private readonly report: (error: unknown) => void

  constructor(options: SyslogDriverOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 514
    this.facility = options.facility ?? 16
    this.appName = options.appName ?? 'elvel'
    this.report =
      options.onError ??
      ((error) => {
        // Straight to stderr: reporting a logging failure through the log is how
        // a broken channel becomes an infinite loop.
        process.stderr.write(
          `[log] syslog delivery failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
      })
  }

  write(record: LogRecord): Promise<void> {
    try {
      const line = Buffer.from(this.format(record))

      this.open().send(line, 0, line.length, this.port, this.host, (error) => {
        if (error) this.report(error)
      })
    } catch (error) {
      this.report(error)
    }

    return Promise.resolve()
  }

  /** Let the process exit: an open socket nobody is reading holds it open. */
  close(): void {
    this.socket?.close()
    this.socket = undefined
  }

  private open(): Socket {
    if (this.socket) return this.socket

    const socket = createSocket('udp4')

    socket.on('error', (error) => this.report(error))
    socket.unref()

    this.socket = socket

    return socket
  }

  private format(record: LogRecord): string {
    const priority = this.facility * 8 + SEVERITY[record.level]
    const context =
      Object.keys(record.context).length > 0 ? ` ${JSON.stringify(record.context)}` : ''

    // `-` is the nil value the RFC uses for a field nothing supplies: there is no
    // message id and no structured data, and omitting them is not valid.
    return `<${priority}>1 ${record.time.toISOString()} ${hostname()} ${this.appName} ${process.pid} ${record.channel} - ${record.message}${context}`
  }
}
