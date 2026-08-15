/**
 * Where broadcasts go, and how far they reach.
 *
 * `memory` fans an event out to the websockets connected to **this process**.
 * That is the whole story for one server — and for every development machine —
 * so it is the default: requiring Redis to send an event to a socket in your own
 * process would be requiring it for nothing.
 *
 * `redis` is what makes a broadcast cross processes. Behind a load balancer one
 * process holds half the sockets and another holds the rest, and with `memory`
 * the second half never hears the event. On `redis` every broadcast is published
 * to the bus and every process — including the one that published it — writes it
 * out to the sockets it holds. Nothing else changes: the same `broadcast()`, the
 * same channels, the same authorisation.
 */
export default {
  driver: process.env.BROADCAST_DRIVER ?? 'memory',

  /** Where the websocket endpoint is served. */
  path: process.env.BROADCAST_PATH ?? '/broadcast',

  redis: {
    url: process.env.BROADCAST_REDIS_URL ?? process.env.REDIS_URL,

    /** Namespaces the bus, so two applications on one Redis stay apart. */
    prefix: process.env.BROADCAST_REDIS_PREFIX ?? 'elysian:'
  }
}
