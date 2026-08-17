import { Elysia } from 'elysia'

/** The field a form carries, and the header a client may send instead. */
export const METHOD_FIELD = '_method'
export const METHOD_HEADER = 'x-http-method-override'

/** Set on the re-entered request, so the override is applied once. */
const APPLIED = 'x-elvel-method-override'

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

  return new Elysia({ name: 'elvel:method-override' }).onRequest(async ({ request }) => {
    if (request.method !== 'POST' || request.headers.get(APPLIED)) return undefined

    /**
     * The body is read **once**, here, and that is not a tidiness point.
     *
     * The first version cloned twice — once to find `_method`, once to build the
     * request that goes on — and the second clone came back with **the body
     * repeated**. Elysia then parsed `_token` as two values joined by a newline,
     * the CSRF check compared an 81-character string against a 40-character one,
     * and every method-spoofed form in the auth kit answered 419.
     *
     * Two things hid it. The kit's smoke run set `SESSION_CSRF=false`, and the
     * unit tests for this file build requests by hand rather than through a
     * booted application, so neither ever put a real token through a real
     * spoofed form.
     */
    const type = request.headers.get('content-type') ?? ''
    const carriesFields =
      type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')

    /**
     * One clone, read once into bytes, used for both purposes.
     *
     * Bytes rather than text or `FormData`, because both jobs need the body and
     * only one form survives the round trip: re-encoding a `FormData` produces a
     * new multipart boundary while the copied `content-type` header still names
     * the old one, and the router then parses nothing.
     *
     * The original is deliberately left unread. A request with nothing to spoof —
     * which is most of them — passes straight through and Elysia parses it as it
     * did before this plugin existed.
     */
    const bytes = carriesFields ? await request.clone().arrayBuffer() : undefined
    const spoofed = await readOverride(request, bytes, type, options.fromQuery ?? false)

    if (!spoofed || !allowed.has(spoofed)) return undefined

    const headers = new Headers(request.headers)
    headers.set(APPLIED, '1')

    return handler(
      new Request(request.url, {
        method: spoofed,
        headers,
        ...(bytes === undefined ? {} : { body: bytes })
      })
    )
  })
}

/**
 * The method a request is asking to be, if any.
 *
 * Takes the bytes it was already handed rather than reading the request again —
 * reading it twice is the bug described above.
 */
async function readOverride(
  request: Request,
  bytes: ArrayBuffer | undefined,
  type: string,
  fromQuery: boolean
): Promise<string | undefined> {
  // The header wins, as in Symfony: it is the form the API clients use, and it
  // needs no body to be read at all.
  const header = request.headers.get(METHOD_HEADER)
  if (header) return header.toUpperCase()

  if (bytes !== undefined && type.includes('application/x-www-form-urlencoded')) {
    const field = new URLSearchParams(new TextDecoder().decode(bytes)).get(METHOD_FIELD)
    if (field) return field.toUpperCase()
  }

  if (bytes !== undefined && type.includes('multipart/form-data')) {
    // Parsed from a throwaway request built on the same bytes, which is the only
    // way to get a multipart parser without touching the original again.
    const form = await new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': type },
      body: bytes
    }).formData()

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
