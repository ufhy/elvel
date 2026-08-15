import type { OutputHandler, ProcessOptions } from './pending.ts'
import { ProcessResult } from './result.ts'

/** How long to keep draining after the child has gone. */
const FLUSH_GRACE_MS = 250

/**
 * A command that is running — Laravel's `InvokedProcess`.
 *
 * Two things here are not obvious, and both were found by tests that hung.
 *
 * **Output is drained as it arrives**, not read at the end. Reading at the end
 * looks simpler and deadlocks: a command that fills the pipe buffer blocks
 * writing to it while the parent blocks waiting for it to exit.
 *
 * **The command is its own process group**, and killing means killing the group.
 * `sh -c 'echo hi; sleep 5'` forks, so signalling the shell leaves `sleep`
 * running *and holding the pipe open* — the drain then never finishes and a
 * timeout hangs forever rather than timing out. Spawning detached puts the whole
 * tree in one group that `kill(-pid)` reaches. Bun's own `timeout` option is not
 * used for the same reason: it signals the direct child only.
 */
export class InvokedProcess {
  private out = ''
  private err = ''
  private finished: Promise<ProcessResult>
  private listeners: Array<(result: ProcessResult) => void> = []
  private child?: Bun.Subprocess<'pipe' | 'ignore', 'pipe', 'pipe'>
  private idleTimer?: ReturnType<typeof setTimeout>
  private killTimer?: ReturnType<typeof setTimeout>
  private idled = false
  private expired = false
  private stopped = false

  private constructor(
    readonly command: string,
    finished: Promise<ProcessResult>
  ) {
    this.finished = finished
  }

  /** A fake's answer, already complete. */
  static faked(result: ProcessResult): InvokedProcess {
    const invoked = new InvokedProcess(result.command, Promise.resolve(result))
    invoked.out = result.output
    invoked.err = result.errorOutput

    return invoked
  }

  static spawn(
    command: string,
    argv: string[],
    options: ProcessOptions,
    onOutput?: OutputHandler
  ): InvokedProcess {
    const invoked = new InvokedProcess(command, Promise.resolve() as never)

    const child = Bun.spawn({
      cmd: argv,
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdin: options.input === undefined ? 'ignore' : 'pipe',
      stdout: options.inherit ? 'inherit' : 'pipe',
      stderr: options.inherit ? 'inherit' : 'pipe',
      // Its own process group, so a kill reaches everything it started.
      detached: true
    })

    invoked.child = child

    if (options.input !== undefined && child.stdin) {
      const stdin = child.stdin as { write(chunk: string | Uint8Array): unknown; end(): unknown }
      stdin.write(options.input)
      void stdin.end()
    }

    if (options.timeout !== undefined) {
      invoked.killTimer = setTimeout(() => {
        invoked.expired = true
        invoked.terminate('SIGKILL')
      }, options.timeout)
    }

    invoked.finished = invoked.collect(child, options, onOutput)

    return invoked
  }

  /**
   * Signal the whole group, falling back to the child alone.
   *
   * The fallback matters when the group has already gone: `kill(-pid)` throws
   * `ESRCH` then, and a throw from inside a timer would be an unhandled
   * rejection rather than a timeout.
   */
  private terminate(signal: NodeJS.Signals): void {
    const pid = this.child?.pid
    if (pid === undefined) return

    try {
      process.kill(-pid, signal)
    } catch {
      try {
        this.child?.kill(signal as never)
      } catch {
        // Already gone, which is the outcome we wanted anyway.
      }
    }
  }

