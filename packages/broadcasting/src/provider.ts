import { ServiceProvider } from '@elysian/core'
import { Elysia } from 'elysia'
import { Broadcaster, type Subscriber } from './broadcaster.ts'
import { ChannelRegistry } from './channels.ts'
import { ChannelListCommand } from './console/channel-list.ts'
import { MakeChannelCommand } from './console/make-channel.ts'
import { RedisPubSub } from './redis.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    broadcaster: Broadcaster
    channels: ChannelRegistry
  }
}

/**
 * Serves the websocket endpoint and binds the broadcaster.
 *
 * One endpoint rather than one per channel: a browser opens a socket once and
 * subscribes over it, which is how every client library in this space works and
 * what keeps the connection count to one per tab.
 *
 * The protocol is deliberately small — `{"subscribe":"orders.7"}`,
 * `{"unsubscribe":"orders.7"}` — because anything larger is a client library's
 * job, and a server that invents its own framing forces everybody to write one.
 */
export class BroadcastServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('channels', () => new ChannelRegistry())
    this.app.singleton('broadcaster', (app) => {
      /**
       * One process, or several.
       *
       * `broadcasting.driver` is `memory` unless told otherwise, because that is
       * what a development machine and a single-server deployment both are, and
       * a framework that required Redis to send an event to a socket in its own
       * process would be requiring it for nothing. `redis` is what makes a
       * broadcast cross processes — the config is the whole difference.
       */
      const driver = app.config.get<string>('broadcasting.driver', 'memory')

      if (driver !== 'redis') return new Broadcaster(app.make('channels'))

      return new Broadcaster(
        app.make('channels'),
        new RedisPubSub({
          url: app.config.get<string | undefined>('broadcasting.redis.url', undefined),
          prefix: app.config.get<string | undefined>('broadcasting.redis.prefix', undefined)
        })
      )
    })
  }

  override boot(): void {
    if (this.app.bound('artisan')) {
      this.app.make('artisan').register(ChannelListCommand, MakeChannelCommand)
    }

    this.wireBroadcastableEvents()

    const path = this.config<string>('broadcasting.path', '/broadcast')
    const broadcaster = this.app.make('broadcaster')

    // Sockets are keyed by the connection object, because Elysia's ws data is
    // what every hook receives and there is nothing else stable to key by.
    const subscribers = new WeakMap<object, Subscriber>()

    this.use(
      new Elysia({ name: 'elysian:broadcasting' }).ws(path, {
        open: (socket) => {
          subscribers.set(socket.raw as object, {
            id: socket.id,
            send: (payload: string) => socket.send(payload),
            /**
             * The user as they were when the socket opened.
             *
             * A socket outlives the request that opened it, so the auth scope is
             * long gone by the time a subscribe arrives; capturing here is the
             * only point at which the user is still knowable.
             */
            user: this.app.bound('auth') ? this.app.make('auth').user() : null
          })
        },

        message: async (socket, raw) => {
          const subscriber = subscribers.get(socket.raw as object)

          if (!subscriber) return

          const message = parse(raw)

          if (message?.subscribe) {
            const allowed = await broadcaster.subscribe(subscriber, message.subscribe)

            socket.send(
              JSON.stringify({
                event: allowed ? 'subscribed' : 'refused',
                channel: message.subscribe
              })
            )

            return
          }

          if (message?.unsubscribe) broadcaster.unsubscribe(subscriber, message.unsubscribe)
        },

        close: (socket) => {
          const subscriber = subscribers.get(socket.raw as object)

          // Every channel, not just the ones it named: a socket that closed mid
          // subscribe would otherwise be broadcast to for ever.
          if (subscriber) broadcaster.forget(subscriber)
        }
      })
    )
  }

  /**
   * An event that says where it broadcasts is broadcast when it is dispatched.
   *
   * Laravel's `ShouldBroadcast`, without an interface to implement: an event
   * with a `broadcastOn()` is broadcastable, and one without is not. TypeScript
   * erases interfaces, so a marker interface would be a marker nothing can
   * check at the moment it matters.
   *
   * A wildcard listener rather than a hook inside the dispatcher, for the same
   * reason the queue installs its push from outside: `@elysian/events` knows
   * nothing about websockets and must keep working with no broadcaster at all.
   */
  private wireBroadcastableEvents(): void {
    if (!this.app.bound('events')) return

    const broadcaster = this.app.make('broadcaster')

    this.app.make('events').listen('*', (_name: string, payload: unknown) => {
      const event = payload as Broadcastable | null

      if (!event || typeof event.broadcastOn !== 'function') return

      const channels = event.broadcastOn()
      const named = typeof event.broadcastAs === 'function' ? event.broadcastAs() : undefined
      const body = typeof event.broadcastWith === 'function' ? event.broadcastWith() : { ...event }

      for (const channel of Array.isArray(channels) ? channels : [channels]) {
        broadcaster.broadcast(
          {
            channel,
            // The class name by default, so a client can switch on what arrived.
            event: named ?? (event as object).constructor?.name ?? 'event',
            payload: body
          },
          // `toOthers()`: the socket that caused it does not hear its own event
          // and render it twice.
          typeof event.broadcastExcept === 'function' ? event.broadcastExcept() : undefined
        )
      }
    })
  }
}

/**
 * What an event needs to broadcast itself.
 *
 * Only `broadcastOn` is required; the rest have defaults that are right most of
 * the time — the class name as the event, and the event's own fields as the
 * payload.
 */
export type Broadcastable = {
  /** The channel, or channels, this event goes to. */
  broadcastOn?(): string | string[]
  /** The name clients switch on. Defaults to the class name. */
  broadcastAs?(): string
  /** What travels. Defaults to the event's own fields. */
  broadcastWith?(): Record<string, unknown>
  /** A socket id not to send to — the one that caused the event. */
  broadcastExcept?(): string | undefined
}

/** A frame that is not JSON is ignored rather than closing the socket. */
function parse(raw: unknown): { subscribe?: string; unsubscribe?: string } | undefined {
  if (typeof raw === 'object' && raw !== null) {
    return raw as { subscribe?: string; unsubscribe?: string }
  }

  if (typeof raw !== 'string') return undefined

  try {
    return JSON.parse(raw) as { subscribe?: string; unsubscribe?: string }
  } catch {
    return undefined
  }
}
