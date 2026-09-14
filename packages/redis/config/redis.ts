/**
 * Where Redis is, said once.
 *
 * The cache, the queue and the broadcaster each opened their own client from
 * their own config key, so an application using all three named the same server
 * three times and held at least four connections per process. When this package
 * is registered they resolve a named connection from here instead; each keeps
 * its own key as an override, for the case where they genuinely belong on
 * different servers.
 */
export default {
  /** The connection resolved when nobody asks for one by name. */
  default: process.env.REDIS_CONNECTION ?? 'default',

  connections: {
    default: {
      url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

      /** Namespaces every key, so two applications on one server stay apart. */
      prefix: process.env.REDIS_PREFIX ?? ''
    },

    /**
     * A cache on a server of its own, which is the usual second connection.
     *
     * Worth separating because a cache flush should not reach the queue, and a
     * cache evicting keys under memory pressure should not evict jobs.
     */
    cache: {
      url: process.env.REDIS_CACHE_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      prefix: process.env.REDIS_CACHE_PREFIX ?? ''
    },

    /**
     * Several nodes.
     *
     * A hash ring over clients rather than cluster protocol: a key routes to the
     * same node every time, which is what a cache or a set of queues needs. It
     * does not follow a `MOVED` redirect, so a cluster that reshards while
     * running needs a client that speaks the protocol.
     */
    cluster: {
      nodes: (process.env.REDIS_CLUSTER_NODES ?? '')
        .split(',')
        .map((node) => node.trim())
        .filter((node) => node !== '')
    }
  }
}
