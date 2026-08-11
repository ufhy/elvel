import type { EventDispatcher, EventSubscriber } from '@elysian/events'
import { log } from '@elysian/log'
import { OrderShipped } from '../Events/OrderShipped.ts'

/**
 * Discovered automatically: EventServiceProvider registers every class in
 * `app/Listeners` that has a `subscribe` method. Nothing wires this up by hand,
 * which is exactly what `bun run smoke` asserts.
 */
export class RecordShipments implements EventSubscriber {
  /** Exposed so the smoke test can prove the listener actually ran. */
  static readonly shipments: number[] = []

  subscribe(events: EventDispatcher): void {
    events.listen(OrderShipped, (event) => {
      RecordShipments.shipments.push(event.orderId)
      log().info('Order {orderId} shipped via {carrier}', {
        orderId: event.orderId,
        carrier: event.carrier
      })

      return `recorded:${event.orderId}`
    })

    // Wildcard listeners receive the resolved event name as well.
    events.listen('order.*', (name, payload) => {
      log().debug('wildcard saw {name}', { name, payload: JSON.stringify(payload) })
    })
  }
}
