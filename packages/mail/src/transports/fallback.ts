import type { DeliveryResult, SentMessage, Transport } from '../message.ts'

/**
 * Try each transport in turn until one accepts the message — Laravel's
 * `failover`.
 *
 * The last error is thrown when none of them does, rather than the first: the
 * useful one is usually from the transport that was tried last.
 */
export class FailoverTransport implements Transport {
  readonly name = 'failover'

  constructor(private readonly transports: Transport[]) {
    if (transports.length === 0) {
      throw new Error('A failover mailer needs at least one mailer to fall back to.')
    }
  }

  async send(message: SentMessage): Promise<DeliveryResult> {
    let lastError: unknown

    for (const transport of this.transports) {
      try {
        return await transport.send(message)
      } catch (error) {
        lastError = error
      }
    }

    throw lastError
  }
}

/**
 * Spread messages across transports — Laravel's `roundrobin`.
 *
 * Sending starts from a random transport rather than the first, so several
 * processes do not all lean on the same provider; from there it advances in order.
 */
export class RoundRobinTransport implements Transport {
  readonly name = 'roundrobin'

  private next: number

  constructor(private readonly transports: Transport[]) {
    if (transports.length === 0) {
      throw new Error('A roundrobin mailer needs at least one mailer to send through.')
    }

    this.next = Math.floor(Math.random() * transports.length)
  }

  async send(message: SentMessage): Promise<DeliveryResult> {
    let lastError: unknown

    // Every transport is tried once before giving up, so one provider being down
    // does not lose the message.
    for (let attempt = 0; attempt < this.transports.length; attempt += 1) {
      const transport = this.transports[this.next % this.transports.length] as Transport
      this.next = (this.next + 1) % this.transports.length

      try {
        return await transport.send(message)
      } catch (error) {
        lastError = error
      }
    }

    throw lastError
  }
}
