import { assert, fail, show } from './assert.ts'

/** What a test needs from the console kernel. */
export type Runnable = {
  run(argv: string[]): Promise<number>
}

/** Anything with a prompt surface — a `Command`'s `output`, structurally. */
type Prompts = {
  ask?: (question: string, fallback?: string) => Promise<string>
  secret?: (question: string) => Promise<string>
  confirm?: (question: string, fallback?: boolean) => Promise<boolean>
  choice?: (question: string, choices: string[], fallback?: string) => Promise<string>
}

/**
 * An artisan command run under test — Laravel's `PendingCommand`.
 *
 * Output is captured by replacing `console.log` and `console.error` for the
 * duration. That is blunt, and it is also the only thing that works: `Output`
 * writes through them directly, so anything narrower would miss whatever a
 * command prints without going through the helper methods — which is exactly
 * the output most worth asserting when something has gone wrong.
 *
 * Answers are queued rather than typed. A command that asks more questions than
 * it was given answers fails with the question it got stuck on, rather than
 * hanging on a stdin that will never produce anything.
 */
export class PendingCommand {
  private readonly queued: Array<{ question?: string; answer: string | boolean }> = []
  private captured: string[] = []
  private code: number | undefined

  constructor(
    private readonly kernel: Runnable,
    private readonly argv: string[],
    /**
     * The `Output` prototype whose prompts get stubbed.
     *
     * Passed in rather than imported: this package must not depend on
     * `@elvel/console`, which depends on half the framework. `artisan()` has
     * it in hand at the call site anyway.
     */
    private readonly outputPrototype?: Prompts
  ) {}

  /**
   * Queue an answer.
   *
   * With a `question`, the answer only applies when the prompt contains that
   * text — which is what stops a reordered pair of prompts from silently
   * swapping their answers and still passing.
   */
  expectsQuestion(question: string, answer: string | boolean): this {
    this.queued.push({ question, answer })

    return this
  }

  /** Queue an answer for whatever is asked next. */
  answers(answer: string | boolean): this {
    this.queued.push({ answer })

    return this
  }

  expectsConfirmation(question: string, answer = true): this {
    return this.expectsQuestion(question, answer)
  }

  /** Run it. Repeated calls reuse the first run's result. */
  async run(): Promise<this> {
    if (this.code !== undefined) return this

    const lines: string[] = []
    const log = console.log
    const error = console.error
    const capture = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : show(arg))).join(' '))
    }

    console.log = capture
    console.error = capture

    const restore = this.stubPrompts()

    try {
      this.code = await this.kernel.run(this.argv)
    } finally {
      console.log = log
      console.error = error
      restore()
      this.captured = lines
    }

    return this
  }

  /**
   * Answer prompts from the queue.
   *
   * `Output` is instantiated per command and reached through a protected field,
   * so there is nothing to inject into. Patching the prototype is what is left;
   * it is restored in a `finally`, so a throwing command cannot leak the stub
   * into the next test.
   */
  private stubPrompts(): () => void {
    const prototype = this.outputPrototype
    if (!prototype) return () => {}

    const original = {
      ask: prototype.ask,
      secret: prototype.secret,
      confirm: prototype.confirm,
      choice: prototype.choice
    }

    const next = (question: string): string | boolean => {
      const index = this.queued.findIndex(
        (queued) => queued.question === undefined || question.includes(queued.question)
      )

      if (index === -1) {
        fail(
          `The command asked ${show(question)} and no answer was queued. ` +
            `Queue one with expectsQuestion() or answers().`
        )
      }

      return (this.queued.splice(index, 1)[0] as { answer: string | boolean }).answer
    }

    prototype.ask = async (question: string) => String(next(question))
    prototype.secret = async (question: string) => String(next(question))
    prototype.confirm = async (question: string) => Boolean(next(question))
    prototype.choice = async (question: string) => String(next(question))

    return () => {
      prototype.ask = original.ask
      prototype.secret = original.secret
      prototype.confirm = original.confirm
      prototype.choice = original.choice
    }
  }

  get output(): string {
    return this.captured.join('\n')
  }

  get exitCode(): number {
    if (this.code === undefined) throw new Error('The command has not been run. Await run() first.')

    return this.code
  }

  assertExitCode(expected: number): this {
    assert(
      this.exitCode === expected,
      `Expected exit code ${expected}, saw ${this.exitCode}. Output:\n${this.output}`,
      expected,
      this.exitCode
    )

    return this
  }

  assertSuccessful(): this {
    return this.assertExitCode(0)
  }

  assertFailed(): this {
    assert(
      this.exitCode !== 0,
      `Expected a non-zero exit code, saw ${this.exitCode}. Output:\n${this.output}`
    )

    return this
  }

  /**
   * Colour is stripped before matching.
   *
   * Every helper on `Output` paints, so an assertion on plain text would fail
   * against output that looks identical on screen — the thing the test author
   * copied it from.
   */
  assertOutputContains(needle: string): this {
    assert(
      this.plain().includes(needle),
      `Expected the output to contain ${show(needle)}. Output:\n${this.plain()}`
    )

    return this
  }

  assertOutputMissing(needle: string): this {
    assert(
      !this.plain().includes(needle),
      `Expected the output not to contain ${show(needle)}, but it does`
    )

    return this
  }

  /** Seen in this order — for a command whose steps are the point. */
  assertOutputInOrder(needles: string[]): this {
    const text = this.plain()
    let cursor = 0
    for (const needle of needles) {
      const found = text.indexOf(needle, cursor)
      assert(found !== -1, `Expected ${show(needle)} after the previous line. Output:\n${text}`)
      cursor = found + needle.length
    }

    return this
  }

  /** All queued answers were used up. */
  assertAllQuestionsAnswered(): this {
    assert(
      this.queued.length === 0,
      `The command never asked ${this.queued.length} queued question(s): ` +
        show(this.queued.map((queued) => queued.question ?? '(any)'))
    )

    return this
  }

  /**
   * The output with colour removed.
   *
   * The escape character is built rather than typed, so this file stays free of
   * literal control characters — they are invisible in a diff and do not survive
   * a copy/paste, which is how the `log:tail` fix went wrong the first time.
   */
  plain(): string {
    const colour = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

    return this.output.replace(colour, '')
  }
}
