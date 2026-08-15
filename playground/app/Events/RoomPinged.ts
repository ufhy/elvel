/**
 * Generated with `bun run playground make:event RoomPinged`, then extended.
 *
 * An event that broadcasts itself. Declaring `broadcastOn()` is all it takes —
 * there is no interface to implement, because TypeScript erases interfaces and a
 * marker nothing can check at runtime is not a marker.
 *
 * Dispatching it is an ordinary `dispatch(new RoomPinged(...))`: listeners run as
 * they always do, and the sockets on the channel hear it as well.
 */
export class RoomPinged {
  static readonly eventName = 'room.pinged'

  constructor(
    readonly room: string,
    readonly note: string
  ) {}

  /** Where it goes. A list is allowed; one channel is the common case. */
  broadcastOn(): string {
    return `room.${this.room}`
  }

  /** What clients switch on. Without this it would be the class name. */
  broadcastAs(): string {
    return 'room.pinged'
  }

  /**
   * What travels.
   *
   * Without this the event's own fields go, which is usually right and is
   * exactly what you do not want when one of them is a model, a secret, or the
   * whole of somebody's order.
   */
  broadcastWith(): Record<string, unknown> {
    return { note: this.note }
  }
}
