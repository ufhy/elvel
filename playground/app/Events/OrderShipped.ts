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
}
