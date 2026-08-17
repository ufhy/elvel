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

  /** Run another command from inside this one — Artisan's `$this->call()`. */
  protected call(command: string, argv: string[] = []): Promise<number> {
    return this.runner(command, argv)
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
