import type { InvokedProcess } from './invoked.ts'
import type { Command, PendingProcess } from './pending.ts'
import type { ProcessResult } from './result.ts'

/** What a pool or pipe is handed to build each step. */
export type Builder = (process: PendingProcess) => PendingProcess

type Step = { key: string; command: Command; configure?: Builder }

/**
 * Several commands at once — Laravel's `Pool`.
 *
 * Results come back keyed, in the order the steps were declared, not the order
 * they finished. A pool whose results arrived in completion order would be
 * unusable in an assertion.
 */
export class Pool {
  private readonly steps: Step[] = []

  constructor(private readonly base: PendingProcess) {}

  /** Add a command, optionally naming it and configuring it. */
  add(command: Command, key?: string, configure?: Builder): this {
    this.steps.push({ key: key ?? String(this.steps.length), command, configure })

    return this
  }

  /** Start them all, and hand back the handles without waiting. */
  start(): Record<string, InvokedProcess> {
    return Object.fromEntries(
      this.steps.map((step) => [
        step.key,
        (step.configure?.(this.base) ?? this.base).start(step.command)
      ])
    )
  }

  /**
   * Run them all and wait.
   *
   * `Promise.all` would reject on the first failure and abandon the rest still
   * running; every step is waited on, and failure is reported in the results.
   */
  async run(): Promise<PoolResults> {
    const invoked = this.start()
    const entries = Object.entries(invoked)
    const settled = await Promise.all(entries.map(([, one]) => one.wait()))

    return new PoolResults(
      Object.fromEntries(entries.map(([key], index) => [key, settled[index] as ProcessResult]))
    )
  }
}

/** The results of a pool, keyed as they were declared. */
export class PoolResults {
  constructor(readonly results: Record<string, ProcessResult>) {}

  get(key: string): ProcessResult | undefined {
    return this.results[key]
  }

  all(): ProcessResult[] {
    return Object.values(this.results)
  }

  successful(): boolean {
    return this.all().every((result) => result.successful())
  }

  failed(): ProcessResult[] {
    return this.all().filter((result) => result.failed())
  }

  /** Throw on the first failure, naming which step it was. */
  throw(): this {
    for (const [key, result] of Object.entries(this.results)) {
      if (result.failed()) {
        try {
          result.throw()
        } catch (error) {
          throw new Error(`Pool step [${key}] failed. ${(error as Error).message}`, {
            cause: error
          })
        }
      }
    }

    return this
  }
}

/**
 * One command's output into the next — Laravel's `Pipe`.
 *
 * Piped in the parent rather than through a shell `|`, so each step's exit code
 * and stderr survive. A shell pipeline reports only the last command's status,
 * which is why `set -o pipefail` exists and why this does not need it.
 */
export class Pipe {
  private readonly steps: Step[] = []

  constructor(private readonly base: PendingProcess) {}

  add(command: Command, key?: string, configure?: Builder): this {
    this.steps.push({ key: key ?? String(this.steps.length), command, configure })

    return this
  }

  /** Run each step, feeding the previous one's stdout in. Stops on failure. */
  async run(): Promise<ProcessResult> {
    let carried = ''
    let last: ProcessResult | undefined

    for (const step of this.steps) {
      const configured = step.configure?.(this.base) ?? this.base
      last = await configured.input(carried).run(step.command)

      // A failed step stops the pipe: feeding its (probably empty) output into
      // the next one turns one clear failure into a confusing second.
      if (last.failed()) return last

      carried = last.output
    }

    if (!last) throw new Error('The pipe has no steps. Add one with add().')

    return last
  }
}
