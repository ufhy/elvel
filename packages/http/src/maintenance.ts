import {
  BYPASS_COOKIE,
  bypassCookieIsValid,
  HttpException,
  issueBypassCookie,
  type MaintenanceMode,
  type MaintenancePayload,
  requestPath
} from '@elvel/core'
import { Elysia } from 'elysia'
import { CookieJar } from './cookies.ts'

/** 503, carrying whatever `down` was told to say. */
export class ServiceUnavailableException extends HttpException {
  constructor(message = 'Service Unavailable', headers: Record<string, string> = {}, status = 503) {
    super(status, message, headers)
    this.name = 'ServiceUnavailableException'
  }
}

/**
 * Refuse requests while the application is down —
 * `PreventRequestsDuringMaintenance`.
 *
 * Registered before everything else, and reading the file per request, so
 * `elvel up` takes effect on the next request rather than the next deploy.
 *
 * The order inside is Laravel's, and each step exists for a reason worth keeping:
 *
 * 1. `except` paths answer normally — a health check that fails during maintenance
 *    tells an orchestrator to replace a container that is deliberately down.
 * 2. Visiting the secret URL sets a bypass cookie and redirects to `/`, so the
 *    phrase leaves the address bar instead of sitting in a browser history.
 * 3. A valid cookie passes through, which is what lets somebody test a deploy
 *    while everyone else waits.
 * 4. A configured `redirect` wins over refusing, for a status page elsewhere.
 * 5. A pre-rendered `template` is sent as-is; otherwise a 503 with `Retry-After`.
 */
// The return type is inferred on purpose: `onRequest` narrows Elysia's generics,
// and naming the bare `Elysia` here makes the two instantiations unrelated.
export function maintenancePlugin(maintenance: MaintenanceMode, cookiePath = '/') {
  return new Elysia({ name: 'elvel:maintenance' }).onRequest(async ({ request, set }) => {
    if (!(await maintenance.active())) return undefined

    const data = await maintenance.data()

    // Active but unreadable: a `down` file half-written by a deploy racing us. The
    // safe reading is "we are down", with the defaults.
    const payload: MaintenancePayload = data ?? { since: 0 }

    const path = requestPath(request)

    if (isExcepted(path, payload.except ?? [])) return undefined

    if (payload.secret !== undefined) {
      // The secret is a path, so it is compared as one: `/abc123`.
      if (path === `/${payload.secret}` || path === payload.secret) {
        return bypassResponse(payload.secret, cookiePath)
      }

      const cookies = CookieJar.parse(request.headers.get('cookie'))

      if (bypassCookieIsValid(cookies[BYPASS_COOKIE], payload.secret)) return undefined
    }

    if (payload.redirect !== undefined && path !== payload.redirect) {
      return new Response(null, { status: 302, headers: { location: payload.redirect } })
    }

    const headers = headersFor(payload)
    const status = payload.status ?? 503

    if (payload.template !== undefined) {
      return new Response(payload.template, {
        status,
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' }
      })
    }

    // Thrown rather than returned, so it renders through the one exception handler
    // and an API client gets the same JSON shape it gets for every other error.
    void set

    throw new ServiceUnavailableException('Service Unavailable', headers, status)
  })
}

/** `/up` or `api/*`, matched the way the CSRF exemptions are. */
function isExcepted(path: string, except: string[]): boolean {
  return except.some((pattern) => {
    const trimmed = `/${pattern.replace(/^\/+/, '')}`

    if (!trimmed.includes('*')) return path === trimmed

    const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')

    return new RegExp(`^${escaped}$`).test(path)
  })
}

function bypassResponse(secret: string, cookiePath: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': CookieJar.serialize(BYPASS_COOKIE, issueBypassCookie(secret), {
        path: cookiePath,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 12 * 3600
      })
    }
  })
}

function headersFor(payload: MaintenancePayload): Record<string, string> {
  const headers: Record<string, string> = {}

  if (payload.retry !== undefined) headers['Retry-After'] = String(payload.retry)
  if (payload.refresh !== undefined) headers.Refresh = String(payload.refresh)

  return headers
}
