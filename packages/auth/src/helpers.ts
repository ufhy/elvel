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
