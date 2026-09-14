import type { CommandContract } from '@elvel/contracts'
import type { Application } from '@elvel/core'
import { Output } from './output.ts'
import {
  type CommandDefinition,
  type ParsedInput,
  parseInput,
  parseSignature
} from './signature.ts'

export type CommandRunner = (command: string, argv?: string[]) => Promise<number>

/**
 * Base command. Subclasses declare a static `signature` + `description` and
 * implement `handle()`.
 *
 * ```ts
 * export class PublishPost extends Command {
 *   static override signature = 'post:publish {id} {--force : Skip confirmation}'
 *   static override description = 'Publish a post'
 *
 *   async handle() {
 *     const id = this.argument('id')
 *     if (!this.option('force') && !(await this.confirm(`Publish #${id}?`))) return 1
 *     this.success(`Published #${id}`)
 *   }
 * }
 * ```
 */
export abstract class Command implements CommandContract {
  static signature = ''
  static description = ''

  /**
   * May this command be run with `--isolated`?
   *
   * Declared per command because the lock is only meaningful where a second
   * copy would do damage — `migrate` on every node of a deploy at once, a
   * nightly import started twice by an overlapping cron. Marking everything
   * isolatable would invite locks on commands where refusing to run is worse
   * than running twice.
   */
  static isolatable = false

  /**
   * Other names this command answers to.
   *
   * How a renamed command keeps working: the old name stays registered and the
   * scripts that call it do not have to be found first.
   */
  static aliases: string[] = []

  /**
   * Keep it out of `elvel list`.
   *
   * For internal plumbing — the command a scheduler invokes for its own
   * bookkeeping — which is noise in the list a person reads and still has to be
   * runnable.
   */
  static hidden = false

  /**
   * Refuse to run in production without `--force`.
   *
   * The guard lived on `MigrationCommand` alone, so `queue:clear` and anything
   * an application wrote had to reimplement it.
   */
  static destructive = false

  /**
   * Remove it from the application entirely.
   *
   * Stronger than `destructive`, and different in kind: a prohibited command
   * cannot be run at all, `--force` included. What keeps `db:wipe` off a
   * production host rather than one confirmation away from it.
   */
  static prohibited = false

  /**
   * Does this command leave something running after `handle()` returns?
   *
   * `serve` does: the server holds the event loop, so the process must stay
   * alive after the command is finished with it. Every other command is done
   * when it returns, and the entry point exits on its behalf.
   *
   * Declared rather than inferred, because the alternative is a process that
   * hangs. Left to guess by "is anything still holding the loop?", a command
   * that forgot to close a database pool would never exit and would look
   * identical to this.
   *
   * Why a command may not simply never return: `bun --hot` will not re-evaluate
   * a module graph whose entry point is still evaluating, and the entry awaits
   * this. Measured — with `serve` returning `new Promise(() => {})`, every edit
   * to a view, a controller or a route needed a restart, and the reload said
   * nothing about why it had done nothing.
   */
  static holdsProcess = false

  protected readonly output = new Output()

  protected app!: Application
  protected input: ParsedInput = { arguments: {}, options: {} }
  protected runner: CommandRunner = async () => 1

  get signature(): string {
    return (this.constructor as typeof Command).signature
  }

  get description(): string {
    return (this.constructor as typeof Command).description
  }

  get definition(): CommandDefinition {
    return parseSignature(this.signature)
  }

  get name(): string {
    return this.definition.name
  }

  /**
   * biome-ignore lint/suspicious/noConfusingVoidType: `undefined` here would be a
   * breaking change for anybody writing a command. This is the signature they
   * implement, and `async handle(): Promise<void>` — the obvious way to write one
   * that has no exit code to report — is assignable to `void` and not to
   * `undefined`, because TypeScript allows assignment *to* void and not from it.
   */
  abstract handle(): Promise<number | void> | number | void

  /** Called by the kernel before `handle()`. */
  bind(app: Application, argv: string[], runner: CommandRunner): this {
    this.app = app
    this.input = parseInput(argv, this.definition)
    this.runner = runner
    return this
  }

  // -------------------------------------------------------------------- input

  protected argument(key: string): string {
    const value = this.input.arguments[key]
    if (Array.isArray(value)) return value.join(' ')
    return value ?? ''
  }

  protected arrayArgument(key: string): string[] {
    const value = this.input.arguments[key]
    if (Array.isArray(value)) return value
    return value === undefined ? [] : [value]
  }

  protected option(key: string): string | boolean | undefined {
    const value = this.input.options[key]
    return Array.isArray(value) ? value.join(',') : value
  }

  protected flag(key: string): boolean {
    return this.input.options[key] === true
  }

  protected stringOption(key: string, fallback = ''): string {
    const value = this.input.options[key]
    return typeof value === 'string' ? value : fallback
  }

