import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection, QueryBuilder, SchemaBuilder } from '@elvel/database'
import { DatabasePresenceVerifier } from '../src/provider.ts'
import { Rule } from '../src/types.ts'
import { Validator } from '../src/validator.ts'

/**
 * The `unique` and `exists` rules are the whole reason validation waited for the
 * database package, so they are tested against a real database rather than a
 * stubbed verifier.
 */
let connection: BunSqlConnection
let verifier: DatabasePresenceVerifier

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })

  await new SchemaBuilder(connection).create('users', (table) => {
    table.id()
    table.string('email')
    table.string('tenant').nullable()
    table.boolean('active').default(true)
  })

  await new QueryBuilder(connection, 'users').insert([
    { email: 'ada@example.com', tenant: 'a', active: 1 },
    { email: 'linus@example.com', tenant: 'b', active: 0 }
  ])

  // The verifier only needs `table(name)`; it is duck-typed so the validation
  // package carries no dependency on the database package.
  verifier = new DatabasePresenceVerifier({
    table: async (name: string) => new QueryBuilder(connection, name) as never
  })
})

afterEach(async () => {
  await connection.disconnect()
})

function validator(data: Record<string, unknown>, rules: Record<string, unknown>) {
  return new Validator(data, rules as never, { verifier })
}

describe('unique', () => {
  test('fails when the value is taken, passes when it is free', async () => {
    expect(await validator({ email: 'ada@example.com' }, { email: 'unique:users' }).fails()).toBe(
      true
    )
    expect(await validator({ email: 'new@example.com' }, { email: 'unique:users' }).fails()).toBe(
      false
    )
  })

  test('the message matches Laravel', async () => {
    const instance = validator({ email: 'ada@example.com' }, { email: 'unique:users' })
    await instance.passes()

    expect(instance.errors.first('email')).toBe('The email has already been taken.')
  })

  test('the column can be named explicitly', async () => {
    expect(
      await validator({ address: 'ada@example.com' }, { address: 'unique:users,email' }).fails()
    ).toBe(true)
  })

  test('an ignored id lets a row keep its own value on update', async () => {
    const taken = validator({ email: 'ada@example.com' }, { email: 'unique:users,email' })
    expect(await taken.fails()).toBe(true)

    // The string form: table,column,ignoreId,idColumn.
    const own = validator({ email: 'ada@example.com' }, { email: 'unique:users,email,1,id' })
    expect(await own.fails()).toBe(false)
  })

  test('the rule object form is equivalent, and reads better', async () => {
    const failing = new Validator(
      { email: 'ada@example.com' },
      { email: [Rule.unique('users', 'email')] },
      { verifier }
    )
    expect(await failing.fails()).toBe(true)

    const ignoring = new Validator(
      { email: 'ada@example.com' },
      { email: [Rule.unique('users', 'email').ignore(1)] },
      { verifier }
    )
    expect(await ignoring.fails()).toBe(false)
  })

  test('extra where constraints scope the check', async () => {
    // Same address, different tenant: unique within a tenant, not globally.
    const scoped = new Validator(
      { email: 'ada@example.com' },
      { email: [Rule.unique('users', 'email').where('tenant', 'b')] },
      { verifier }
    )

    expect(await scoped.fails()).toBe(false)

    const sameTenant = new Validator(
      { email: 'ada@example.com' },
      { email: [Rule.unique('users', 'email').where('tenant', 'a')] },
      { verifier }
    )

    expect(await sameTenant.fails()).toBe(true)
  })

  test('whereNot negates a constraint', async () => {
    const rule = Rule.unique('users', 'email').whereNot('tenant', 'a')

    expect(
      await new Validator({ email: 'ada@example.com' }, { email: [rule] }, { verifier }).fails()
    ).toBe(false)
  })

  test('the string form accepts trailing where pairs', async () => {
    const scoped = validator(
      { email: 'ada@example.com' },
      { email: 'unique:users,email,NULL,id,tenant,b' }
    )

    expect(await scoped.fails()).toBe(false)
  })

  test('an absent optional field never hits the database', async () => {
    // No verifier at all: if the rule ran, it would throw.
    const instance = new Validator({}, { email: 'unique:users' })

    expect(await instance.passes()).toBe(true)
  })
})

describe('exists', () => {
  test('passes when the value is present', async () => {
    expect(await validator({ email: 'ada@example.com' }, { email: 'exists:users' }).fails()).toBe(
      false
    )
    expect(
      await validator({ email: 'nobody@example.com' }, { email: 'exists:users' }).fails()
    ).toBe(true)
  })

  test('the message matches Laravel', async () => {
    const instance = validator({ email: 'nobody@example.com' }, { email: 'exists:users' })
    await instance.passes()

    expect(instance.errors.first('email')).toBe('The selected email is invalid.')
  })

  test('an array requires every value to exist', async () => {
    const all = validator(
      { emails: ['ada@example.com', 'linus@example.com'] },
      { emails: 'exists:users,email' }
    )
    expect(await all.fails()).toBe(false)

    const partial = validator(
      { emails: ['ada@example.com', 'nobody@example.com'] },
      { emails: 'exists:users,email' }
    )
    expect(await partial.fails()).toBe(true)
  })

  test('duplicates in the input are counted once', async () => {
    const duplicated = validator(
      { emails: ['ada@example.com', 'ada@example.com'] },
      { emails: 'exists:users,email' }
    )

    expect(await duplicated.fails()).toBe(false)
  })

  test('extra constraints narrow the lookup', async () => {
    const wrongTenant = new Validator(
      { email: 'ada@example.com' },
      { email: [Rule.exists('users', 'email').where('tenant', 'b')] },
      { verifier }
    )

    expect(await wrongTenant.fails()).toBe(true)
  })
})

describe('without a database', () => {
  test('the rule explains itself instead of failing obscurely', async () => {
    const instance = new Validator({ email: 'ada@example.com' }, { email: 'unique:users' })

    await expect(instance.passes()).rejects.toThrow(/needs a database/)
  })
})

describe('alongside the rest of the rules', () => {
  test('a full registration payload', async () => {
    const instance = new Validator(
      {
        name: 'Ada',
        email: 'new@example.com',
        password: 'secret123',
        password_confirmation: 'secret123',
        tenant: 'a',
        role: 'admin',
        is_admin: true
      },
      {
        name: 'required|string|min:2',
        email: 'required|email|unique:users,email',
        password: 'required|min:8|confirmed',
        tenant: ['required', Rule.exists('users', 'tenant')],
        role: 'required|in:admin,member'
      },
      { verifier }
    )

    expect(await instance.passes()).toBe(true)

    // `is_admin` was never validated, so it cannot reach a database write.
    expect(instance.validated()).toEqual({
      name: 'Ada',
      email: 'new@example.com',
      password: 'secret123',
      tenant: 'a',
      role: 'admin'
    })
  })

  test('a failing payload reports every field once', async () => {
    const instance = new Validator(
      { email: 'ada@example.com', password: 'short', role: 'root' },
      {
        name: 'required',
        email: 'required|email|unique:users,email',
        password: 'required|min:8|confirmed',
        role: 'in:admin,member'
      },
      { verifier }
    )

    expect(await instance.passes()).toBe(false)
    expect(instance.errors.messages()).toEqual({
      name: ['The name field is required.'],
      email: ['The email has already been taken.'],
      password: [
        'The password field must be at least 8 characters.',
        'The password field confirmation does not match.'
      ],
      role: ['The selected role is invalid.']
    })
  })
})
