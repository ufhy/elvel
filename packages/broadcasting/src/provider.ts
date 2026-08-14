import { ServiceProvider } from '@elysian/core'
import { Elysia } from 'elysia'
import { Broadcaster, type Subscriber } from './broadcaster.ts'
import { ChannelRegistry } from './channels.ts'

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
    this.app.singleton('broadcaster', (app) => new Broadcaster(app.make('channels')))
  }

  override boot(): void {
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