  protected arrayOption(key: string): string[] {
    const value = this.input.options[key]
    if (Array.isArray(value)) return value
    return typeof value === 'string' ? [value] : []
  }

  /** Run another command from inside this one. */
  protected call(command: string, argv: string[] = []): Promise<number> {
    return this.runner(command, argv)
  }

  /**
   * The same, with its output suppressed.
   *
   * A command that runs three others should not print three banners, and before
   * this the only choice was for the inner command to be quiet for everybody.
   */
  protected async callSilent(command: string, argv: string[] = []): Promise<number> {
    return this.call(command, [...argv, '--quiet'])
  }

  // --------------------------------------------------------------- verbosity

  protected isQuiet(): boolean {
    return this.output.isQuiet()
  }

  protected isVerbose(): boolean {
    return this.output.isVerbose()
  }

  protected isVeryVerbose(): boolean {
    return this.output.isVeryVerbose()
  }

  protected isDebug(): boolean {
    return this.output.isDebug()
  }

  // ----------------------------------------------------------------- signals

  /** What `trap()` registered, so `untrap()` can take them off again. */
  private trapped: Array<[NodeJS.Signals, () => void]> = []

  /**
   * Handle an interrupt.
   *
   * `SIGINT`/`SIGTERM` were wired with raw `process.on` in three commands, and
   * nothing an application's own long-running command could reach. Getting
   * shutdown right — finish the unit of work, stop taking new work, exit with
   * the right code — is exactly the thing to write once.
   *
   * A **second** interrupt exits immediately with 130. Somebody pressing Ctrl-C
   * twice means it now, and a graceful shutdown that cannot itself be
   * interrupted is a process that has to be killed.
   */
  protected trap(handler: () => void, signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']): this {
    for (const signal of signals) {
      let asked = false

      const listener = (): void => {
        if (asked) {
          process.exit(130)
        }

        asked = true
        handler()
      }

      process.on(signal, listener)
      this.trapped.push([signal, listener])
    }

    return this
  }

  /** Take the handlers off — for a command that keeps running afterwards. */
  protected untrap(): this {
    for (const [signal, listener] of this.trapped) process.off(signal, listener)

    this.trapped = []

    return this
  }

  // -------------------------------------------------------------- production

  /**
   * Stop unless the operator meant it.
   *
   * `--force` is the opt-out, and it is the only one: a prompt that a CI job
   * cannot answer would otherwise make every deploy hang instead of failing.
   */
  protected async confirmInProduction(warning?: string): Promise<boolean> {
    if (!this.app.isProduction()) return true
    if (this.flag('force')) return true

    if (!process.stdout.isTTY) {
      this.error(
        `[${this.name}] refuses to run in production without --force. Nothing has been changed.`
      )

      return false
    }

    this.output.alert(warning ?? `${this.name} is about to run against production.`)

    return this.confirm('Do you really wish to run this command?', false)
  }

  // ------------------------------------------------------------------- output

  protected line(message = ''): void {
    this.output.line(message)
  }

  protected info(message: string): void {
    this.output.info(message)
  }

  protected success(message: string): void {
    this.output.success(message)
  }

  protected comment(message: string): void {
    this.output.comment(message)
  }

  protected warn(message: string): void {
    this.output.warn(message)
  }

  protected error(message: string): void {
    this.output.error(message)
  }

  protected table(headers: string[], rows: string[][]): void {
    this.output.table(headers, rows)
  }

  /** One step, with a tick and how long it took. */
  protected task<T>(label: string, run: () => Promise<T> | T): Promise<T> {
    return this.output.task(label, run)
  }

  protected bulletList(items: string[]): void {
    this.output.bulletList(items)
  }

  /** The boxed warning, for the thing somebody must not miss. */
  protected alert(message: string): void {
    this.output.alert(message)
  }

  /** A bar with a known total — see `Output.withProgressBar`. */
  protected withProgressBar<T>(
    items: Iterable<T>,
    run: (item: T) => Promise<unknown> | unknown,
    options: { label?: string } = {}
  ): Promise<void> {
    return this.output.withProgressBar(items, run, options)
  }

  protected anticipate(
    question: string,
    suggestions: string[],
    defaultValue?: string
  ): Promise<string> {
    return this.output.anticipate(question, suggestions, defaultValue)
  }

  protected ask(question: string, defaultValue?: string): Promise<string> {
    return this.output.ask(question, defaultValue)
  }

  protected secret(question: string): Promise<string> {
    return this.output.secret(question)
  }

  protected confirm(question: string, defaultValue = false): Promise<boolean> {
    return this.output.confirm(question, defaultValue)
  }

  protected choice<T extends string>(question: string, choices: T[], defaultValue?: T): Promise<T> {
    return this.output.choice(question, choices, defaultValue)
  }
}
