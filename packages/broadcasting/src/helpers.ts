import { app } from '@elysian/core'
import type { Broadcaster } from './broadcaster.ts'
import type { ChannelRegistry } from './channels.ts'

export function broadcaster(): Broadcaster {
  return app('broadcaster')
}

/** Where an application declares its channels. */
export function channels(): ChannelRegistry {
  return app('channels')
}

/**
 * Send an event to a channel — `broadcast('orders.7', 'updated', { total })`.
 *
 * Returns how many sockets it reached, which is the only honest answer: nothing
 * about a broadcast guarantees delivery, and a caller that needs to know
 * somebody received it needs a different mechanism.
 */
export function broadcast(
  channel: string,
  event: string,
  payload: unknown,
  except?: string
): number {
  return broadcaster().broadcast({ channel, event, payload }, except)
}
