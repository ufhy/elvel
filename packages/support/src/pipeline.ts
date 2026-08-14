/** Hands control to the rest of the pipeline. */
export type Next<T, R> = (passable: T) => Promise<R>

/** A stage written as a function. */
export type PipeFunction<T, R> = (passable: T, next: Next<T, R>) => R | Promise<R>

/** A stage written as an object, called through `handle` unless `via` says otherwise. */
export type PipeObject<T, R> = Record<string, (passable: T, next: Next<T, R>) => R | Promise<R>>

/** A stage, or the name of one for a resolver to find. */
export type Pipe<T, R> = PipeFunction<T, R> | PipeObject<T, R> | string

/** Turns a name into a stage — a container's `make`, usually. */
export type PipeResolver<T, R> = (name: string) => PipeFunction<T, R> | PipeObject<T, R>

/**
 * A value through a series of stages — Laravel's `Pipeline`.
 *
 * ```ts
 * const result = await new Pipeline<Request, Response>()
 *   .send(request)
 *   .through([authenticate, rateLimit, log])
 *   .then((request) => handle(request))
 * ```
 *
 * Each stage decides whether the rest runs, which is what separates this from
 * `reduce`: a stage may work before calling `next`, after it, around it, or not
 * call it at all and answer on its own. That is the whole shape of middleware,
 * and it is why the queue's job middleware and this are now the same code.
 *
 * Async throughout. A synchronous pipeline is a special case of an async one and
 * having both would double the surface to save an `await`.
 */
export class Pipeline<T, R = T> {
  private passable!: T
  private stages: Array<Pipe<T, R>> = []
  private method = 'handle'
  private resolver?: PipeResolver<T, R>
  private after?: (passable: T) => void | Promise<void>

  constructor(resolver?: PipeResolver<T, R>) {
    this.resolver = resolver
  }

  /** The value being sent through. */
  send(passable: T): this {
    this.passable = passable

    return this
  }

  /** The stages, outermost first. */
  through(pipes: Array<Pipe<T, R>> | Pipe<T, R>): this {
    this.stages = Array.isArray(pipes) ? [...pipes] : [pipes]

    return this
  }

  /** Add stages to the end of whatever is there. */
  pipe(...pipes: Array<Pipe<T, R>>): this {
    this.stages.push(...pipes)

    return this
  }

  /** The method to call on an object stage. `handle` by default. */
  via(method: string): this {
    this.method = method

    return this
  }

  /** How a named stage is found. */
  resolveWith(resolver: PipeResolver<T, R>): this {
    this.resolver = resolver

    return this
  }

  /**
   * Run after the pipeline, whatever happened.
   *
   * Runs on the way out of a throw as well as a return — which is the only
   * reason to have it rather than a line after the `await`. Releasing a lock
   * belongs here.
   */
  finally(callback: (passable: T) => void | Promise<void>): this {
    this.after = callback

    return this
  }

  /** Run it, ending at `destination`. */
  async then(destination: (passable: T) => R | Promise<R>): Promise<R> {
    /**
     * Built from the inside out, so the first stage ends up outermost.
     *
     * `reduceRight` over the reversed list would read the same and run the
     * stages backwards, which is the sort of thing that only shows up once
     * ordering matters — after a stage that authenticates ends up running after
     * one that authorises.
     */
    const chain = this.stages.reduceRight<Next<T, R>>(
      (next, stage) => async (passable: T) => this.invoke(stage, passable, next),
      async (passable: T) => destination(passable)
    )

    try {
      return await chain(this.passable)
    } finally {
      await this.after?.(this.passable)
    }
  }

  /** Run it, returning whatever came out of the last stage. */
  thenReturn(): Promise<R> {
    return this.then((passable) => passable as unknown as R)
  }

  private invoke(stage: Pipe<T, R>, passable: T, next: Next<T, R>): R | Promise<R> {
    const resolved = typeof stage === 'string' ? this.resolveName(stage) : stage

    if (typeof resolved === 'function') return resolved(passable, next)

    const handler = resolved[this.method]
    if (typeof handler !== 'function') {
      throw new Error(
        `Pipeline stage has no [${this.method}] method. ` +
          `Add one, pass a function, or name the method with via().`
      )
    }

    return handler.call(resolved, passable, next)
  }

  private resolveName(name: string): PipeFunction<T, R> | PipeObject<T, R> {
    if (!this.resolver) {
      throw new Error(
        `Pipeline was given the stage name [${name}] but no resolver. ` +
          `Pass one to the constructor, or use resolveWith().`
      )
    }

    return this.resolver(name)
  }
}

/**
 * Named pipelines — Laravel's `Hub`.
 *
 * For a pipeline defined in one place and run from several, where passing the
 * stage list around would mean every caller knowing what they are.
 */
export class Pipehub {
  private readonly pipelines = new Map<string, (passable: unknown) => Promise<unknown>>()

  /** Define one. */
  pipeline<T, R = T>(
    name: string,
    callback: (pipeline: Pipeline<T, R>, passable: T) => Promise<R>
  ): this {
    this.pipelines.set(
      name,
      (passable) => callback(new Pipeline<T, R>(), passable as T) as Promise<unknown>
    )

    return this
  }

  /**
   * Run one.
   *
   * `async` so the unknown-name case rejects rather than throwing
   * synchronously. A method that returns a promise should fail through that
   * promise; a caller with a `.catch()` and no `try` would otherwise miss it.
   */
  async pipe<T, R = T>(passable: T, name = 'default'): Promise<R> {
    const pipeline = this.pipelines.get(name)
    if (!pipeline) {
      throw new Error(`Pipeline [${name}] is not defined. Define it with pipeline().`)
    }

    return (await pipeline(passable)) as R
  }

  has(name: string): boolean {
    return this.pipelines.has(name)
  }
}
