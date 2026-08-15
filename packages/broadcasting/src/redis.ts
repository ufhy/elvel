import { RedisClient } from 'bun'
import type { PublishedMessage, PubSub } from './broadcaster.ts'

export type RedisPubSubOptions = {
  url?: string | undefined
  /** Namespaces the bus channel, so two applications on one Redis stay apart. */
  prefix?: string | undefined
  client?: ConstructorParameters<typeof RedisClient>[1] | undefined
}

/**
 * Carries broadcasts between processes over Redis pub/sub.
 *
 * **Two connections, not one.** A Redis client in subscribe mode may issue
 * nothing but subscribe and unsubscribe until it leaves that mode — that is
 * Redis's rule, not Bun's — so a single client cannot both listen and publish.
 * Reverb opens the same pair for the same reason.
 *
 * **One bus channel, not one per application channel.** The alternative is a
 * `psubscribe` and a subscription that changes as sockets come and go, which is
 * more moving parts for nothing: a process that receives a broadcast for a
 * channel it holds no sockets on discards it in a map lookup.
 *
 * Nothing about it is ordered across processes beyond what Redis gives —
 * messages from *one* publisher arrive in order, and two publishers are two
 * orders. That is true of every fan-out of this shape, Laravel's included.
 */
export class RedisPubSub implements PubSub {
  private readonly publisher: RedisClient
  private readonly subscriber: RedisClient
  private readonly channel: string
  private handler: ((message: PublishedMessage) => void) | undefined
  private listening = false

  constructor(options: RedisPubSubOptions = {}) {
    const url = options.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

    this.publisher = new RedisClient(url, options.client)
    this.subscriber = new RedisClient(url, options.client)
    this.channel = `${options.prefix ?? ''}broadcast`
  }

  publish(message: PublishedMessage): void {
    /**
     * Fire and forget, with the failure reported and swallowed.
     *
     * A broadcast is not a delivery guarantee — nothing about it ever was — and
     * throwing here would take down the request that happened to cause the
     * event. A Redis that is down means the other processes miss it, which is
     * the same outcome as having no bus at all.
     */
    void this.publisher.publish(this.channel, JSON.stringify(message)).catch(() => undefined)
  }

  onMessage(handler: (message: PublishedMessage) => void): void {
    this.handler = handler

    if (this.listening) return

    this.listening = true

    void this.subscriber
      .subscribe(this.channel, (raw: string) => {
        try {
          this.handler?.(JSON.parse(raw) as PublishedMessage)
        } catch {
          // Something else is publishing on this channel, or publishing
          // rubbish. Dropping it is right: the alternative is one bad frame
          // stopping every broadcast after it.
        }
      })
      .catch(() => undefined)
  }

  close(): void {
    this.publisher.close()
    this.subscriber.close()
  }
}
