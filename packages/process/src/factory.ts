import { PendingProcess, type ProcessOptions } from './pending.ts'
import { Pipe, Pool } from './pool.ts'
import { ProcessResult } from './result.ts'

/** How a fake is described: a pattern, and what to answer with. */
export type FakeDefinition = {
  output?: string
  errorOutput?: string
  exitCode?: number
  signal?: string
}

type Matcher = string | RegExp

/**
 * Does `command` match — exact, `*` wildcard, or a regular expression?
 *
 * `*` rather than a bare substring, so `git push` cannot be answered by a fake
 * registered for `git`. A fake that matches more than it meant to is a test that
 * passes for the wrong reason.
 */
function matches(command: string, pattern: Matcher): boolean {
  if (pattern instanceof RegExp) return pattern.test(command)
  if (!pattern.includes('*')) return command === pattern

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')

  return new RegExp(`^${escaped}$`).test(command)
}

/**
 * Runs commands — Laravel's `Process` factory.
 *
 * ```ts
 * const result = await process().run(['git', 'rev-parse', 'HEAD'])
 * result.throw()
 * ```
 *
 * Under a fake, nothing is spawned and everything is recorded:
 *
 * ```ts
 * process().fake({ 'git *': { output: 'abc123' } })
 * ```
 */
export class ProcessManager {
  private fakes: Array<{ pattern: Matcher; answers: FakeDefinition[] }> = []
  private faking = false
  private preventStray = false
  private readonly recorded: Array<{ command: string; result: ProcessResult }> = []

  /** A configured starting point; every option returns a new one. */
  private base(): PendingProcess {
    return new PendingProcess(
      {},
      this.faking ? (command) => this.answer(command) : undefined,
      (command, result) => {
        this.recorded.push({ command, result })
      },
      (command) => this.guardStray(command)
    )
  }

  run(command: string | string[]): Promise<ProcessResult> {
    return this.base().run(command)
  }

  start(command: string | string[]) {
    return this.base().start(command)
  }

  path(cwd: string): PendingProcess {
    return this.base().path(cwd)
  }

  env(env: Record<string, string | undefined>): PendingProcess {
    return this.base().env(env)
  }

  timeout(ms: number): PendingProcess {
    return this.base().timeout(ms)
  }

  idleTimeout(ms: number): PendingProcess {
    return this.base().idleTimeout(ms)
  }

  forever(): PendingProcess {
    return this.base().forever()
  }

  inherit(): PendingProcess {
    return this.base().inherit()
  }

  /** Keep the raw bytes as well as the text — see `PendingProcess.binary`. */
  binary(): PendingProcess {
    return this.base().binary()
  }

  input(input: string | Uint8Array): PendingProcess {
    return this.base().input(input)
  }

  onOutput(handler: ProcessOptions['onOutput'] & {}): PendingProcess {
    return this.base().onOutput(handler)
  }

  /** Build a pool: `pool((p) => p.add('a').add('b')).run()`. */
  pool(build: (pool: Pool) => void): Pool {
    const pool = new Pool(this.base())
    build(pool)

    return pool
  }

  /** Run several at once, unnamed, and get the results in declaration order. */
  concurrently(commands: Array<string | string[]>) {
    return this.pool((pool) => {
      for (const command of commands) pool.add(command)
    }).run()
  }

  /** Build a pipe: each command's stdout becomes the next one's stdin. */
  pipe(build: (pipe: Pipe) => void): Pipe {
    const pipe = new Pipe(this.base())
    build(pipe)

    return pipe
  }

  // ------------------------------------------------------------------ fakes

  /**
   * Answer instead of spawning.
   *
   * A pattern may be given a list, which is consumed in order — for a command
   * that is expected to be run more than once and answer differently, such as a
   * poll that fails until it succeeds. The last answer repeats once the list runs
   * out, rather than falling through to a real spawn.
   */
  fake(definitions: Record<string, FakeDefinition | FakeDefinition[] | string> = {}): this {
    this.faking = true

    for (const [pattern, definition] of Object.entries(definitions)) {
      const answers = (Array.isArray(definition) ? definition : [definition]).map((one) =>
        typeof one === 'string' ? { output: one } : one
      )

      this.fakes.push({ pattern, answers })
    }

    return this
  }

  /** A sequence for one pattern, consumed in order. */
  sequence(pattern: Matcher, answers: Array<FakeDefinition | string>): this {
    this.faking = true
    this.fakes.push({
      pattern,
      answers: answers.map((one) => (typeof one === 'string' ? { output: one } : one))
    })

    return this
  }

  /**
   * Fail loudly on a command no fake matched.
   *
   * Without it, an unmatched command runs for real — which under a fake means a
   * test that was meant to be hermetic quietly touches the machine. Laravel
   * calls this `preventStrayProcesses` and it is worth turning on by default in
   * a suite.
   */
  preventStrayProcesses(prevent = true): this {
    this.preventStray = prevent

    return this
  }

  private guardStray(command: string): void {
    if (!this.faking || !this.preventStray) return

    throw new Error(
      `The command [${command}] was run while processes are faked, and no fake matched it. ` +
        `Add one with fake(), or allow it with preventStrayProcesses(false).`
    )
  }

  private answer(command: string): ProcessResult | undefined {
    const fake = this.fakes.find((one) => matches(command, one.pattern))
    if (!fake) return undefined

    // The last answer repeats: a sequence that runs dry should not silently
    // become a real spawn halfway through a test.
    const definition =
      fake.answers.length > 1 ? (fake.answers.shift() as FakeDefinition) : fake.answers[0]

    return new ProcessResult(
      command,
      definition?.exitCode ?? 0,
      definition?.output ?? '',
      definition?.errorOutput ?? '',
      definition?.signal
    )
  }

  stopFaking(): this {
    this.faking = false
    this.fakes = []
    this.recorded.length = 0

    return this
  }

  get isFaking(): boolean {
    return this.faking
  }

  /** Everything run, faked or not. */
  ran(): Array<{ command: string; result: ProcessResult }> {
    return [...this.recorded]
  }

  // ------------------------------------------------------------- assertions

  assertRan(pattern: Matcher): this {
    const found = this.recorded.some((one) => matches(one.command, pattern))
    if (!found) {
      throw new Error(
        `Expected a command matching ${String(pattern)} to have run. Ran: ` +
          (this.recorded.length === 0
            ? '(nothing)'
            : this.recorded.map((one) => `[${one.command}]`).join(', '))
      )
    }

    return this
  }

  assertRanTimes(pattern: Matcher, times: number): this {
    const count = this.recorded.filter((one) => matches(one.command, pattern)).length
    if (count !== times) {
      throw new Error(`Expected ${String(pattern)} to have run ${times} time(s), it ran ${count}.`)
    }

    return this
  }

  assertNotRan(pattern: Matcher): this {
    const found = this.recorded.find((one) => matches(one.command, pattern))
    if (found)
      throw new Error(
        `Expected no command matching ${String(pattern)}, but [${found.command}] ran.`
      )

    return this
  }

  assertNothingRan(): this {
    if (this.recorded.length > 0) {
      throw new Error(
        `Expected nothing to run, but these did: ${this.recorded.map((one) => `[${one.command}]`).join(', ')}`
      )
    }

    return this
  }
}
