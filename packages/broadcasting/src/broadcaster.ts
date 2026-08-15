import type { ChannelRegistry, Member } from './channels.ts'

/** One connected socket, as far as the broadcaster is concerned. */
export type Subscriber = {
  id: string
  send(payload: string): unknown
  user: { id?: unknown } | null
}

export type BroadcastMessage = {
  channel: string
  event: string
  payload: unknown
}

/** One broadcast as it travels between processes. */
export type PublishedMessage = {
  message: BroadcastMessage
  /**
   * The socket that caused it, if any.
   *
   * Travels with the message rather than being resolved by the publisher: the
   * socket belongs to exactly one process, and every *other* process simply
   * finds no socket with that id — which is the correct answer there.
   */
  except?: string | undefined
}

/**
 * A bus that carries broadcasts between processes.
 *
 * Deliberately this small. Redis is one implementation and the only one shipped;
 * anything with publish and subscribe — NATS, Postgres LISTEN/NOTIFY, a test
 * double that is an array — satisfies it.
 */
export type PubSub = {
  publish(message: PublishedMessage): void
  /** Called for every message on the bus, including this process's own. */
  onMessage(handler: (message: PublishedMessage) => void): void
  close(): void
}

/**
 * Fans an event out to the sockets listening on a channel.
 *
 * The subscriptions live in this process's memory, which is the whole story for
 * one server and half of it behind a load balancer. Give it a `PubSub` and the
 * other half arrives: every broadcast goes out on the bus and comes back to
 * every process, each of which then writes to the sockets it holds.
 *
 * The arrangement is Reverb's, not invented here. A process does **not** deliver
 * locally and then publish for the others: it publishes, and its own sockets are
 * served when the message comes back. One path means one order — every process
 * sees the same sequence — where delivering locally first would let one process
 * order its own events differently from everybody else's.
 */
export class Broadcaster {
  /** Sockets per channel. A socket may sit in several. */
  private readonly subscriptions = new Map<string, Set<Subscriber>>()

  /**
   * Who is on each presence channel, by socket.
   *
   * Per socket rather than per user, because one person with two tabs is two
   * sockets and one member: the `left` event has to wait for the last of them,
   * or closing one tab tells everybody you went away while you are still there.
   */
  private readonly members = new Map<string, Map<Subscriber, Member>>()

  constructor(
    private readonly channels: ChannelRegistry,
    /** The bus, when this process is one of several. */
    private readonly bus?: PubSub
  ) {
    // Everything published — by this process or any other — arrives here.
    this.bus?.onMessage((message) => this.deliver(message.message, message.except))
  }

  /**
   * Subscribe a socket, if the channel lets it.
   *
   * Authorisation happens here rather than at connect time, because a socket
   * opens once and may ask for many channels — some it may join and some it may
   * not, and refusing the whole connection for one denied channel would be a
   * blunt and confusing answer.
   */
  async subscribe(subscriber: Subscriber, channel: string): Promise<boolean> {
    if (!(await this.channels.authorize(channel, subscriber.user))) return false

    const sockets = this.subscriptions.get(channel) ?? new Set()

    sockets.add(subscriber)
    this.subscriptions.set(channel, sockets)

    await this.join(subscriber, channel)

    return true
  }

  /**
   * Record a member and tell the channel — a presence channel only.
   *
   * The split follows Laravel Echo's contract, because that is what any client
   * written for this already expects: the joiner receives `here` with the full
   * list **including themselves**, and everybody *else* receives `joined`. A
   * joiner who also received their own `joined` would render themselves twice —
   * once from the list and once from the arrival.
   */
  private async join(subscriber: Subscriber, channel: string): Promise<void> {
    const member = await this.channels.member(channel, subscriber.user)

    if (!member) return

    const present = this.members.get(channel) ?? new Map<Subscriber, Member>()
    const alreadyPresent = [...present.values()].some((existing) => existing.id === member.id)

    present.set(subscriber, member)
    this.members.set(channel, present)

    // `here` is for the socket that just joined, so it is written directly
    // rather than broadcast.
    this.send(subscriber, {
      channel,
      event: 'presence.here',
      payload: { members: distinctMembers(present) }
    })

    // A second tab is not a second arrival.
    if (alreadyPresent) return

    this.broadcast({ channel, event: 'presence.joined', payload: { member } }, subscriber.id)
  }

