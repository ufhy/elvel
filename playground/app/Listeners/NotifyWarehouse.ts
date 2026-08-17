import { cache } from '@elyvel/cache'
import { QueuedListener } from '@elyvel/events'
import { log } from '@elyvel/log'
import type { OrderShipped } from '../Events/OrderShipped.ts'

/**
 * Generated with `artisan make:listener NotifyWarehouse --event OrderShipped
 * --queued`, then extended.
 *
 * Runs in a worker rather than in the request. It writes to the cache so a route
 * can prove *when* it ran — the smoke test checks that nothing happened until a
 * worker picked the job up.
 */
export class NotifyWarehouse extends QueuedListener<OrderShipped> {
  static override queue = 'shipments'

  static override tries = 3

  /**
   * Nothing reaches the queue until the outermost transaction commits.
   *
   * A worker is another process: reserve this job before the commit and it finds
   * none of the rows the event is about. `/signal/queued/:id/rollback` proves the
   * other half — a transaction that fails queues nothing at all.
   */
  static override afterCommit = true

  async handle(event: OrderShipped): Promise<void> {
    log().info('Warehouse notified for order {orderId}', { orderId: event.orderId })

    // `label()` is a method on the event class: it only works because the worker
    // rebuilt the event rather than handing over loose JSON.
    await cache().put(`warehouse:${event.orderId}`, event.label(), 300)
  }

  override async failed(event: OrderShipped, error: unknown): Promise<void> {
    await cache().put(`warehouse:failed:${event.orderId}`, (error as Error).message, 300)
  }
}
