/**
 * The entry types the dashboard knows about.
 *
 * A plain object rather than a TypeScript `enum`: the values are what land in a
 * `varchar(20)` column and what the dashboard puts in a URL, so they have to be
 * these exact strings and nothing should be able to renumber them.
 */
export const EntryType = {
  BATCH: 'batch',
  CACHE: 'cache',
  CLIENT_REQUEST: 'client_request',
  COMMAND: 'command',
  DUMP: 'dump',
  EVENT: 'event',
  EXCEPTION: 'exception',
  GATE: 'gate',
  JOB: 'job',
  LOG: 'log',
  MAIL: 'mail',
  MODEL: 'model',
  NOTIFICATION: 'notification',
  QUERY: 'query',
  REDIS: 'redis',
  REQUEST: 'request',
  SCHEDULED_TASK: 'schedule',
  VIEW: 'view'
} as const

export type EntryTypeName = (typeof EntryType)[keyof typeof EntryType]

/** Every type, for the dashboard's navigation and for validating a route. */
export function entryTypes(): EntryTypeName[] {
  return Object.values(EntryType)
}
