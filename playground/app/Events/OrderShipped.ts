/**
 * A class-based event: the instance is the payload.
 *
 * `eventName` keeps wildcard patterns (`order.*`) working regardless of what a
 * build step does to the class name.
 */
export class OrderShipped {
  static readonly eventName = 'order.shipped'

  constructor(
    readonly orderId: number,
    readonly carrier: string
  ) {}
}
