import { Elysia } from 'elysia'

/** The field a form carries, and the header a client may send instead. */
export const METHOD_FIELD = '_method'
export const METHOD_HEADER = 'x-http-method-override'

/** Set on the re-entered request, so the override is applied once. */
const APPLIED = 'x-elysian-method-override'

/**
 * Methods a form may spoof.
 *
 * Not `GET`, `HEAD`, `CONNECT` or `TRACE`, and Symfony refuses those too. A POST
 * turned into a GET would be a state-changing request wearing the clothes of a
 * safe, cacheable one — a proxy could cache it, a browser could repeat it, and
 * every "this method is safe" assumption downstream would be wrong.
 */
const SPOOFABLE = new Set(['PUT', 'PATCH', 'DELETE', 'OPTIONS'])

export type MethodOverrideOptions = {
  /** Which methods a form may claim. Defaults to PUT, PATCH, DELETE, OPTIONS. */
  allow?: string[]
  /** Read `?_method=` as well as the body. Off by default, as in Symfony. */
  fromQuery?: boolean
}

/**
 * Let an HTML form reach a `PUT`, `PATCH` or `DELETE` route — Blade's `@method`.
 *
 * A browser form can only send `GET` or `POST`. Laravel's answer is a hidden
 * `_method` field that the framework reads before routing, and this is the same
 * thing: without it every route a form posts to has to be a `POST`, which is why
 * the auth kit here has `POST /settings/profile` where Laravel's starter kit has
 * `PATCH`.
 *
 * **Before routing, which is the whole difficulty.** Elysia picks a handler from
 * the method, and a `beforeHandle` hook runs after that choice is made — too late
 * to change it. `Request.method` is also read-only, so nothing can be edited in
 * place. What works is `onRequest`, which runs first: it builds a new `Request`
 * with the real method and hands it back through the router, and a marker header
 * stops that from happening twice.
 *
 * The body survives the round trip, so validation and CSRF see what was sent —
 * and CSRF now sees `PUT` rather than `POST`, which is what it should be checking.
 */
export function methodOverridePlugin(
  handler: (request: Request) => Promise<Response>,
  options: MethodOverrideOptions = {}
) {
  const allowed = new Set((options.allow ?? [...SPOOFABLE]).map((method) => method.toUpperCase()))

  return new Elysia({ name: 'elysian:method-override' }).onRequest(async ({ request }) => {
    if (request.method !== 'POST' || request.headers.get(APPLIED)) return undefined

    const spoofed = await readOverride(request, options.fromQuery ?? false)
    if (!spoofed || !allowed.has(spoofed)) return undefined

    const headers = new Headers(request.headers)
    headers.set(APPLIED, '1')

    /**
     * The body is read from a clone and passed on as text.
     *
     * A `Request` body is a stream that can be consumed once, so reading
     * `_method` would otherwise leave the handler with nothing to parse.
     */
    return handler(
      new Request(request.url, {
        method: spoofed,
        headers,
        body: await request.clone().text()
      })
    )
  })
}

/** The method a request is asking to be, if any. */
async function readOverride(request: Request, fromQuery: boolean): Promise<string | undefined> {
  // The header wins, as in Symfony: it is the form the API clients use, and it
  // needs no body to be read at all.
  const header = request.headers.get(METHOD_HEADER)
  if (header) return header.toUpperCase()

  const type = request.headers.get('content-type') ?? ''

  if (type.includes('application/x-www-form-urlencoded')) {
    const field = new URLSearchParams(await request.clone().text()).get(METHOD_FIELD)
    if (field) return field.toUpperCase()
  }

  if (type.includes('multipart/form-data')) {
    const form = await request.clone().formData()
    const field = form.get(METHOD_FIELD)
    if (typeof field === 'string' && field !== '') return field.toUpperCase()
  }

  if (fromQuery) {
    const field = new URL(request.url).searchParams.get(METHOD_FIELD)
    if (field) return field.toUpperCase()
  }

  return undefined
}

/**
 * The hidden field a form needs — Blade's `@method('PUT')`.
 *
 * ```tsx
 * <form method="post" action="/settings/profile">
 *   {csrfField()}
 *   {methodField('PATCH')}
 * </form>
 * ```
 */
export function methodField(method: string): string {
  const value = method.toUpperCase().replace(/[^A-Z]/g, '')

  return `<input type="hidden" name="${METHOD_FIELD}" value="${value}" />`
}
