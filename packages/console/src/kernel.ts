import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Application } from '@elyvel/core'
import pc from 'picocolors'
import type { Command } from './command.ts'
import { Output } from './output.ts'
import { formatUsage, InputParseError, missingArguments, parseSignature } from './signature.ts'

export type CommandConstructor = (new () => Command) & {
  signature: string
  description: string
}

/**
 * Console kernel — Artisan itself.
 *
 * Commands are registered by service providers (framework commands) or
 * discovered from `app/Console/Commands` (application commands).
 */
export class Kernel {
  private readonly commands = new Map<string, CommandConstructor>()
  private readonly output = new Output()

  constructor(private readonly app: Application) {}

  register(...commands: CommandConstructor[]): this {
    for (const command of commands) {
      const name = parseSignature(command.signature).name
      if (name === '') {
        throw new Error(`Command ${command.name} has an empty signature.`)
      }
      this.commands.set(name, command)
    }
    return this
  }

  /** Auto-discover commands from a directory of modules. */
  async loadFrom(directory: string): Promise<this> {
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return this
    }

    for (const entry of entries.sort()) {
      if (!/\.(ts|js|mts|mjs)$/.test(entry) || entry.endsWith('.d.ts')) continue

      const module = (await import(join(directory, entry))) as Record<string, unknown>
      for (const exported of Object.values(module)) {
        if (this.looksLikeCommand(exported)) this.register(exported)
      }
    }

