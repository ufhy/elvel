export { LogTailCommand } from './console/log-tail.ts'

import { app } from '@elyvel/core'

export type { LogContext, LogDriver, LoggerContract, LogLevel, LogRecord } from '@elyvel/contracts'
export { ConsoleDriver, type ConsoleDriverOptions } from './drivers/console.ts'
export { DailyDriver, type DailyDriverOptions, FileDriver } from './drivers/file.ts'
export { JsonDriver, type JsonDriverOptions } from './drivers/json.ts'
export {
  ErrorLogDriver,
  MemoryDriver,
  NullDriver,
  SlackDriver,
  type SlackDriverOptions,
  StackDriver
} from './drivers/misc.ts'
export { InvalidLogLevelError, isHandling, LEVEL_NAMES, LEVELS, severityOf } from './levels.ts'
export { interpolate, Logger, type LoggerOptions, MessageLogged } from './logger.ts'
export { type ChannelConfig, type DriverFactory, LogManager } from './manager.ts'
export { LogServiceProvider } from './provider.ts'

/**
 * The log manager — Laravel's `Log` facade.
 *
 * ```ts
 * log().info('User {id} signed in', { id: user.id })
 * log().channel('daily').warning('Disk almost full')
 * ```
 */
export function log() {
  return app('log')
}
