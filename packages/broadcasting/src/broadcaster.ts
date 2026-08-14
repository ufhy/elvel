import type { ChannelRegistry } from './channels.ts'

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

/**
 * Fans an event out to the sockets listening on a channel.
 *
 * In-memory, and honest about what that means: it reaches the sockets connected
 * to **this process**. That is the whole story for one server and only part of
 * it behind a load balancer, where a second process holds half the sockets and
 * never hears the event. `RedisBroadcaster` is the answer there, and it is the
 * same interface, so the choice is a line of config rather than a rewrite.
 */
export class Broadcaster {
  /** Sockets per channel. A socket may sit in several. */
  private readonly subscriptions = new Map<string, Set<Subscriber>>()

  constructor(private readonly channels: ChannelRegistry) {}

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

    return true
  }

  unsubscribe(subscriber: Subscriber, channel: string): void {
    const sockets = this.subscriptions.get(channel)

    if (!sockets) return

    sockets.delete(subscriber)

    // The empty set is removed, not kept: a long-lived process that never
    // cleaned up would accumulate one entry per channel anybody ever visited.
    if (sockets.size === 0) this.subscriptions.delete(channel)
  }

  /** Drop a socket from every channel — what a disconnect means. */
  forget(subscriber: Subscriber): void {
    for (const channel of [...this.subscriptions.keys()]) this.unsubscribe(subscriber, channel)
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
}
