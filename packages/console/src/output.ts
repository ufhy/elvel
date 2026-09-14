import * as prompts from '@clack/prompts'
import pc from 'picocolors'

/**
 * Terminal output + interaction.
 *
 * Argument parsing is ours (signature-driven, like Artisan) but the interactive
 * layer is `@clack/prompts` — it is 2KB against Enquirer's ~100KB and Ink's
 * ~150KB + React, which matters because the CLI is meant to be shipped with
 * `bun build --compile`.
 */
/**
 * How much a command is allowed to say.
 *
 * `quiet` is what `--quiet` gives; the rest climb with `-v`, `-vv`, `-vvv`.
 * Every write takes the level it needs, so one command can serve both CI and
 * somebody debugging without choosing once for everybody.
 */
export type Verbosity = 'quiet' | 'normal' | 'verbose' | 'very-verbose' | 'debug'

const LEVELS: Record<Verbosity, number> = {
  quiet: 0,
  normal: 1,
  verbose: 2,
  'very-verbose': 3,
  debug: 4
}

export class Output {
  private level: Verbosity = 'normal'

  /** Set from `-v`/`-vv`/`-vvv`/`--quiet` by the kernel. */
  setVerbosity(level: Verbosity): this {
    this.level = level

    return this
  }

  verbosity(): Verbosity {
    return this.level
  }

  /** Would a write at this level be printed? */
  writes(at: Verbosity = 'normal'): boolean {
    return LEVELS[this.level] >= LEVELS[at]
  }

  isQuiet(): boolean {
    return this.level === 'quiet'
  }

  isVerbose(): boolean {
    return this.writes('verbose')
  }

  isVeryVerbose(): boolean {
    return this.writes('very-verbose')
  }

  isDebug(): boolean {
    return this.writes('debug')
  }

  line(message = '', at: Verbosity = 'normal'): void {
    if (!this.writes(at)) return

    console.log(message)
  }

  info(message: string, at: Verbosity = 'normal'): void {
    if (!this.writes(at)) return

    console.log(pc.cyan(message))
  }

  success(message: string, at: Verbosity = 'normal'): void {
    if (!this.writes(at)) return

    console.log(`${pc.green('✔')} ${message}`)
  }

  comment(message: string, at: Verbosity = 'normal'): void {
    if (!this.writes(at)) return

    console.log(pc.dim(message))
  }

  warn(message: string, at: Verbosity = 'normal'): void {
    if (!this.writes(at)) return

    console.log(`${pc.yellow('⚠')} ${message}`)
  }

  error(message: string): void {
    console.error(`${pc.red('✖')} ${message}`)
  }

  /** `INFO  Created app/Http/Controllers/PostController.ts` */
  tag(label: string, message: string, color: 'green' | 'red' | 'yellow' | 'blue' = 'green'): void {
    const painted = { green: pc.bgGreen, red: pc.bgRed, yellow: pc.bgYellow, blue: pc.bgBlue }[
      color
    ]
    console.log(`${painted(pc.black(` ${label} `))} ${message}`)
  }

  /** Two-column key/value list, as `elvel about` prints. */
  pairs(rows: Array<[string, string]>, width = 28): void {
    for (const [key, value] of rows) {
      const dots = pc.dim('.'.repeat(Math.max(2, width - key.length)))
      console.log(`  ${key} ${dots} ${pc.white(value)}`)
    }
  }

