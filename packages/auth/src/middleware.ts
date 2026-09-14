import { app, ForbiddenException, HttpException, UnauthorizedException } from '@elvel/core'
import { boundOrNothing, redirect, sessionOf } from '@elvel/http'
import { gate } from './helpers.ts'
import type { AuthManager } from './manager.ts'

/** Session key holding when the password was last confirmed. */
export const PASSWORD_CONFIRMED_AT = 'auth.password_confirmed_at'

type Context = { request: Request; user?: unknown }

/**
 * Where a middleware sends somebody: a path, or a function that decides.
 *
 * Either a string or a callable, and the callable is the half that matters: an application with an admin area sends a guest to `/admin/login` from
 * `/admin/*` and to `/sign-in` from everywhere else, which one fixed string
 * cannot express.
 */
export type RedirectTarget = string | ((request: Request) => string)

function destination(target: unknown, request: Request, fallback: string): string {
  if (typeof target === 'function') return (target as (request: Request) => string)(request)

  return typeof target === 'string' && target !== '' ? target : fallback
}

function manager(): AuthManager {
  return app('auth')
}

/**
 * Does the caller want JSON rather than a page?
 *
 * The whole redirect-or-401 decision hangs on this: an `Accept` header asking for JSON, or a request that announced itself as
 * XHR. Getting it wrong sends a 302 to an API client, which follows it and
 * reports the sign-in page as a successful response.
 */
export function expectsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? ''

  return (
    accept.includes('/json') ||
    accept.includes('+json') ||
    request.headers.get('x-requested-with') === 'XMLHttpRequest'
  )
}

/**
 * `auth` — there must be somebody signed in.
 *
 * One failure, rendered two
 * ways. A page-shaped request is redirected and its destination remembered, so
 * signing in returns where it was going; a JSON-shaped one gets a 401 and no
 * `Location`, because a client that follows redirects would otherwise treat the
 * sign-in page as the answer to its request.
 *
 * Where guests go is configuration, not a constant.
 */
export function authenticate(..._guards: string[]) {
  return (context: Context) => {
    if (manager().check()) return undefined

    if (expectsJson(context.request)) throw new UnauthorizedException('Unauthenticated.')

    const to = destination(
      app().config.get<RedirectTarget>('auth.redirectGuestsTo', '/sign-in'),
      context.request,
      '/sign-in'
    )

    return redirect(to).guest().toResponse()
  }
}

/**
 * `guest` — there must be nobody signed in.
 *
 * `RedirectIfAuthenticated`, and the inverse of the one above: a signed-in person
 * on a sign-in form either signs in as themselves again for nothing, or is
 * confused about which account they are using.
 */
export function guestOnly(..._guards: string[]) {
  return (context: Context) => {
    if (!manager().check()) return undefined

    const to = destination(
      app().config.get<RedirectTarget>('auth.redirectUsersTo', '/dashboard'),
      context.request,
      '/dashboard'
    )

    return redirect(to).toResponse()
  }
}

/**
 * `verified` — the email address must be confirmed.
 *
 * `EnsureEmailIsVerified` answers **403** to JSON and redirects a page, and it
 * treats a guest as unverified rather than deferring to `auth`. That looks
 * redundant next to `auth` and is not: a route carrying only `verified` must not
 * fall open for somebody who is not signed in at all.
 *
 * `Redirect::guest` rather than a plain redirect, so the destination survives the
 * detour through verification.
 */
export function ensureVerified(notice?: string) {
  return (context: Context) => {
    const current = manager().user() as { emailVerified?: unknown } | null

    // `emailVerified` absent means the application does not track verification,
    // which is not the same as failing it.
    if (current && (current.emailVerified === undefined || current.emailVerified === true)) {
      return undefined
    }

    // 403, not 401: they are authenticated, they simply may not be here yet.
    if (expectsJson(context.request)) {
      throw new ForbiddenException('Your email address is not verified.')
    }

    const to =
      notice ??
      destination(
        app().config.get<RedirectTarget>('auth.verifyRoute', '/verify-email'),
        context.request,
        '/verify-email'
      )

    return redirect(to).guest().toResponse()
  }
}

/**
 * `can:ability,arg` — the Gate must allow it.
 *
 * An argument naming a route binding is authorised against the **model**, not
 * against its name: `can:update,article` on `/articles/:article` hands the
 * policy the article. That is the only form a policy can do anything with — a
 * policy asked about the string `'article'` either ignores it or denies
 * everything, and both look like the rule working.
 *
 * Anything else is passed through as the string it was, which is what a route
 * can carry and what a policy taking a plain argument expects. A name that
 * *looks* like a binding but was never bound stays a string too: the route did
 * not declare it, and guessing would be worse than the literal reading.
 */
export function canAccess(ability: string, ...args: string[]) {
  return async (context: Context) => {
    const resolved = args.map((arg) => boundOrNothing(arg, context.request) ?? arg)

    await gate().authorize(ability, resolved)

    return undefined
  }
}

/**
 * `password.confirm` — the password must have been typed recently.
 *
 * The window is what makes this different from asking for a password inline: a
 * borrowed unlocked browser cannot change security settings, but somebody working
 * through several settings pages is not asked five times. Three hours, matching
 *
 * 423 to JSON, not 403: the request was understood and the caller is
 * authenticated, but the resource is locked until they prove it again.
 */
export function requirePassword(redirectTo?: string, timeoutSeconds?: string) {
  return (context: Context) => {
    const window = Number(timeoutSeconds ?? app().config.integer('auth.passwordTimeout', 10_800))
    const session = sessionOf(context)
    const confirmedAt = Number(session.get(PASSWORD_CONFIRMED_AT, 0))

    if (Math.floor(Date.now() / 1000) - confirmedAt < window) return undefined

    if (expectsJson(context.request)) {
      throw new HttpException(423, 'Password confirmation required.')
    }

    const to =
      redirectTo ??
      destination(
        app().config.get<RedirectTarget>('auth.passwordConfirmRoute', '/confirm-password'),
        context.request,
        '/confirm-password'
      )

    return redirect(to).guest().toResponse()
  }
}

/** Record that the password was just confirmed, starting the window. */
export function confirmPassword(context: Context): void {
  sessionOf(context).put(PASSWORD_CONFIRMED_AT, Math.floor(Date.now() / 1000))
}
