import { app } from '@elvel/core'
import type { AuthUser } from './gate.ts'

/** The dispatcher, when one is registered. Auth works without events. */
type Dispatcher = { dispatch(event: object | string, payload?: unknown): unknown }

function dispatcher(): Dispatcher | undefined {
  const container = app()

  return container.bound('events' as never)
    ? (container.make('events' as never) as Dispatcher)
    : undefined
}

/**
 * Someone is trying to sign in, before anything has been checked.
 *
 * The credentials are carried without the password: an event is logged, and a
 * listener that wanted the password could only misuse it.
 */
export class Attempting {
  static readonly eventName = 'auth.attempting'

  constructor(
    readonly identifier: string,
    readonly guard = 'web',
    readonly remember = false
  ) {}
}

/** The credentials were right, before the session exists. */
export class Validated {
  static readonly eventName = 'auth.validated'

  constructor(
    readonly user: AuthUser,
    readonly guard = 'web'
  ) {}
}

/**
 * Somebody signed in.
 *
 * The user's id rather than the row: a sign-in writes a session, and a session
 * carries `userId`. Loading the user to fill the event would put a query on
 * every sign-in for the sake of listeners that may not exist — a listener that
 * wants the row reads it, and only the ones that want it pay.
 */
export class Login {
  static readonly eventName = 'auth.login'

  constructor(
    readonly userId: string,
    readonly guard = 'web',
    readonly remember = false
  ) {}
}

/** A signed-in user was resolved for a request. Fires per request, not per sign-in. */
export class Authenticated {
  static readonly eventName = 'auth.authenticated'

  constructor(
    readonly user: AuthUser,
    readonly guard = 'web'
  ) {}
}

/** "Log every failed sign-in", which had no seam at all before. */
export class Failed {
  static readonly eventName = 'auth.failed'

  constructor(
    readonly identifier: string,
    readonly guard = 'web',
    readonly reason?: string
  ) {}
}

/** Too many attempts. What an alert on credential stuffing listens for. */
export class Lockout {
  static readonly eventName = 'auth.lockout'

  constructor(
    readonly identifier: string,
    readonly seconds: number
  ) {}
}

export class Logout {
  static readonly eventName = 'auth.logout'

  constructor(
    readonly userId: string,
    readonly guard = 'web'
  ) {}
}

export class OtherDeviceLogout {
  static readonly eventName = 'auth.logout.other-devices'

  constructor(
    readonly userId: string,
    readonly guard = 'web'
  ) {}
}

export class CurrentDeviceLogout {
  static readonly eventName = 'auth.logout.current-device'

  constructor(
    readonly userId: string,
    readonly guard = 'web'
  ) {}
}

/** "Seed a workspace when a user registers." */
export class Registered {
  static readonly eventName = 'auth.registered'

  constructor(readonly user: AuthUser) {}
}

export class Verified {
  static readonly eventName = 'auth.verified'

  constructor(readonly user: AuthUser) {}
}

export class PasswordReset {
  static readonly eventName = 'auth.password.reset'

  constructor(readonly userId: string) {}
}

export class PasswordResetLinkSent {
  static readonly eventName = 'auth.password.reset-link-sent'

  constructor(readonly identifier: string) {}
}

/**
 * Announce an auth event, if anything is listening.
 *
 * Every one of these is a listener-shaped problem — audit a password reset,
 * notify on a new device, seed a workspace on registration — and none of them
 * had a seam. Nothing is built when no dispatcher is registered, because auth
 * has to work in an application that has no events package.
 */
export function announce(event: object): void {
  dispatcher()?.dispatch(event)
}
