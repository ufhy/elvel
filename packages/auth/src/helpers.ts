import { app, UnauthorizedException } from '@elysian/core'
import type { AuthUser, Gate } from './gate.ts'
import type { AuthManager, AuthSession } from './manager.ts'

/** The auth manager. Works anywhere inside a request, and in commands. */
export function auth(): AuthManager {
  return app('auth')
}

/** The gate. */
export function gate(): Gate {
  return app('gate')
}

/** The current user, or null for a guest. */
export function user(): AuthUser | null {
  return auth().user()
}

/** The current session record. */
export function session(): AuthSession['session'] | null {
  return auth().session()
}

/**
 * The current user, or a 401.
 *
 * ```ts
 * .get('/profile', () => ({ email: requireUser().email }))
 * ```
 */
export function requireUser(): AuthUser {
  const current = user()

  if (!current) throw new UnauthorizedException('Unauthenticated.')

  return current
}

/** Does the current user have this ability? */
export function can(ability: string, args: unknown | unknown[] = []): Promise<boolean> {
  return gate().allows(ability, args)
}

export function cannot(ability: string, args: unknown | unknown[] = []): Promise<boolean> {
  return gate().denies(ability, args)
}

/**
 * Authorize or throw — the handler equivalent of Laravel's
 * `$this->authorize()`. `AuthorizationError` carries its own status, so the
 * framework's exception handler renders the 403 (or whatever the policy chose).
 */
export async function authorize(ability: string, args: unknown | unknown[] = []): Promise<void> {
  await gate().authorize(ability, args)
}

/**
 * Render something only for a signed-in visitor — Blade's `@auth`.
 *
 * ```tsx
 * {whenAuth((user) => <a href="/dashboard" safe>{user.name}</a>)}
 * {whenGuest(() => <a href="/sign-in">Sign in</a>)}
 * ```
 *
 * The user is handed to the callback rather than read again inside it, so the
 * branch and the thing it prints cannot disagree about who is signed in.
 */
export function whenAuth(render: (signedIn: AuthUser) => string): string {
  const signedIn = user()

  return signedIn === null ? '' : render(signedIn)
}

/** The other half — for a visitor who is not signed in. */
export function whenGuest(render: () => string): string {
  return user() === null ? render() : ''
}

/**
 * Render something only when the Gate allows it — Blade's `@can`.
 *
 * Awaited, because a policy may read the database. `{await whenCan(...)}` inside
 * JSX is the shape; a version that answered synchronously could only ever consult
 * abilities that need nothing, which is not what a policy is for.
 */
export async function whenCan(
  ability: string,
  args: unknown | unknown[],
  render: () => string
): Promise<string> {
  return (await can(ability, args)) ? render() : ''
}

/** The negative, for the "you cannot do this" half of a page. */
export async function whenCannot(
  ability: string,
  args: unknown | unknown[],
  render: () => string
): Promise<string> {
  return (await cannot(ability, args)) ? render() : ''
}
