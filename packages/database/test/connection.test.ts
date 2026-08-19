import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { pickHost } from '../src/connection/manager.ts'

describe('choosing a replica', () => {
  test('a weight decides how often a host is picked', () => {
    const hosts = [
      { host: 'small', weight: 1 },
      { host: 'large', weight: 9 }
    ]

    const counts = new Map<string, number>()

    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const host = String(pickHost(hosts).host)
      counts.set(host, (counts.get(host) ?? 0) + 1)
    }

    // Replicas are rarely identical: sending half the traffic to the small one
    // is how the small one becomes the bottleneck. Loose bounds, because this
    // is random by design.
    expect<boolean>((counts.get('large') ?? 0) > (counts.get('small') ?? 0) * 3).toBe(true)
  })

  test('an unweighted list is uniform, as before', () => {
    const seen = new Set<string>()

    for (let attempt = 0; attempt < 200; attempt += 1) {
      seen.add(String(pickHost([{ host: 'a' }, { host: 'b' }]).host))
    }

    expect<number>(seen.size).toBe(2)
  })

  test('a zero weight drains a host out of the rotation', () => {
    const hosts = [
      { host: 'draining', weight: 0 },
      { host: 'live', weight: 1 }
    ]

    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect<string>(String(pickHost(hosts).host)).toBe('live')
    }
  })

  test('but draining every host reads anyway', () => {
    // A config that excludes everything is a mistake; an outage is worse.
    expect<boolean>(
      ['a', 'b'].includes(
        String(
          pickHost([
            { host: 'a', weight: 0 },
            { host: 'b', weight: 0 }
          ]).host
        )
      )
    ).toBe(true)
  })
})

describe('what a sqlite connection is opened with', () => {
  const open = (options: Record<string, unknown> = {}) =>
    BunSqlConnection.make('probe', { driver: 'sqlite', ...options } as never)

  const file = async () => join(await mkdtemp(join(tmpdir(), 'elvel-sqlite-')), 'probe.sqlite')

  test('a file database is opened in WAL, and waits rather than refusing', async () => {
    const connection = await open({ database: await file() })

    try {
      /**
       * The rollback journal locks the whole database for a write, so a second
       * process is refused outright — `database is locked`, with nothing to wait
       * for. That is one test suite and one `elvel serve` on one machine.
       */
      expect<unknown>(await connection.select('PRAGMA journal_mode')).toEqual([
        { journal_mode: 'wal' }
      ])
      expect<unknown>(await connection.select('PRAGMA busy_timeout')).toEqual([{ timeout: 5000 }])
    } finally {
      await connection.disconnect()
    }
  })

  test('two connections can write the same file at once', async () => {
    const database = await file()
    const one = await open({ database })
    const two = await open({ database })

    try {
      await one.unprepared('create table probe (id integer primary key, note text)')

      await Promise.all([
        one.unprepared("insert into probe (note) values ('one')"),
        two.unprepared("insert into probe (note) values ('two')")
      ])

      expect<unknown>(await one.select('select count(*) as n from probe')).toEqual([{ n: 2 }])
    } finally {
      await one.disconnect()
      await two.disconnect()
    }
  })

  test('both are configurable, for a filesystem where WAL cannot work', async () => {
    // A network share, most notably: WAL needs shared memory.
    const connection = await open({
      database: await file(),
      journalMode: 'delete',
      busyTimeout: 250
    })

    try {
      expect<unknown>(await connection.select('PRAGMA journal_mode')).toEqual([
        { journal_mode: 'delete' }
      ])
      expect<unknown>(await connection.select('PRAGMA busy_timeout')).toEqual([{ timeout: 250 }])
    } finally {
      await connection.disconnect()
    }
  })

  test('an in-memory database is left alone', async () => {
    const connection = await open({ database: ':memory:' })

    try {
      // Nothing to contend for, and no journal to switch: asking for WAL there
      // is not an error but it is not anything either.
      expect<unknown>(await connection.select('PRAGMA journal_mode')).toEqual([
        { journal_mode: 'memory' }
      ])
    } finally {
      await connection.disconnect()
    }
  })
})
