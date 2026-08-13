import { beforeEach, describe, expect, test } from 'bun:test'
import type { Connection, Row } from '../src/connection/connection.ts'
import { ReadWriteConnection } from '../src/connection/read-write.ts'
import { TransactionManager } from '../src/connection/transactions.ts'

/** A connection that records what it was asked, and nothing else. */
function spy(label: string, transactions?: TransactionManager) {
  const calls: string[] = []

  const connection = {
    name: label,
    grammar: {} as never,
    transactions,
    calls,
    select: async <T = Row>(sql: string) => {
      calls.push(`select:${sql}`)

      return [] as T[]
    },
    affectingStatement: async (sql: string) => {
      calls.push(`affecting:${sql}`)

      return 1
    },
    statement: async (sql: string) => {
      calls.push(`statement:${sql}`)
    },
    unprepared: async (sql: string) => {
      calls.push(`unprepared:${sql}`)
    },
    transaction: async <T>(callback: (tx: Connection) => Promise<T>) => {
      calls.push('transaction')

      return callback(connection as unknown as Connection)
    },
    afterCommit: async () => {
      calls.push('afterCommit')
    },
    afterRollback: () => {
      calls.push('afterRollback')
    },
    disconnect: async () => {
      calls.push('disconnect')
    }
  }

  return connection
}

let writer: ReturnType<typeof spy>
let reader: ReturnType<typeof spy>
let transactions: TransactionManager

beforeEach(() => {
  transactions = new TransactionManager()
  writer = spy('writer', transactions)
  reader = spy('reader')
})

const pair = (sticky = false) =>
  new ReadWriteConnection(writer as unknown as Connection, reader as unknown as Connection, sticky)

describe('routing', () => {
  test('a read goes to the replica', async () => {
    await pair().select('select 1')

    expect(reader.calls).toEqual(['select:select 1'])
    expect(writer.calls).toEqual([])
  })

  test('every write goes to the primary', async () => {
    const connection = pair()

    await connection.statement('create table t (id int)')
    await connection.affectingStatement('update t set id = 1')
    await connection.unprepared('vacuum')

    expect(reader.calls).toEqual([])
    expect(writer.calls).toHaveLength(3)
  })

  test('a transaction runs on the primary, and hands out the primary', async () => {
    let inside: Connection | undefined

    await pair().transaction(async (tx) => {
      inside = tx
    })

    // A callback given the replica would let a read inside the transaction miss
    // the rows that transaction just wrote.
    expect(inside?.name).toBe('writer')
  })

  test('reads inside a transaction go to the primary', async () => {
    const connection = pair()

    transactions.begin()
    await connection.select('select 1')
    await transactions.commit()

    // The replica cannot see uncommitted rows.
    expect(writer.calls).toEqual(['select:select 1'])
    expect(reader.calls).toEqual([])
  })
})

describe('sticky', () => {
  test('off: a read after a write still goes to the replica', async () => {
    const connection = pair(false)

    await connection.statement('insert into t values (1)')
    await connection.select('select 1')

    expect(reader.calls).toEqual(['select:select 1'])
  })

  test('on: a read after a write goes to the primary', async () => {
    const connection = pair(true)

    await connection.statement('insert into t values (1)')
    await connection.select('select 1')

    // Replication lags: reading your own write off the replica looks like a bug
    // in your code rather than in the cluster.
    expect(reader.calls).toEqual([])
    expect(writer.calls).toEqual(['statement:insert into t values (1)', 'select:select 1'])
  })

  test('and forgetting the modifications sends reads back to the replica', async () => {
    const connection = pair(true)

    await connection.statement('insert into t values (1)')
    expect(connection.hasModifiedRecords).toBe(true)

    connection.forgetRecordModifications()

    expect(connection.hasModifiedRecords).toBe(false)

    await connection.select('select 1')
    expect(reader.calls).toEqual(['select:select 1'])
  })
})

describe('delegation', () => {
  test('after-commit hooks belong to the primary', async () => {
    const connection = pair()

    await connection.afterCommit(() => undefined)
    connection.afterRollback(() => undefined)

    expect(writer.calls).toEqual(['afterCommit', 'afterRollback'])
    expect(reader.calls).toEqual([])
  })

  test('disconnect closes both', async () => {
    await pair().disconnect()

    expect(writer.calls).toEqual(['disconnect'])
    expect(reader.calls).toEqual(['disconnect'])
  })

  test('the pair reports the primary’s name and grammar', () => {
    expect(pair().name).toBe('writer')
    expect(pair().transactions).toBe(transactions)
  })
})
