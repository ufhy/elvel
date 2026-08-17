import { stat } from 'node:fs/promises'
import { Command } from '@elvel/console'
import pc from 'picocolors'

/** How a line is coloured, by level. */
const COLOURS: Record<string, (text: string) => string> = {
  emergency: pc.bgRed,
  alert: pc.bgRed,
  critical: pc.red,
  error: pc.red,
  warning: pc.yellow,
  notice: pc.cyan,
  info: pc.green,
  debug: pc.dim
}

const ORDER = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']

function atOrAbove(level: string, minimum: string): boolean {
  const index = ORDER.indexOf(level)
  const floor = ORDER.indexOf(minimum)

  return floor === -1 || (index !== -1 && index >= floor)
}

/**
 * `log:tail` — follow the log as it is written, like Laravel Pail.
 *
 * `tail -f` works and is what everybody does; the reason for a command is the
 * filtering. A log at any real volume is unreadable without it, and grepping a
 * multi-line stack trace loses the lines around the match.
 *
 * Reads the file rather than listening in-process, so it follows what was
 * actually *written* — including entries from a worker or a scheduled task in
 * another process, which a listener here would never see.
 */
export class LogTailCommand extends Command {
  static override signature =
    "log:tail {--path= : File to follow. Defaults to the single channel's} {--level= : Only lines at or above this level} {--filter= : Only lines containing this text} {--lines=20 : How much of the existing file to show first} {--timeout=3600 : Stop after this many seconds}"

  static override description = 'Follow the log file as it is written'

  /** Whether the last log line passed the filters — see `print`. */
  private lastPassed = true

  async handle(): Promise<number> {
    const path = this.stringOption('path') || this.defaultPath()

    if (!(await Bun.file(path).exists())) {
      this.error(`No log file at ${path}.`)
      this.comment('Pass --path, or configure the single channel.')

      return 1
    }

    const level = (this.stringOption('level') || '').toLowerCase()
    const filter = this.stringOption('filter')
    const deadline = Date.now() + Number(this.stringOption('timeout') || 3600) * 1000

    this.info(`Following ${path}. Press Ctrl+C to stop.`)

    const existing = (await Bun.file(path).text()).split('\n').filter((line) => line !== '')

    for (const line of existing.slice(-Number(this.stringOption('lines') || 20))) {
      this.print(line, level, filter)
    }

    // The offset, not the contents: re-reading the whole file every tick is what
    // makes a naive tail unusable on a log that has been running for a week.
    let offset = (await stat(path)).size
    let stopping = false

    const stop = () => {
      stopping = true
    }

    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)

    while (!stopping && Date.now() < deadline) {
      await Bun.sleep(250)

      const size = (await stat(path).catch(() => ({ size: offset }))).size

      // Truncated — `> file`, or a daily driver rolling over. Start from the
      // beginning rather than reading past the end for ever.
      if (size < offset) offset = 0
      if (size === offset) continue

      const chunk = await Bun.file(path).slice(offset, size).text()
      offset = size

      for (const line of chunk.split('\n')) {
        if (line !== '') this.print(line, level, filter)
      }
    }

    return 0
  }

  /**
   * Print one line, if it passes the filters.
   *
   * A line that is not in the log's own format — the second line of a stack
   * trace — is printed whenever the line before it was, so a trace arrives whole
   * rather than as its first line only.
   */
  private print(raw: string, level: string, filter: string): void {
    /**
     * Control characters are stripped before anything reaches the terminal.
     *
     * A log line carries whatever was logged, and that routinely includes user
     * input — a username, a URL, a rejected payload. An escape sequence in there
     * is executed by the terminal displaying it: at best it repaints the screen
     * and hides the lines around it, at worst it drives whatever else that
     * terminal lets escape sequences drive. What is read here is data, and it is
     * printed as data.
     */
    const line = stripControl(raw)
    const parsed = /^\[[^\]]+\]\s+\S+\.(\w+):/.exec(line)

    if (!parsed) {
      if (this.lastPassed) this.output.line(pc.dim(line))

      return
    }

    const lineLevel = (parsed[1] ?? '').toLowerCase()

    this.lastPassed =
      (level === '' || atOrAbove(lineLevel, level)) && (filter === '' || line.includes(filter))

    if (!this.lastPassed) return

    const paint = COLOURS[lineLevel] ?? ((text: string) => text)

    this.output.line(paint(line))
  }

  private defaultPath(): string {
    const channel = this.app.config.get<{ path?: string } | undefined>('logging.channels.single')

    return channel?.path ?? this.app.storagePath('logs', 'elvel.log')
  }
}

/**
 * Remove escape sequences and other control characters from a log line.
 *
 * Tabs and newlines are ordinary in a logged payload and survive; everything
 * else below 0x20, plus DEL and the C1 range, becomes a replacement character so
 * the line still shows that something was there rather than silently shortening.
 */
export function stripControl(value: string): string {
  const escapes = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
  const controls = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
    'g'
  )

  return value.replace(escapes, '').replace(controls, '\uFFFD')
}
