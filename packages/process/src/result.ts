/** A command that exited non-zero, or was killed. */
export class ProcessFailedError extends Error {
  constructor(readonly result: ProcessResult) {
    const reason = result.timedOut
      ? `timed out after ${result.timeout}ms`
      : result.signal
        ? `was killed with ${result.signal}`
        : `exited with code ${result.exitCode}`

    /**
     * The output is in the message, not only on the object.
     *
     * A failed command's reason is almost always the last line it printed, and
     * an error that says "exited with code 1" sends you back to run it by hand
     * to find out what that line was.
     */
    super(
      `The command [${result.command}] ${reason}.` +
        (result.errorOutput.trim() === '' ? '' : `\n\n${result.errorOutput.trim()}`) +
        (result.errorOutput.trim() === '' && result.output.trim() !== ''
          ? `\n\n${result.output.trim()}`
          : '')
    )
    this.name = 'ProcessFailedError'
  }
}

/** What a finished command left behind — Laravel's `ProcessResult`. */
export class ProcessResult {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly output: string,
    readonly errorOutput: string,
    readonly signal?: string,
    readonly timedOut = false,
    readonly timeout?: number,
    /**
     * The bytes exactly as they arrived, when the command asked for `binary()`.
     *
     * Empty otherwise, which is the honest answer rather than a decoded string
     * re-encoded: that round trip is what destroys the data in the first place.
     */
    readonly bytes: Uint8Array = new Uint8Array(),
    readonly errorBytes: Uint8Array = new Uint8Array()
  ) {}

  successful(): boolean {
    return this.exitCode === 0 && !this.timedOut
  }

  failed(): boolean {
    return !this.successful()
  }

  seeInOutput(needle: string): boolean {
    return this.output.includes(needle)
  }

  seeInErrorOutput(needle: string): boolean {
    return this.errorOutput.includes(needle)
  }

  /** Both streams, in the order they were declared rather than interleaved. */
  all(): string {
    return this.errorOutput === '' ? this.output : `${this.output}${this.errorOutput}`
  }

  /** Throw if it failed; otherwise hand back the result, so it chains. */
  throw(): this {
    if (this.failed()) throw new ProcessFailedError(this)

    return this
  }

  throwIf(condition: boolean): this {
    return condition ? this.throw() : this
  }

  /** The output split into lines, with the trailing newline dropped. */
  lines(): string[] {
    const trimmed = this.output.replace(/\n$/, '')

    return trimmed === '' ? [] : trimmed.split('\n')
  }

  json<T = unknown>(): T {
    return JSON.parse(this.output) as T
  }
}
