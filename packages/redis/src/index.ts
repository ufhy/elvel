/**
 * Redis — one manager, named connections, and commands you can see.
 *
 * The cache, the queue and the broadcaster each built their own client from
 * their own config key, so an application using all three opened at least four
 * connections per process and named the same server three times. They resolve
 * from here when this package is registered, and keep working exactly as they
 * did when it is not.
 */
export {
  type CommandDispatcher,
  CommandExecuted,
  CommandFailed,
  type ConnectionOptions,
  RedisConnection
} from './connection.ts'
export { connection, redis } from './helpers.ts'
export { RedisManager } from './manager.ts'
export { RedisServiceProvider } from './provider.ts'
