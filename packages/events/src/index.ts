import { app } from '@elvel/core'

export type {
  EventDispatcher,
  EventSubscriber,
  Listener,
  WildcardListener
} from '@elvel/contracts'
export { Dispatcher, eventName, type QueuedListenerPusher } from './dispatcher.ts'
export { EventRegistry } from './event-registry.ts'
export { EventFake, NullDispatcher } from './fake.ts'
export {
  type AnyQueuedListenerClass,
  isQueuedListener,
  ListenerRegistry,
  listenerName,
  QueuedListener,
  type QueuedListenerClass
} from './listener.ts'
export { EventServiceProvider } from './provider.ts'

/** The application's dispatcher. */
export function events() {
  return app('events')
}

/**
 * Dispatch an event.
 *
 * ```ts
 * await dispatch(new UserRegistered(user))
 * await dispatch('cache.cleared', { store: 'redis' })
 * ```
 */
export function dispatch<E extends object>(event: E): Promise<unknown[] | null>
export function dispatch(event: string, payload?: unknown): Promise<unknown[] | null>
export function dispatch(event: object | string, payload?: unknown): Promise<unknown[] | null> {
  return typeof event === 'string' ? events().dispatch(event, payload) : events().dispatch(event)
}
