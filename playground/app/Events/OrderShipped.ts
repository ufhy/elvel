/**
 * OrderShipped
 *
 * A class-based event is a plain data holder: the instance *is* the payload.
 * `eventName` is declared so wildcard listeners and any build step that renames
 * classes both keep working.
 */
export class OrderShipped {
  static readonly eventName = 'order.shipped'

  constructor(
    readonly orderId: number,
    readonly carrier: string
  ) {}

  /**
   * A method, deliberately.
   *
   * A queued listener runs in another process, so only the data travels; this
   * still works there because the worker rebuilds the event from its class.
   */
  label(): string {
    return `${this.carrier}-${this.orderId}`
  }
}
