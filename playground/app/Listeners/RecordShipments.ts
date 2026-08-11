import type { EventDispatcher, EventSubscriber } from '@elysian/events'
import { log } from '@elysian/log'
import { OrderShipped } from '../Events/OrderShipped.ts'

/**
 * RecordShipments
 *
 * Anything in `app/Listeners` exporting a class with a `subscribe` method is
 * discovered and registered by EventServiceProvider — no manual wiring, which
 * is exactly what `bun run smoke` asserts.
 *
 * Return `false` from a handler to stop the event reaching later listeners.
 */
export class RecordShipments implements EventSubscriber {
  /** Exposed so the smoke test can prove the listener actually ran. */
  static readonly shipments: number[] = []

  subscribe(events: EventDispatcher): void {
    // Listening on the class rather than the string keeps `event` typed.
    events.listen(OrderShipped, (event) => this.handle(event))

    // Wildcard listeners receive the resolved event name as well.
    events.listen('order.*', (name: string, payload: unknown) => {
      log().debug('wildcard saw {name}', { name, payload: JSON.stringify(payload) })
    })
  }

  handle(event: OrderShipped): string {
    RecordShipments.shipments.push(event.orderId)

    log().info('Order {orderId} shipped via {carrier}', {
      orderId: event.orderId,
      carrier: event.carrier
    })

    return `recorded:${event.orderId}`
  }
}
