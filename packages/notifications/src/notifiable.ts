/** Where a channel should deliver to, for one notifiable. */
export type Route = unknown

/**
 * Something that can receive a notification — Laravel's `Notifiable`.
 *
 * A model satisfies it by having an `email`, which is the default `mail` route;
 * anything more specific is a `routeNotificationFor` of its own.
 */
export interface Notifiable {
  /** Where this channel should send. `null` means "not by this channel". */
  routeNotificationFor?(channel: string): Route

  /** Used by the database channel to own the row. */
  getKey?(): unknown

  /**
   * The name stored as `notifiable_type`.
   *
   * Declared rather than read off `constructor.name`, because a recipient rebuilt
   * from a queued payload is not an instance of the original model and must still
   * be able to say what it stands for.
   */
  getNotifiableType?(): string

  /** The default `mail` route, as Laravel reads it. */
  email?: unknown

  /** Fallback key when there is no `getKey()`. */
  id?: unknown
}

/**
 * The route a channel should use for a notifiable.
 *
 * An explicit `routeNotificationFor` wins; otherwise the defaults are Laravel's —
 * `mail` reads `email`, and every other channel has to be told.
 */
export function routeFor(notifiable: Notifiable, channel: string): Route {
  if (typeof notifiable.routeNotificationFor === 'function') {
    const route = notifiable.routeNotificationFor(channel)

    if (route !== undefined) return route
  }

  if (channel === 'mail') return notifiable.email ?? null

  return null
}

/** The model name and key a stored notification belongs to. */
export function identify(notifiable: Notifiable): { type: string; id: unknown } {
  const key =
    typeof notifiable.getKey === 'function' ? notifiable.getKey() : (notifiable.id ?? null)

  const type =
    typeof notifiable.getNotifiableType === 'function'
      ? notifiable.getNotifiableType()
      : (notifiable.constructor?.name ?? 'Notifiable')

  return { type, id: key }
}

/**
 * A recipient with no model behind it — Laravel's `AnonymousNotifiable`.
 *
 * `notify().route('mail', 'ada@example.com').send(new Welcome())` is the case this
 * exists for: a notification to an address that is not a user yet.
 */
export class AnonymousNotifiable implements Notifiable {
  private readonly routes = new Map<string, Route>()

  route(channel: string, route: Route): this {
    if (channel === 'database') {
      throw new Error(
        'The database channel cannot take an on-demand notification: there is no record to attach it to.'
      )
    }

    this.routes.set(channel, route)

    return this
  }

  routeNotificationFor(channel: string): Route {
    return this.routes.get(channel) ?? null
  }

  /** The channels this recipient was given a route for. */
  channels(): string[] {
    return [...this.routes.keys()]
  }
}

export function isAnonymous(notifiable: Notifiable): notifiable is AnonymousNotifiable {
  return notifiable instanceof AnonymousNotifiable
}