  table(headers: string[], rows: string[][]): void {
    const widths = headers.map((header, column) =>
      Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))
    )

    const renderRow = (cells: string[], paint: (value: string) => string) =>
      cells.map((cell, column) => paint(cell.padEnd(widths[column] ?? 0))).join('  ')

    console.log(renderRow(headers, (value) => pc.bold(pc.dim(value))))
    for (const row of rows) console.log(renderRow(row, (value) => value))
  }

  // ------------------------------------------------------------- interaction

  /**
   * Is there anybody there to answer?
   *
   * Without this every prompt **hangs** where no terminal is attached, which is
   * every CI job and every cron entry. `migrate` in production asks for
   * confirmation, and run from a pipeline it rendered the question and waited for
   * ever — a deploy that holds its lock and never fails is worse than one that
   * fails, because nothing reports it and nobody is told what to do.
   *
   * Answering with the default is also the safe direction: the default for
   * `confirmInProduction` is `false`, so a non-interactive production run refuses
   * rather than proceeding.
   */
  private interactive(): boolean {
    return process.stdin.isTTY === true
  }

  /** Say what was assumed, so a log explains itself later. */
  private assumed<T>(question: string, value: T): T {
    this.comment(`${question} — no terminal attached, assuming ${String(value)}.`)

    return value
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    if (!this.interactive()) return this.assumed(question, defaultValue ?? '')

    const answer = await prompts.text({
      message: question,
      defaultValue,
      placeholder: defaultValue
    })
    return this.unwrap(answer, defaultValue ?? '')
  }

  async secret(question: string): Promise<string> {
    /**
     * Never assumed, and never defaulted to an empty string.
     *
     * A blank password is not an answer, and carrying on with one would be worse
     * than stopping. An option or an environment variable is how a pipeline
     * supplies a secret.
     */
    if (!this.interactive()) {
      throw new Error(`[${question}] needs a terminal. Pass it as an option or an env var instead.`)
    }

    const answer = await prompts.password({ message: question })
    return this.unwrap(answer, '')
  }

  async confirm(question: string, defaultValue = false): Promise<boolean> {
    if (!this.interactive()) return this.assumed(question, defaultValue)

    const answer = await prompts.confirm({ message: question, initialValue: defaultValue })
    return this.unwrap(answer, defaultValue)
  }

  async choice<T extends string>(question: string, choices: T[], defaultValue?: T): Promise<T> {
    if (!this.interactive()) return this.assumed(question, defaultValue ?? (choices[0] as T))

    const answer = await prompts.select({
      message: question,
      // Clack's `Option<T>` is conditional on `T extends Primitive`, which TS
      // cannot resolve while `T` is still generic here.
      options: choices.map((choice) => ({ value: choice, label: choice })) as never,
      initialValue: defaultValue
    })
    return this.unwrap(answer as T | symbol, defaultValue ?? (choices[0] as T))
  }

  spinner(): { start(message?: string): void; stop(message?: string): void } {
    return prompts.spinner()
  }

  /**
   * One step, with a tick and how long it took.
   *
   * The most-used component upstream has, and what makes a long command
   * legible: a wall of `line()` says the same as nothing, and a spinner says
   * only that something is happening.
   */
  async task<T>(label: string, run: () => Promise<T> | T): Promise<T> {
    const started = Date.now()

    try {
      const answer = await run()

      this.line(`${pc.green('✓')} ${label} ${pc.dim(`${Date.now() - started}ms`)}`)

      return answer
    } catch (error) {
      // Printed before the rethrow, so the failing step is named even when the
      // command dies on it.
      this.line(`${pc.red('✗')} ${label} ${pc.dim(`${Date.now() - started}ms`)}`)

      throw error
    }
  }

  bulletList(items: string[], at: Verbosity = 'normal'): void {
    for (const item of items) this.line(`  ${pc.dim('•')} ${item}`, at)
  }

  /**
   * A boxed warning, for the thing somebody must not miss.
   *
   * Distinct from `tag()`, which labels a line. This is for "you are about to
   * do X to production".
   */
  alert(message: string): void {
    if (!this.writes()) return

    const width = Math.min(78, Math.max(message.length + 4, 20))
    const rule = '─'.repeat(width - 2)

    this.line(pc.yellow(`┌${rule}┐`))
    this.line(pc.yellow(`│ ${message.padEnd(width - 4)} │`))
    this.line(pc.yellow(`└${rule}┘`))
  }

  /**
   * Ask, suggesting from a list as they type.
   *
   * Unlike `choice`, the answer need not be one of them — which is the point: a
   * class name, a table, a branch. Clack has no completing text input, so this
   * is a select with the free-text answer as its own option.
   */
  async anticipate(
    question: string,
    suggestions: string[],
    defaultValue?: string
  ): Promise<string> {
    if (suggestions.length === 0) return this.ask(question, defaultValue)

    const other = '__other__'

    const picked = await prompts.select({
      message: question,
      options: [
        ...suggestions.map((suggestion) => ({ value: suggestion, label: suggestion })),
        { value: other, label: 'Something else…' }
      ] as never,
      initialValue: defaultValue
    })

    const answer = this.unwrap(
      picked as string | symbol,
      defaultValue ?? (suggestions[0] as string)
    )

    return answer === other ? this.ask(question, defaultValue) : answer
  }

  /** The same, under the name upstream gives it. */
  askWithCompletion(
    question: string,
    suggestions: string[],
    defaultValue?: string
  ): Promise<string> {
    return this.anticipate(question, suggestions, defaultValue)
  }

  /**
   * A bar with a known total.
   *
   * A spinner says a command is working; this says how far it has got, which is
   * the difference between waiting and wondering. Not a terminal — CI, a log —
   * and it degrades to a line every `every` items, because a progress bar
   * written to a file is thousands of lines of control codes.
   */
  progress(total: number, options: { label?: string; every?: number } = {}): ProgressBar {
    return new ProgressBar(this, total, options)
  }

  /** Wrap an iterable in a bar. The common case, and one call. */
  async withProgressBar<T>(
    items: Iterable<T>,
    run: (item: T) => Promise<unknown> | unknown,
    options: { label?: string } = {}
  ): Promise<void> {
    const all = [...items]
    const bar = this.progress(all.length, options)

    for (const item of all) {
      await run(item)
      bar.advance()
    }

    bar.finish()
  }

  intro(message: string): void {
    prompts.intro(pc.bgCyan(pc.black(` ${message} `)))
  }

  outro(message: string): void {
    prompts.outro(message)
  }

  /** Clack returns a cancel symbol on Ctrl-C; treat that as "abort the command". */
  private unwrap<T>(value: T | symbol, fallback: T): T {
    if (prompts.isCancel(value)) {
      prompts.cancel('Aborted.')
      process.exit(130)
    }
    return (value as T) ?? fallback
  }
}

