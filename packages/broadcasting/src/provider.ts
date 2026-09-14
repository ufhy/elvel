import { ServiceProvider } from '@elvel/core'
import { Elysia } from 'elysia'
import { Broadcaster, type Subscriber } from './broadcaster.ts'
import { ChannelRegistry } from './channels.ts'
import { ChannelListCommand } from './console/channel-list.ts'
import { MakeChannelCommand } from './console/make-channel.ts'
import { LogPubSub, NullPubSub } from './drivers.ts'
import { RedisPubSub } from './redis.ts'
import { currentSocket, enterSocket, SOCKET_HEADER } from './socket.ts'

declare module '@elvel/contracts' {
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

      switch (driver) {
        case 'memory':
          return new Broadcaster(app.make('channels'))

        case 'redis':
          return new Broadcaster(
            app.make('channels'),
            new RedisPubSub({
              url: app.config.get<string | undefined>('broadcasting.redis.url', undefined),
              prefix: app.config.get<string | undefined>('broadcasting.redis.prefix', undefined)
            })
          )

        case 'log':
          return new Broadcaster(app.make('channels'), new LogPubSub())

        case 'null':
          return new Broadcaster(app.make('channels'), new NullPubSub())

        default:
          /**
           * An error, where every unknown name used to be `memory`.
           *
           * `BROADCAST_DRIVER=null` silently gave a working in-process
           * broadcaster, so switching broadcasting off in CI left it on and
           * nothing said so.
           */
          throw new Error(
            `Broadcast driver [${driver}] is not supported. Use memory, redis, log or null.`
          )
      }
    })
  }

  override boot(): void {
    if (this.app.bound('elvel')) {
      this.app.make('elvel').register(ChannelListCommand, MakeChannelCommand)
    }

    this.wireBroadcastableEvents()

    const path = this.config<string>('broadcasting.path', '/broadcast')
    const broadcaster = this.app.make('broadcaster')

    // Sockets are keyed by the connection object, because Elysia's ws data is
    // what every hook receives and there is nothing else stable to key by.
    const subscribers = new WeakMap<object, Subscriber>()

    /**
     * A request that names a socket puts it where an event can reach it.
     *
     * Synchronous, like every other request slot: `enterWith` applies to the
     * rest of this execution, and a slot written after an `await` lands in a
     * frame the handler never sees.
     */
    this.use(
      new Elysia({ name: 'elvel:broadcasting:socket' }).onRequest(({ request }) => {
        const id = request.headers.get(SOCKET_HEADER)

        if (id !== null && id !== '') enterSocket(id)
      })
    )

    this.use(
      new Elysia({ name: 'elvel:broadcasting' }).ws(path, {
        open: (socket) => {
          /**
           * The socket is told its own id, which is the half that was missing.
           *
           * A client echoes it back as `X-Socket-ID` on every request, and a
           * broadcast raised during that request skips it — so the tab that
           * posted the message does not render its own event twice.
           */
          socket.send(JSON.stringify({ event: 'connected', socketId: socket.id }))

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
   * How this event's frames leave: now, or after the transaction commits.
   *
   * **Inline is the default here, and upstream queues.** The difference is what
   * the default broadcaster is: upstream's is an HTTP call to Pusher, which
   * belongs off the request path, and Elvel's is an in-process fan-out — a
   * function call. Queuing that would make a worker a requirement of the
   * simplest possible setup, and a broadcast with no worker running is a
   * broadcast that never arrives.
   *
   * `broadcastAfterCommit()` is the opt-in, and it is the one that matters: an
   * event broadcast inside a transaction that then rolled back has already gone
   * out.
   */
  private sender(
    event: Broadcastable
  ): (
    message: { channel: string; event: string; payload: Record<string, unknown> },
    except?: string
  ) => void {
    const broadcaster = this.app.make('broadcaster')

    const send = (
      message: { channel: string; event: string; payload: Record<string, unknown> },
      except?: string
    ): void => {
      broadcaster.broadcast(message, except)
    }

    const afterCommit =
      typeof event.broadcastAfterCommit === 'function' && event.broadcastAfterCommit()

    if (!afterCommit || !this.app.bound('db')) return send

    return (message, except) => {
      /**
       * Held until the outermost transaction commits — and never sent if it
       * rolls back, which is the whole point: an order that was not saved must
       * not have announced itself.
       *
       * `afterCommit` runs the callback immediately when no transaction is
       * open, so this needs no branch for the ordinary case.
       */
      void this.app
        .make('db')
        .connection()
        .then((connection) => connection.afterCommit(() => send(message, except)))
    }
  }

  /**
   * An event that says where it broadcasts is broadcast when it is dispatched.
   *
   * No interface to implement: an event
   * with a `broadcastOn()` is broadcastable, and one without is not. TypeScript
   * erases interfaces, so a marker interface would be a marker nothing can
   * check at the moment it matters.
   *
   * A wildcard listener rather than a hook inside the dispatcher, for the same
   * reason the queue installs its push from outside: `@elvel/events` knows
   * nothing about websockets and must keep working with no broadcaster at all.
   */
  private wireBroadcastableEvents(): void {
    if (!this.app.bound('events')) return

    const broadcaster = this.app.make('broadcaster')

    /**
     * A publish that failed becomes a failed job, when there is a queue.
     *
     * Without one it stays on stderr, which is the broadcaster's own default —
     * a framework that required a queue to report a lost broadcast would be
     * requiring it for nothing on the setup that has no bus at all.
     */
    if (this.app.bound('queue')) {
      broadcaster.onPublishFailed = (message, error) => {
        void this.app
          .make('queue')
          .failed.log('broadcast', 'default', failedPayload(message), error)
      }
    }

    this.app.make('events').listen('*', (_name: string, payload: unknown) => {
      const event = payload as Broadcastable | null

      if (!event || typeof event.broadcastOn !== 'function') return

      /**
       * The event decides whether it broadcasts at all.
       *
       * A state machine that only announces some transitions had to be split
       * into two event classes without this.
       */
      if (typeof event.broadcastWhen === 'function' && !event.broadcastWhen()) return

      const channels = event.broadcastOn()
      const named = typeof event.broadcastAs === 'function' ? event.broadcastAs() : undefined
      const body = typeof event.broadcastWith === 'function' ? event.broadcastWith() : { ...event }

      const send = this.sender(event)

      for (const channel of Array.isArray(channels) ? channels : [channels]) {
        send(
          {
            channel,
            // The class name by default, so a client can switch on what arrived.
            event: named ?? (event as object).constructor?.name ?? 'event',
            payload: body
          },
          /**
           * `toOthers()`: the socket that caused it does not hear its own event.
           *
           * The event's own answer wins, and the request's socket is the
           * default — which is what makes `toOthers` the behaviour rather than
           * something every event has to opt into.
           */
          (typeof event.broadcastExcept === 'function' ? event.broadcastExcept() : undefined) ??
            currentSocket()
        )
      }
    })
  }
}

/**
 * A stand-in payload, so a lost broadcast can be recorded like any other job.
 *
 * There is no job class behind it: what failed is a publish, and the useful
 * record is the frame that did not go out.
 */
function failedPayload(message: { channel: string; event: string; payload: unknown }) {
  return {
    uuid: crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
    job: 'Broadcast',
    displayName: `Broadcast(${message.event} → ${message.channel})`,
    data: message as unknown as Record<string, unknown>,
    attempts: 1,
    createdAt: Math.floor(Date.now() / 1000)
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
  /** Answer `false` and the event is dispatched without being broadcast. */
  broadcastWhen?(): boolean
  /** Queue the broadcast on this connection instead of sending it inline. */
  broadcastConnection?(): string | undefined
  /** And on this queue. */
  broadcastQueue?(): string | undefined
  /** Hold the broadcast until the enclosing transaction commits. */
  broadcastAfterCommit?(): boolean
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