    return this
  }

  all(): CommandConstructor[] {
    return [...this.commands.values()]
  }

  async run(argv: string[] = Bun.argv.slice(2)): Promise<number> {
    const [name, ...rest] = argv

    if (name === undefined || name === 'list' || name === '--help' || name === '-h') {
      this.renderList()
      return 0
    }

    if (name === '--version' || name === '-V') {
      this.output.line(`Elyvel ${this.app.config.get('app.version', '0.0.1')}`)
      return 0
    }

    const command = this.commands.get(name)
    if (!command) {
      this.output.error(`Command "${name}" is not defined.`)
      this.suggest(name)
      return 1
    }

    if (rest.includes('--help') || rest.includes('-h')) {
      this.renderHelp(command)
      return 0
    }

    /**
     * `--isolated`: run only if no other copy holds the lock.
     *
     * Exits **0** when it cannot, which looks wrong and is not: a deploy runs
     * `migrate --isolated` on every node, and exactly one of them should do the
     * work while the others carry on. A failure code there would fail the
     * deploy on every node but one.
     */
    if (rest.includes('--isolated')) {
      const released = await this.acquireIsolationLock(name, command)

      if (!released) return 0

      try {
        return await this.execute(
          command,
          rest.filter((token) => token !== '--isolated')
        )
      } finally {
        await released()
      }
    }

    return this.execute(command, rest)
  }

  /** Run one resolved command, with its missing arguments filled in. */
  private async execute(command: CommandConstructor, rest: string[]): Promise<number> {
    try {
      const supplied = await this.promptForMissing(command, rest)

      const instance = new command().bind(this.app, supplied, (nested, nestedArgv = []) =>
        this.run([nested, ...nestedArgv])
      )
      const status = await instance.handle()
      return typeof status === 'number' ? status : 0
    } catch (error) {
      if (error instanceof InputParseError) {
        this.output.error(error.message)
        this.output.line()
        this.renderHelp(command)
        return 1
      }

      this.output.error(error instanceof Error ? error.message : String(error))
      if (this.app.hasDebugModeEnabled() && error instanceof Error) {
        this.output.comment(error.stack ?? '')
      }
      return 1
    }
  }

  /**
   * Take the isolation lock, returning how to release it — or nothing.
   *
   * The lock lives in the cache, because the point is to exclude a *different
   * process*, often on a different machine. Without a cache store there is
   * nothing to exclude with, and saying so beats running anyway while claiming
   * to be isolated.
   */
  private async acquireIsolationLock(
    name: string,
    command: CommandConstructor
  ): Promise<(() => Promise<void>) | undefined> {
    if (!(command as { isolatable?: boolean }).isolatable) {
      this.output.error(`The ${name} command cannot be run with --isolated.`)

      return undefined
    }

    if (!this.app.bound('cache')) {
      this.output.error('--isolated needs a cache store. Register CacheServiceProvider.')

      return undefined
    }

    const store = this.app.make('cache').store()
    const key = `elyvel:command:${name}`

    // An expiry, not a bare flag: a process killed mid-command must not lock the
    // command out for ever, and an hour is longer than any command should be.
    if (!(await store.add(key, new Date().toISOString(), 3600))) {
      this.output.comment(`The ${name} command is already running elsewhere.`)

      return undefined
    }

    return async () => {
      await store.forget(key)
    }
  }

  /**
   * Ask for the required arguments that were not given.
   *
   * `artisan make:model` with nothing after it used to fail with
   * `missing: "name"`, which is correct and useless — the person already knows
   * they left it out. Asking is what every generator in every other framework
   * does, and it is the difference between reading the help and getting on with
   * it.
   *
   * Only when a terminal is attached and `--no-interaction` was not passed: in
   * CI a prompt is not a question, it is a hang.
   */
  private async promptForMissing(command: CommandConstructor, argv: string[]): Promise<string[]> {
    if (argv.includes('--no-interaction') || argv.includes('-n')) {
      return argv.filter((token) => token !== '--no-interaction' && token !== '-n')
    }

    if (!process.stdout.isTTY || !process.stdin.isTTY) return argv

    const definition = parseSignature(command.signature)
    const missing = missingArguments(definition, argv)

    if (missing.length === 0) return argv

    const answers: string[] = []
    const labels = (command as { prompts?: Record<string, string> }).prompts ?? {}

    for (const argument of missing) {
      // The argument's own description makes the better question when there is
      // one — it is the sentence the author already wrote about it.
      const question =
        labels[argument.name] ??
        (argument.description ? `${argument.description}?` : `What is the ${argument.name}?`)

      answers.push(await this.output.ask(question))
    }

    return [...argv, ...answers]
  }

  private renderList(): void {
    this.output.line()
    this.output.line(
      `${pc.bold(this.app.config.get('app.name', 'Elyvel'))} ${pc.dim(
        `(${this.app.environment()})`
      )}`
    )
    this.output.line()
    this.output.line(pc.bold('Usage:'))
    this.output.line('  bun artisan <command> [options]')
    this.output.line()

    const groups = new Map<string, CommandConstructor[]>()
    for (const command of this.all()) {
      const name = parseSignature(command.signature).name
      const group = name.includes(':') ? (name.split(':')[0] as string) : ''
      const bucket = groups.get(group) ?? []
      bucket.push(command)
      groups.set(group, bucket)
    }

    const sorted = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    const width = Math.max(
      ...this.all().map((command) => parseSignature(command.signature).name.length)
    )

    for (const [group, commands] of sorted) {
      this.output.line(pc.bold(group === '' ? 'Available commands:' : ` ${group}`))
      for (const command of commands.sort((left, right) =>
        left.signature.localeCompare(right.signature)
      )) {
        const name = parseSignature(command.signature).name
        this.output.line(`  ${pc.green(name.padEnd(width))}  ${pc.dim(command.description)}`)
      }
      this.output.line()
    }
  }

  private renderHelp(command: CommandConstructor): void {
    const definition = parseSignature(command.signature)

    this.output.line()
    this.output.line(pc.bold('Description:'))
    this.output.line(`  ${command.description}`)
    this.output.line()
    this.output.line(pc.bold('Usage:'))
    this.output.line(`  bun artisan ${formatUsage(definition)}`)

    if (definition.arguments.length > 0) {
      this.output.line()
      this.output.line(pc.bold('Arguments:'))
      const width = Math.max(...definition.arguments.map((argument) => argument.name.length))
      for (const argument of definition.arguments) {
        const suffix =
          argument.default === undefined ? '' : pc.dim(` [default: ${argument.default}]`)
        this.output.line(
          `  ${pc.green(argument.name.padEnd(width))}  ${argument.description}${suffix}`
        )
      }
    }

    if (definition.options.length > 0) {
      this.output.line()
      this.output.line(pc.bold('Options:'))
      const labels = definition.options.map((option) => {
        const shortcut = option.shortcut ? `-${option.shortcut}, ` : ''
        const value = option.acceptsValue ? '=VALUE' : ''
        return `${shortcut}--${option.name}${value}`
      })
      const width = Math.max(...labels.map((label) => label.length))
      definition.options.forEach((option, index) => {
        this.output.line(
          `  ${pc.green((labels[index] as string).padEnd(width))}  ${option.description}`
        )
      })
    }

    this.output.line()
  }

  private suggest(name: string): void {
    const candidates = this.all()
      .map((command) => parseSignature(command.signature).name)
      .filter(
        (candidate) => candidate.includes(name) || name.includes(candidate.split(':')[0] ?? '')
      )

    if (candidates.length === 0) return

    this.output.line()
    this.output.comment('Did you mean one of these?')
    for (const candidate of candidates.slice(0, 5)) this.output.line(`  ${pc.green(candidate)}`)
  }

  private looksLikeCommand(value: unknown): value is CommandConstructor {
    if (typeof value !== 'function') return false

    const candidate = value as unknown as {
      signature?: unknown
      prototype?: { handle?: unknown }
    }

    return (
      typeof candidate.signature === 'string' &&
      candidate.signature !== '' &&
      typeof candidate.prototype?.handle === 'function'
    )
  }
}
