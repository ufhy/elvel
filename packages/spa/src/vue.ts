/**
 * Forms, for Vue.
 *
 * The only file in this package that imports a UI framework, and it imports
 * nothing else from the server half either. `client.ts` decides what a request
 * looks like; this decides what a form *is* while it is in flight — which fields
 * it holds, whether it is submitting, and which messages sit under which input.
 *
 * React and Svelte get their own file beside this one. What they will share is
 * everything below `submit`: the prefix, the CSRF token, and reading a 422 as
 * per-field messages rather than as an exception the page has to catch.
 */
import { reactive } from 'vue'
import { call, Invalid } from './client.ts'

export type FormOptions = {
  /**
   * Where to go when the server says to go somewhere.
   *
   * A server-driven redirect is the whole shape of an auth flow: sign in and the
   * server decides whether that means the dashboard or a two-factor challenge.
   * Left unset, the redirect is reported and nothing moves — this package cannot
   * know which router the application uses, and reaching for `location.assign`
   * would throw away the client routing that made it a client in the first place.
   */
  onRedirect?: (to: string) => void

  /** Everything the server answered, redirect included. */
  onSuccess?: (payload: Record<string, unknown>) => void

  /**
   * Where the CSRF token comes from, when it does not come from the document.
   *
   * `call()` reads it from the embedded payload by default, and a **shell** carries
   * none — a token is per session, and a document carrying one would be per session
   * too, which is the cacheability a shell exists for. So an application on a shell
   * fetches the token (`GET /api/session`, usually) and hands it over here.
   *
   * A function rather than a string, because it is read per submission: signing in
   * rotates the session id and the token rotates with it, so a value captured when
   * the form was created is the wrong one by the time it submits.
   */
  token?: () => string
}

export type Form<T> = {
  /** The fields, bound with `v-model="form.data.email"`. */
  data: T

  /**
   * One message per field, which is what an input can show.
   *
   * The server sends every message for a field; the first is the one that fits
   * under the input. `Invalid.errors` still carries all of them for a caller that
   * wants a summary.
   */
  errors: Record<string, string>

  /** True while a submission is in flight — bind it to the button's `disabled`. */
  processing: boolean

  submit(method: string, path: string): Promise<Record<string, unknown> | undefined>
  post(path: string): Promise<Record<string, unknown> | undefined>
  put(path: string): Promise<Record<string, unknown> | undefined>
  patch(path: string): Promise<Record<string, unknown> | undefined>
  delete(path: string): Promise<Record<string, unknown> | undefined>

  /** Back to the values it started with — all of them, or only those named. */
  reset(...fields: Array<keyof T & string>): void

  clearErrors(...fields: string[]): void
}

/**
 * A form that knows how to submit itself.
 *
 * ```vue
 * const form = useForm({ email: '', password: '' })
 * form.post('/sign-in')
 * ```
 *
 * The fields stay under `data` rather than being hoisted onto the form itself.
 * Hoisting reads better right up until an application has a field called `errors`
 * or `post`, and then it silently shadows the form's own — a bug whose symptom is
 * a submit button that does nothing.
 */
export function useForm<T extends Record<string, unknown>>(
  initial: T,
  options: FormOptions = {}
): Form<T> {
  /**
   * Cast once, here.
   *
   * `reactive()` types its result as `UnwrapRef<T>` — it would unwrap a `ref`
   * nested inside the fields. Form fields are plain values, so the unwrapping is
   * a distinction without a difference, and carrying it through every signature
   * below makes `reset()` fail to assign a `T` back into its own state.
   */
  const state = reactive({
    data: { ...initial },
    errors: {} as Record<string, string>,
    processing: false
  }) as { data: T; errors: Record<string, string>; processing: boolean }

  const submit = async (
    method: string,
    path: string
  ): Promise<Record<string, unknown> | undefined> => {
    state.processing = true
    /**
     * Cleared on the way out, not on the way back.
     *
     * A field the server no longer objects to has to stop being red, and the only
     * moment that is certain is before asking. Clearing on the answer instead
     * leaves the previous refusal on screen for the length of the request.
     */
    state.errors = {}

    try {
      const payload = await call<Record<string, unknown>>(path, {
        method,
        body: state.data,
        /**
         * No prefix. `/sign-in` and `/settings/profile` are the same addresses a
         * browser would navigate to, and a form posts to the address it names.
         */
        prefix: '',
        // Read now, not when the form was created: signing in rotates the token.
        ...(options.token === undefined ? {} : { token: options.token() })
      })

      const to = payload.redirect
      if (typeof to === 'string') options.onRedirect?.(to)

      options.onSuccess?.(payload)

      return payload
    } catch (failure) {
      /**
       * A 422 is an answer, not a failure.
       *
       * Anything else — a 500, a dropped connection, an expired session as
       * `Unauthenticated` — is left to throw. A form is not the place to decide
       * what a signed-out session means; the router is.
       */
      if (failure instanceof Invalid) {
        state.errors = firstOf(failure.errors)

        return undefined
      }

      throw failure
    } finally {
      state.processing = false
    }
  }

  return Object.assign(state, {
    submit,
    post: (path: string) => submit('POST', path),
    put: (path: string) => submit('PUT', path),
    patch: (path: string) => submit('PATCH', path),
    delete: (path: string) => submit('DELETE', path),

    reset: (...fields: Array<keyof T & string>) => {
      if (fields.length === 0) {
        state.data = { ...initial } as T

        return
      }

      for (const field of fields) state.data[field] = initial[field]
    },

    clearErrors: (...fields: string[]) => {
      if (fields.length === 0) {
        state.errors = {}

        return
      }

      for (const field of fields) delete state.errors[field]
    }
  })
}

/** The first message for each field — what an input under a label can show. */
function firstOf(errors: Record<string, string[]>): Record<string, string> {
  const first: Record<string, string> = {}

  for (const [field, messages] of Object.entries(errors)) {
    const message = messages[0]

    if (message !== undefined) first[field] = message
  }

  return first
}