  private async collect(
    child: Bun.Subprocess<'pipe' | 'ignore', 'pipe', 'pipe'>,
    options: ProcessOptions,
    onOutput?: OutputHandler
  ): Promise<ProcessResult> {
    /**
     * A reader rather than `for await`, which does not typecheck everywhere.
     *
     * Bun iterates a `ReadableStream` at runtime, but the DOM lib does not
     * declare `[Symbol.asyncIterator]` on it — so `for await` compiles on one
     * machine and fails on the next with "must have a '[Symbol.asyncIterator]()'
     * method". A scaffolded application inherits that, and it is not something
     * its author can fix. `getReader()` is the same loop and is typed on every
     * platform.
     */
    const drain = async (stream: ReadableStream<Uint8Array>, which: 'stdout' | 'stderr') => {
      const decoder = new TextDecoder()
      const reader = stream.getReader()

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          const text = decoder.decode(value, { stream: true })
          if (text === '') continue

          if (which === 'stdout') this.out += text
          else this.err += text

          this.touch(options)
          if (!options.quiet) onOutput?.(text, which)
        }
      } finally {
        reader.releaseLock()
      }
    }

    this.touch(options)

    // Started, not awaited: the buffer has to keep emptying while we wait, or a
    // chatty command deadlocks against a full pipe. Inherited streams belong to
    // this process and are not ours to read.
    const drained = options.inherit
      ? Promise.resolve([])
      : Promise.all([drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr')])

    const code = await child.exited

    /**
     * Bounded, because a pipe can outlive the process holding it.
     *
     * A grandchild that put *itself* in a new session is outside the group and
     * can hold these streams open indefinitely. Waiting for the drain alone
     * would hang; abandoning it immediately would truncate the last lines of a
     * command that exited normally. So: wait, briefly.
     */
    await Promise.race([drained, Bun.sleep(FLUSH_GRACE_MS)])

    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.killTimer) clearTimeout(this.killTimer)

    const timedOut = this.idled || this.expired
    const result = new ProcessResult(
      this.command,
      code,
      this.out,
      this.err,
      child.signalCode ?? undefined,
      timedOut,
      this.idled ? options.idleTimeout : options.timeout
    )

    for (const listener of this.listeners) listener(result)

    return result
  }

  /** Restart the idle clock. Called on every chunk. */
  private touch(options: ProcessOptions): void {
    if (options.idleTimeout === undefined) return

    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idled = true
      this.terminate('SIGKILL')
    }, options.idleTimeout)
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed
  }

  /** Everything printed so far. */
  output(): string {
    return this.out
  }

  errorOutput(): string {
    return this.err
  }

  /** Signal the group, without waiting. */
  signal(signal: NodeJS.Signals = 'SIGTERM'): this {
    this.stopped = true
    this.terminate(signal)

    return this
  }

  /**
   * Ask it to stop, then insist.
   *
   * `SIGTERM` first so the command can clean up, `SIGKILL` after the grace
   * period for one that ignores it — the sequence a service manager uses, and
   * for the same reason.
   */
  async stop(graceMs = 3000, signal: NodeJS.Signals = 'SIGTERM'): Promise<ProcessResult> {
    if (!this.running()) return this.wait()

    this.stopped = true
    this.terminate(signal)

    const insist = setTimeout(() => this.terminate('SIGKILL'), graceMs)

    try {
      return await this.wait()
    } finally {
      clearTimeout(insist)
    }
  }

  /** Was it stopped on purpose, rather than by a timeout? */
  get wasStopped(): boolean {
    return this.stopped
  }

  /** Wait for it to finish. Safe to call more than once. */
  wait(): Promise<ProcessResult> {
    return this.finished
  }

  /**
   * Wait until the output satisfies `predicate`.
   *
   * What a test of a server needs: start it, wait for the line that says it is
   * listening, and carry on — rather than sleeping for a guessed duration.
   */
  async waitUntil(
    predicate: (output: string, stream: 'stdout' | 'stderr') => boolean
  ): Promise<this> {
    if (predicate(this.out, 'stdout') || predicate(this.err, 'stderr')) return this

    return new Promise<this>((resolve, reject) => {
      const poll = setInterval(() => {
        if (predicate(this.out, 'stdout') || predicate(this.err, 'stderr')) {
          clearInterval(poll)
          resolve(this)

          return
        }

        if (!this.running()) {
          clearInterval(poll)
          reject(
            new Error(
              `The command [${this.command}] finished before the output matched.` +
                (this.err.trim() === '' ? '' : `\n\n${this.err.trim()}`)
            )
          )
        }
      }, 10)
    })
  }

  /** Called when the command finishes. Used by the recorder. */
  onFinished(listener: (result: ProcessResult) => void): this {
    this.listeners.push(listener)

    return this
  }
}
