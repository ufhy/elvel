/**
 * The browser half.
 *
 * The frame shapes were documented and nothing shipped, so every application
 * wrote the same reconnect loop, the same backoff, the same
 * resubscribe-after-reconnect and the same presence bookkeeping — and got the
 * third one wrong, because a socket that comes back with none of its
 * subscriptions looks exactly like a quiet channel.
 *
 * No dependency on anything in the framework: this runs in a browser, and it is
 * a separate entry point so importing `@elvel/broadcasting` on the server does
 * not pull it in.
 */

export type EchoOptions = {
  /** Defaults to `/broadcast` on the current origin, over ws or wss to match. */
  url?: string
  /** Attempts before it gives up. `Infinity` by default: a tab left open reconnects. */
  maxAttempts?: number
  /** First backoff, in milliseconds. Doubles, with jitter, up to `maxDelay`. */
  delay?: number
  maxDelay?: number
  /** Injectable for tests, and for a runtime that is not a browser. */
  socket?: (url: string) => WebSocketLike
}

/** Enough of a `WebSocket` to drive; the real one satisfies it. */
export type WebSocketLike = {
  send(data: string): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

type Handler = (payload: unknown, event: string) => void

/** One member of a presence channel, as the server sends it. */
export type Member = { id: string | number; [key: string]: unknown }

/**
 * A channel as the caller holds it.
 *
 * Presence is a **list**, not three events to reduce by hand: `here`, `joined`
 * and `left` are how the server reports change, and every application turned
 * them back into a list. This does that once.
 */
export class Channel {
  private readonly handlers = new Map<string, Set<Handler>>()

  /** The current members, for a presence channel. Empty for any other kind. */
  members: Member[] = []

  constructor(readonly name: string) {}

  /** `listen('OrderShipped', …)`, or `listen('*', …)` for everything. */
  listen(event: string, handler: Handler): this {
    const existing = this.handlers.get(event)

    if (existing) existing.add(handler)
    else this.handlers.set(event, new Set([handler]))

    return this
  }

  stopListening(event: string, handler?: Handler): this {
    if (handler === undefined) this.handlers.delete(event)
    else this.handlers.get(event)?.delete(handler)

    return this
  }

  /** Called by the connection. Not part of the API a page uses. */
  receive(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload, event)
    for (const handler of this.handlers.get('*') ?? []) handler(payload, event)
  }
}

/**
 * The connection, and everything held across a reconnect.
 *
 * ```ts
 * const echo = new Echo()
 *
 * echo.channel('orders.7').listen('OrderShipped', (order) => render(order))
 * echo.socketId()          // send as X-Socket-ID so you skip your own events
 * ```
 */
export class Echo {
  private socket: WebSocketLike | undefined
  private readonly channels = new Map<string, Channel>()
  private id: string | undefined
  private attempts = 0
  private closing = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: EchoOptions = {}) {
    this.connect()
  }

  /**
   * This socket's id, once the server has said it.
   *
   * Send it as `X-Socket-ID` on every request and a broadcast raised during
   * that request skips this tab — which is the whole of `toOthers()` from the
   * client's side.
   */
  socketId(): string | undefined {
    return this.id
  }

  connected(): boolean {
    return this.id !== undefined
  }

  /** Subscribe, or hand back the channel already held. */
  channel(name: string): Channel {
    const existing = this.channels.get(name)

    if (existing) return existing

    const channel = new Channel(name)
    this.channels.set(name, channel)

    this.send({ subscribe: name })

    return channel
  }

  /** The same, under the names a private or presence channel goes by. */
  private_(name: string): Channel {
    return this.channel(name)
  }

  join(name: string): Channel {
    return this.channel(name)
  }

  leave(name: string): void {
    this.channels.delete(name)
    this.send({ unsubscribe: name })
  }

  /** Stop reconnecting and close. A page navigating away should call this. */
  disconnect(): void {
    this.closing = true

    if (this.timer !== undefined) clearTimeout(this.timer)

    this.socket?.close()
  }

  private connect(): void {
    const open = this.options.socket ?? defaultSocket
    const socket = open(this.options.url ?? defaultUrl())

    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0

      /**
       * Everything held is subscribed again, before anything else is sent.
       *
       * The bug this exists for: a socket that comes back with none of its
       * subscriptions looks exactly like a channel that has gone quiet, and
       * nothing in the page says otherwise.
       */
      for (const name of this.channels.keys()) socket.send(JSON.stringify({ subscribe: name }))
    }

    socket.onmessage = (message) => {
      const frame = parse(message.data)

      if (frame === undefined) return

      if (frame.event === 'connected' && typeof frame.socketId === 'string') {
        this.id = frame.socketId

        return
      }

      if (typeof frame.channel !== 'string') return

      const channel = this.channels.get(frame.channel)

      if (channel === undefined) return

      this.applyPresence(channel, frame)

      channel.receive(String(frame.event), frame.payload)
    }

    socket.onclose = () => {
      this.id = undefined

      if (this.closing) return

      this.retry()
    }

    // A socket that errors also closes; letting `onclose` own the retry keeps
    // one reconnect in flight rather than two racing.
    socket.onerror = () => undefined
  }

  /**
   * Exponential backoff with jitter.
   *
   * The jitter is not decoration: every tab of a site reconnects when the server
   * restarts, and without it they arrive together and knock it over again.
   */
  private retry(): void {
    const max = this.options.maxAttempts ?? Number.POSITIVE_INFINITY

    if (this.attempts >= max) return

    const base = this.options.delay ?? 1000
    const ceiling = this.options.maxDelay ?? 30_000
    const wait = Math.min(ceiling, base * 2 ** this.attempts)

    this.attempts += 1
    this.timer = setTimeout(() => this.connect(), wait / 2 + Math.random() * (wait / 2))
  }

  /** `here`/`joined`/`left`, folded into the list the caller actually wants. */
  private applyPresence(channel: Channel, frame: Frame): void {
    const payload = frame.payload as { members?: Member[]; member?: Member } | undefined

    if (frame.event === 'presence.here' && Array.isArray(payload?.members)) {
      channel.members = payload.members

      return
    }

    if (frame.event === 'presence.joined' && payload?.member !== undefined) {
      const member = payload.member

      // Keyed on id, because a second tab is not a second arrival.
      if (!channel.members.some((one) => one.id === member.id)) channel.members.push(member)

      return
    }

    if (frame.event === 'presence.left' && payload?.member !== undefined) {
      channel.members = channel.members.filter((one) => one.id !== payload.member?.id)
    }
  }

  private send(frame: Record<string, unknown>): void {
    // Dropped when the socket is down: `onopen` resubscribes everything held, so
    // a subscribe sent into a closed socket would only be sent twice.
    try {
      this.socket?.send(JSON.stringify(frame))
    } catch {
      // The socket is closing or closed; the resubscribe covers it.
    }
  }
}

type Frame = { event?: unknown; channel?: unknown; payload?: unknown; socketId?: unknown }

function parse(data: unknown): Frame | undefined {
  if (typeof data !== 'string') return undefined

  try {
    return JSON.parse(data) as Frame
  } catch {
    return undefined
  }
}

function defaultUrl(): string {
  const location = (globalThis as { location?: { protocol: string; host: string } }).location

  if (location === undefined) return 'ws://localhost:3000/broadcast'

  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/broadcast`
}

function defaultSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike
}
