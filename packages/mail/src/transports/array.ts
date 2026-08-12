import type { DeliveryResult, SentMessage, Transport } from '../message.ts'

/**
 * Keeps messages in memory — Laravel's `array` transport.
 *
 * What tests assert against, and the reason `SentMessage` is a plain object: an
 * assertion reads the fields directly instead of parsing MIME.
 */
export class ArrayTransport implements Transport {
  readonly name = 'array'

  readonly messages: SentMessage[] = []

  async send(message: SentMessage): Promise<DeliveryResult> {
    this.messages.push(message)

    return { transport: this.name, id: `array-${this.messages.length}` }
  }

  flush(): void {
    this.messages.length = 0
  }
}