/**
 * The bar itself.
 *
 * Redrawn in place with a carriage return where stdout is a terminal, and
 * reduced to an occasional line where it is not — a bar written into a log file
 * is thousands of lines of control codes nobody can read.
 */
export class ProgressBar {
  private current = 0
  private readonly startedAt = Date.now()
  private readonly interactive = process.stdout.isTTY === true
  private readonly every: number

  constructor(
    private readonly output: Output,
    private readonly total: number,
    private readonly options: { label?: string; every?: number } = {}
  ) {
    // One line per percent, at most, when nobody is watching it move.
    this.every = options.every ?? Math.max(1, Math.floor(total / 100))
  }

  advance(by = 1): void {
    this.current = Math.min(this.total, this.current + by)

    if (this.output.isQuiet()) return

    if (!this.interactive) {
      if (this.current % this.every === 0 || this.current === this.total) {
        this.output.line(`${this.label()} ${this.current}/${this.total}`)
      }

      return
    }

    process.stdout.write(`\r${this.render()}`)
  }

  finish(): void {
    if (this.output.isQuiet()) return

    if (this.interactive) process.stdout.write(`\r${this.render()}\n`)
    else if (this.current % this.every !== 0) {
      this.output.line(`${this.label()} ${this.current}/${this.total}`)
    }
  }

  private label(): string {
    return this.options.label ?? 'Progress'
  }

  private render(): string {
    const share = this.total === 0 ? 1 : this.current / this.total
    const width = 30
    const filled = Math.round(share * width)

    const elapsed = Date.now() - this.startedAt
    const remaining = share === 0 ? 0 : Math.round((elapsed / share) * (1 - share))

    return `${this.label()} [${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${this.current}/${this.total} ${pc.dim(`${Math.round(share * 100)}% · ~${Math.ceil(remaining / 1000)}s left`)}`
  }
}