  unsubscribe(subscriber: Subscriber, channel: string): void {
    const sockets = this.subscriptions.get(channel)

    if (!sockets) return

    sockets.delete(subscriber)
    this.leave(subscriber, channel)

    // The empty set is removed, not kept: a long-lived process that never
    // cleaned up would accumulate one entry per channel anybody ever visited.
    if (sockets.size === 0) this.subscriptions.delete(channel)
  }

  /** Drop a socket from every channel — what a disconnect means. */
  forget(subscriber: Subscriber): void {
    for (const channel of [...this.subscriptions.keys()]) this.unsubscribe(subscriber, channel)
  }

  /** Drop a member, and announce it once their last socket has gone. */
  private leave(subscriber: Subscriber, channel: string): void {
    const present = this.members.get(channel)
    const member = present?.get(subscriber)

    if (!present || !member) return

    present.delete(subscriber)

    if (present.size === 0) this.members.delete(channel)

    // Still here on another socket — another tab, a reconnect that overlapped —
    // so nothing left.
    if ([...present.values()].some((existing) => existing.id === member.id)) return

    this.broadcast({ channel, event: 'presence.left', payload: { member } })
  }

  /** Who is on a presence channel, one entry per person rather than per socket. */
  presence(channel: string): Member[] {
    return distinctMembers(this.members.get(channel) ?? new Map())
  }

  /** How many sockets are listening. For a health endpoint, and for tests. */
  count(channel: string): number {
    return this.subscriptions.get(channel)?.size ?? 0
  }

  /**
   * Send an event to a channel.
   *
   * `except` skips one socket — the one that caused the event. Without it, the
   * client that just posted a message receives its own broadcast and renders it
   * twice, which is the first bug everybody writes.
   */
  broadcast(message: BroadcastMessage, except?: string): number {
    if (this.bus) {
      /**
       * Published, not delivered — the sockets here are served when it comes
       * back round, along with everybody else's.
       *
       * What comes back is a count of nothing, because at this point nothing has
       * been written to a socket and the number of sockets *elsewhere* is not
       * knowable from here. A caller that needs to know something was received
       * needs a different mechanism anyway; that was true before the bus existed.
       */
      this.bus.publish({ message, except })

      return 0
    }

    return this.deliver(message, except)
  }

  /** Write to the sockets this process holds. */
  private deliver(message: BroadcastMessage, except?: string): number {
    const sockets = this.subscriptions.get(message.channel)

    if (!sockets) return 0

    const body = JSON.stringify({
      channel: message.channel,
      event: message.event,
      payload: message.payload
    })

    let sent = 0

    for (const socket of sockets) {
      if (socket.id === except) continue

      try {
        socket.send(body)
        sent += 1
      } catch {
        // A socket that cannot be written to is gone; dropping it here keeps a
        // dead connection from being retried on every future broadcast.
        sockets.delete(socket)
      }
    }

    return sent
  }

  /** Write one message to one socket, tolerating a dead one. */
  private send(subscriber: Subscriber, message: BroadcastMessage): void {
    try {
      subscriber.send(JSON.stringify(message))
    } catch {
      // Gone between subscribing and being told who is here. Nothing to clean
      // up: the disconnect hook takes the socket out of every channel.
    }
  }
}

/** One entry per person, however many sockets they hold. */
function distinctMembers(present: Map<Subscriber, Member>): Member[] {
  const byId = new Map<unknown, Member>()

  for (const member of present.values()) {
    if (!byId.has(member.id)) byId.set(member.id, member)
  }

  return [...byId.values()]
}
