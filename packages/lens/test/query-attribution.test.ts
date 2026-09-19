import { describe, expect, test } from 'bun:test'
import { enterWorkContext, inRequestContext, withoutRequestContext } from '@elvel/core'
import type { IncomingEntry } from '../src/entry.ts'
import type { EntryTypeName } from '../src/entry-type.ts'
import type { Recorder } from '../src/recorder.ts'
import { QueryWatcher } from '../src/watchers/query.ts'

/**
 * A stack that names no application file, which is what `Model.find` produces:
 * its promise is handed back rather than awaited, so the caller's frame is gone
 * before the connection can take one.
 */
const fromInsideTheFramework = [
  'Error',
  '    at run (/pkg/database/src/connection/bun-sql.ts:465:23)',
  '    at first (/pkg/database/src/model/builder.ts:1428:46)'
].join('\n')

function recordUnattributed(): IncomingEntry[] {
  const watcher = new QueryWatcher({ slow: 100, ignorePaths: ['/pkg/'] })
  const recorded: IncomingEntry[] = []

  const lens = {
    recording: () => true,
    record: (_type: EntryTypeName, candidate: IncomingEntry) => recorded.push(candidate)
  } as unknown as Recorder

  const reach = watcher as unknown as { record(lens: Recorder, event: unknown): void }

  reach.record(lens, {
    sql: 'select * from "articles" where "id" = ?',
    bindings: [7],
    time: 0.3,
    connectionName: 'main',
    stack: fromInsideTheFramework
  })

  return recorded
}

/**
 * A file of its own, because the rule turns on whether any context exists at
 * all — and `enterWorkContext` uses `enterWith`, which would leave one standing
 * for every test after it.
 */
describe('a query whose caller cannot be named', () => {
  test('is dropped when nothing is being served: this is the framework querying for itself', () => {
    expect(inRequestContext()).toBe(false)
    expect(recordUnattributed()).toHaveLength(0)
  })

  test('is recorded inside a unit of work, saying only that it has no line', () => {
    const recorded = withoutRequestContext(() => {
      enterWorkContext()

      return recordUnattributed()
    })

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.content.file).toBeNull()
    expect(recorded[0]?.content.sql).toContain('articles')
  })
})
