import { InvokedProcess } from './invoked.ts'
import { ProcessResult } from './result.ts'

/** How the command is written: an array runs directly, a string runs in a shell. */
export type Command = string | string[]

/** Called with each chunk as it arrives, for a long-running command. */
export type OutputHandler = (chunk: string, stream: 'stdout' | 'stderr') => void

export type ProcessOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  input?: string | Uint8Array
  timeout?: number
  idleTimeout?: number
  quiet?: boolean
  inherit?: boolean
  /** Keep the bytes as they arrived, for output that is not text. */
  binary?: boolean
  onOutput?: OutputHandler
}

/** Set by a fake to answer instead of spawning. */
export type FakeHandler = (command: string) => ProcessResult | undefined

/**
 * A command being configured — Laravel's `PendingProcess`.
 *
 * Immutable, like `TestRequest`: every option returns a new instance, so a
 * configured base (a working directory, an environment) can be reused without
 * one call bleeding into the next.
 *
 * ```ts
 * const git = process().path(repo).timeout(30_000)
 * await git.run('git rev-parse HEAD')
 * await git.run(['git', 'status', '--porcelain'])
 * ```
 */
export class PendingProcess {
  constructor(
    private readonly options: ProcessOptions = {},
    private readonly fakeHandler?: FakeHandler,
    private readonly recorder?: (command: string, result: ProcessResult) => void,
    private readonly onStray?: (command: string) => void
  ) {}

  private derive(changes: Partial<ProcessOptions>): PendingProcess {
    return new PendingProcess(
      { ...this.options, ...changes },
      this.fakeHandler,
      this.recorder,
      this.onStray
    )
  }

  /** Where it runs. Defaults to the process's own working directory. */
  path(cwd: string): PendingProcess {
    return this.derive({ cwd })
  }

  /**
   * The environment.
   *
   * Merged onto the parent's, not replacing it: a command that loses `PATH`
   * fails in a way that reads like the binary is missing.
   */
  env(env: Record<string, string | undefined>): PendingProcess {
    return this.derive({ env: { ...this.options.env, ...env } })
  }

  /** Killed after this many milliseconds. `0` disables it. */
  timeout(ms: number): PendingProcess {
    return this.derive({ timeout: ms === 0 ? undefined : ms })
  }

  /** No timeout at all — for a command whose length is not knowable. */
  forever(): PendingProcess {
    return this.derive({ timeout: undefined, idleTimeout: undefined })
  }

  /**
   * Killed after this long *without output*.
   *
   * The useful timeout for something that streams: a build that is still
   * printing is still working, however long it has been running, while one that
   * has said nothing for two minutes has usually hung.
   */
  idleTimeout(ms: number): PendingProcess {
    return this.derive({ idleTimeout: ms })
  }

  /** Written to the command's stdin, which is then closed. */
  input(input: string | Uint8Array): PendingProcess {
    return this.derive({ input })
  }

  /**
   * Send output straight to this process's own stdout and stderr.
   *
   * Nothing is collected, so the result's `output` is empty — that is the trade,
   * and it is the right one for a long task whose logging should reach wherever
   * the parent's does rather than a buffer nobody reads.
   */
  inherit(): PendingProcess {
    return this.derive({ inherit: true })
  }

  /**
   * Keep the raw bytes as well as the text — for output that is not text.
   *
   * `output` is a string, and a string in JavaScript is UTF-16: decoding a PNG
   * or a tarball through it replaces every invalid sequence with U+FFFD, and the
   * bytes are gone by the time anybody notices. PHP has no such problem, which is
   * why Laravel needs no equivalent of this — its strings are byte arrays.
   *
   * Off by default because it costs a second copy of the output in memory, and
   * almost everything a process prints is text.
   *
   * ```ts
   * const result = await process().binary().run(['git', 'cat-file', 'blob', sha])
   * await Bun.write('blob.bin', result.bytes)
   * ```
   */
  binary(): PendingProcess {
    return this.derive({ binary: true })
  }

  /** Collect output but do not stream it anywhere. The default. */
  quietly(): PendingProcess {
    return this.derive({ quiet: true, onOutput: undefined })
  }

  /** Called with every chunk as it arrives. */
  onOutput(handler: OutputHandler): PendingProcess {
    return this.derive({ onOutput: handler, quiet: false })
  }

  /** Run it, and wait. */
  async run(command: Command, onOutput?: OutputHandler): Promise<ProcessResult> {
    const invoked = this.start(command, onOutput)

    return invoked.wait()
  }

  /**
   * Start it, and carry on.
   *
   * The result is an `InvokedProcess` — a handle that can be signalled, polled
   * for output, or waited on later.
   */
  start(command: Command, onOutput?: OutputHandler): InvokedProcess {
    const text = PendingProcess.describe(command)
    const handler = onOutput ?? this.options.onOutput

    const faked = this.fakeHandler?.(text)
    if (faked) {
      const result = new ProcessResult(
        text,
        faked.exitCode,
        faked.output,
        faked.errorOutput,
        faked.signal,
        faked.timedOut,
        faked.timeout
      )

      if (handler) {
        if (result.output !== '') handler(result.output, 'stdout')
        if (result.errorOutput !== '') handler(result.errorOutput, 'stderr')
      }

      this.recorder?.(text, result)

      return InvokedProcess.faked(result)
    }

    this.onStray?.(text)

    const invoked = InvokedProcess.spawn(text, PendingProcess.argv(command), this.options, handler)
    if (this.recorder) invoked.onFinished((result) => this.recorder?.(text, result))

    return invoked
  }

  /**
   * The argv actually executed.
   *
   * A string goes through `sh -c`, which is what makes `|`, `&&` and `$VAR`
   * work — and what makes an interpolated string dangerous. An array is passed
   * to `execvp` untouched, so no shell ever sees it; that is the form to use for
   * anything built from input.
   */
  static argv(command: Command): string[] {
    return Array.isArray(command) ? command : ['sh', '-c', command]
  }

  /** How the command is named in a result, an error, or a fake's matcher. */
  static describe(command: Command): string {
    return Array.isArray(command) ? command.join(' ') : command
  }
}
