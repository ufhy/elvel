/**
 * The part of a request's lifecycle a response with no handler still needs.
 *
 * Every per-request hook Elysia offers — `derive`, `onBeforeHandle`, `transform`,
 * `onAfterHandle` — belongs to a *handler*. An error response has none: nothing
 * matched, or something threw before the pipeline got there, and the exception
 * handler answers on its own. So everything those hooks do is simply missing,
 * which does not matter while an error page is a paragraph of text and matters a
 * great deal the moment an application renders a real page there. A single-page
 * application does exactly that: the server cannot know which paths the client
 * router owns, so every one of them arrives as a 404 and leaves as a document.
 *
 * Measured on a built demo, one cookie, one page:
 *
 * - `user()` read guest, while `GET /api/user` on the same cookie answered as the
 *   signed-in user. The document sent them back to sign in.
 * - `csrfToken()` read `''`, and no `Set-Cookie` came back at all — so the client
 *   booted with a token belonging to a session that was never saved, and the
 *   first write it attempted was refused. Silent until then.
 *
 * Two halves, because the failure has two halves. A package that keeps something
 * in an `AsyncLocalStorage` registers with `entering` to put it back before the
 * handler renders; a package that has something to write when a response is
 * finished registers with `finishing` to do it after.
 *
 * ```ts
 * app.make('request.lifecycle')
 *   .entering((request) => {
 *     const session = sessions.get(request)
 *
 *     if (session) enterRequestScope({ request, session })
 *   })
 *   .finishing(async (request, response) => {
 *     await sessions.get(request)?.save()
 *   })
 * ```
 */
export class RequestLifecycle {
  private readonly preparations: Array<(request: Request) => Promise<void> | void> = []

  private readonly entries: Array<(request: Request) => void> = []

  private readonly finishers: Array<
    (request: Request, response: Response) => Promise<void> | void
  > = []

  /**
   * Resolve what a scope needs, before entering it.
   *
   * Its own step because entering has to be synchronous and resolving usually is
   * not: a session is read from a store, a user from a session cookie. Doing that
   * work here means the happy path pays nothing for it — a request that reaches a
   * handler never runs any of this, so the cost stays on the path that actually
   * needs it. The alternative was resolving in `onRequest` for every request,
   * which would have added a store read to every static asset.
   */
  preparing(prepare: (request: Request) => Promise<void> | void): this {
    this.preparations.push(prepare)

    return this
  }

  /** Run every preparation. Awaited, so `enter` finds its values in place. */
  async prepare(request: Request): Promise<void> {
    for (const prepare of this.preparations) {
      try {
        await prepare(request)
      } catch {
        // See `enter` for why this is swallowed.
      }
    }
  }

  /**
   * Put a scope back before the error is rendered.
   *
   * Must enter it **synchronously**. `AsyncLocalStorage.enterWith` applies to the
   * rest of the current execution and the continuations scheduled from it, so a
   * callback that enters after its own `await` lands in a frame the renderer never
   * sees — the same trap that put these hooks in `onBeforeHandle` to begin with.
   */
  entering(enter: (request: Request) => void): this {
    this.entries.push(enter)

    return this
  }

  /** Write what a finished response owes: save a session, add a cookie. */
  finishing(finish: (request: Request, response: Response) => Promise<void> | void): this {
    this.finishers.push(finish)

    return this
  }

  /**
   * Enter every registered scope for the rest of this execution.
   *
   * A callback that throws is swallowed, here and in `finish`, deliberately: all
   * of this runs while an error is already on its way out, and a failure here
   * would replace the error a developer is trying to read with one about the
   * machinery that was trying to describe it. The cost is one value reading empty
   * or one cookie not re-issued, which is the behaviour without any of this.
   */
  enter(request: Request): void {
    for (const enter of this.entries) {
      try {
        enter(request)
      } catch {
        // Nothing to do about it here, and nowhere useful to say it.
      }
    }
  }

  /**
   * Run every finisher against the response about to go out.
   *
   * The `try` is inside the loop and wraps the `await`, not the call. A finisher
   * is allowed to be async, and a synchronous `try` around a call that merely
   * *returns* a promise catches nothing — the rejection arrives later, unguarded,
   * and takes the error response down with it.
   */
  async finish(request: Request, response: Response): Promise<void> {
    for (const finish of this.finishers) {
      try {
        await finish(request, response)
      } catch {
        // As above.
      }
    }
  }
}
