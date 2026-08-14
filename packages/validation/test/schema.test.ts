import { describe, expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import { fromJsonSchema, fromTypeBox, type ObjectSchema, Schema, toTypeBox } from '../src/index.ts'

describe('building a document', () => {
  test('a string with its constraints', () => {
    expect(
      Schema.string()
        .min(3)
        .max(20)
        .pattern(/^[a-z]+$/)
        .format('email')
        .toJsonSchema()
    ).toEqual({
      type: 'string',
      minLength: 3,
      maxLength: 20,
      pattern: '^[a-z]+$',
      format: 'email'
    })
  })

  test('numbers keep integer and number apart', () => {
    expect(Schema.integer().min(0).multipleOf(5).toJsonSchema()).toEqual({
      type: 'integer',
      minimum: 0,
      multipleOf: 5
    })
    expect(Schema.number().max(1.5).toJsonSchema()).toEqual({ type: 'number', maximum: 1.5 })
  })

  test('an object collects required from its children', () => {
    const schema = Schema.object({
      name: Schema.string().required(),
      email: Schema.string().format('email').required(),
      age: Schema.integer()
    }).withoutAdditionalProperties()

    expect(schema.toJsonSchema()).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string', format: 'email' },
        age: { type: 'integer' }
      },
      // Declared on each child, gathered here, which is where JSON Schema wants it.
      required: ['name', 'email'],
      additionalProperties: false
    })
  })

  test('an object with nothing required omits the key entirely', () => {
    // `required: []` is legal and noisy; absent says the same thing.
    expect(Schema.object({ a: Schema.string() }).toJsonSchema()).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } }
    })
  })

  test('a field can be defined once and required in one place only', () => {
    const email = () => Schema.string().format('email')

    const signup = Schema.object({ email: email().required() })
    const filter = Schema.object({ email: email() })

    expect(signup.toJsonSchema().required).toEqual(['email'])
    expect(filter.toJsonSchema().required).toBeUndefined()
  })

  test('arrays carry their item schema', () => {
    expect(Schema.array(Schema.string().min(1)).min(1).max(5).unique().toJsonSchema()).toEqual({
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      maxItems: 5,
      uniqueItems: true
    })
  })

  test('nullable appends null to the type', () => {
    expect(Schema.string().nullable().toJsonSchema()).toEqual({ type: ['string', 'null'] })
    expect(Schema.union('string', 'integer').nullable().toJsonSchema()).toEqual({
      type: ['string', 'integer', 'null']
    })
  })

  test('anyOf composes whole schemas, and nullable adds a branch', () => {
    const schema = Schema.anyOf(Schema.string().min(3), Schema.integer().min(0)).nullable()

    expect(schema.toJsonSchema()).toEqual({
      anyOf: [
        { type: 'string', minLength: 3 },
        { type: 'integer', minimum: 0 },
        // A branch, not a type: there is no single `type` keyword to append to.
        { type: 'null' }
      ]
    })
  })

  test('title, description, enum and default ride along', () => {
    expect(
      Schema.string()
        .title('Role')
        .description('What they may do')
        .enum(['admin', 'user'])
        .default('user')
        .toJsonSchema()
    ).toEqual({
      type: 'string',
      title: 'Role',
      description: 'What they may do',
      enum: ['admin', 'user'],
      default: 'user'
    })
  })

  test('a null default survives', () => {
    // Tracked by a flag, not by `!== undefined`, so this is not dropped.
    expect(Schema.string().nullable().default(null).toJsonSchema().default).toBeNull()
  })
})

describe('reading a document back', () => {
  test('round trips an object', () => {
    const original = Schema.object({
      name: Schema.string().min(2).required(),
      tags: Schema.array(Schema.string()).unique(),
      age: Schema.integer().min(0).nullable()
    })
      .withoutAdditionalProperties()
      .toJsonSchema()

    expect(fromJsonSchema(original).toJsonSchema()).toEqual(original)
  })

  test('a required child comes back required', () => {
    const built = fromJsonSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['b']
    }) as ObjectSchema

    expect(built.shape.b?.mandatory).toBe(true)
    expect(built.shape.a?.mandatory).toBe(false)
  })

  test('["string","null"] keeps the string constraints', () => {
    // Read as a one-name union it would lose minLength on the way through.
    const built = fromJsonSchema({ type: ['string', 'null'], minLength: 4 })

    expect(built.toJsonSchema()).toEqual({ type: ['string', 'null'], minLength: 4 })
  })

  test('resolves a $ref into the same document', () => {
    const built = fromJsonSchema({
      type: 'object',
      properties: { home: { $ref: '#/$defs/address' } },
      $defs: { address: { type: 'object', properties: { city: { type: 'string' } } } }
    })

    expect(built.toJsonSchema()).toMatchObject({
      properties: { home: { type: 'object', properties: { city: { type: 'string' } } } }
    })
  })

  test('refuses a $ref that points at itself', () => {
    expect(() =>
      fromJsonSchema({ $ref: '#/$defs/loop', $defs: { loop: { $ref: '#/$defs/loop' } } })
    ).toThrow(/points back at itself/)
  })

  test('refuses a $ref it cannot find', () => {
    expect(() => fromJsonSchema({ $ref: '#/$defs/nowhere' })).toThrow(/could not be resolved/)
  })

  test('refuses a fragment with no type at all', () => {
    expect(() => fromJsonSchema({ minLength: 3 })).toThrow(/no \[type\] and no \[anyOf\]/)
  })

  test('refuses a type it does not model, rather than dropping it', () => {
    // Quietly ignoring half a schema produces a validator that accepts what the
    // schema forbade, which is worse than failing here.
    expect(() => fromJsonSchema({ type: 'tuple' })).toThrow(
      /Unsupported JSON Schema type \[tuple\]/
    )
  })
})

describe('the TypeBox bridge', () => {
  test('builds a real TypeBox schema, not a cast', () => {
    const built = toTypeBox(Schema.object({ name: Schema.string().min(3).required() }))

    // t.Unsafe() would look identical here and throw when Elysia compiles it.
    expect(fromTypeBox(built)).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string', minLength: 3 } },
      required: ['name']
    })
  })

  test('a built schema validates over a real route', async () => {
    const body = toTypeBox(
      Schema.object({
        name: Schema.string().min(3).required(),
        age: Schema.integer().min(0)
      })
    )

    const app = new Elysia().post('/people', ({ body }) => body, { body })
    await app.modules

    const good = await app.handle(
      new Request('http://localhost/people', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', age: 36 })
      })
    )
    const bad = await app.handle(
      new Request('http://localhost/people', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'A' })
      })
    )

    expect(good.status).toBe(200)
    expect(await good.json()).toEqual({ name: 'Ada', age: 36 })
    expect(bad.status).toBe(422)
  })

  test('an optional property is optional on the route', async () => {
    const app = new Elysia().post('/x', ({ body }) => body, {
      body: toTypeBox(
        Schema.object({ name: Schema.string().required(), nickname: Schema.string() })
      )
    })
    await app.modules

    const response = await app.handle(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' })
      })
    )

    expect(response.status).toBe(200)
  })

  test('a TypeBox schema comes back as plain JSON Schema', () => {
    const plain = fromTypeBox(t.Object({ name: t.String({ minLength: 2 }) }))

    // The Kind symbols are TypeBox's dispatch table, not part of the schema.
    expect(Object.getOwnPropertySymbols(plain).length).toBe(0)
    expect(plain).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string', minLength: 2 } }
    })
  })

  /**
   * Elysia's `t` is not vanilla TypeBox.
   *
   * `t.Integer()` there is an `anyOf` of a numeric string and an integer, so a
   * query parameter arriving as `"36"` validates. That coercion is right for
   * HTTP and surprising in a published document, so it is asserted rather than
   * hidden: anything handing `fromTypeBox` output to a client should expect it.
   */
  test('Elysia widens some types for coercion, and that shows', () => {
    const plain = fromTypeBox(t.Object({ id: t.Integer({ minimum: 1 }) }))
    const id = (plain.properties as Record<string, { anyOf?: unknown[] }>).id

    expect(Array.isArray(id?.anyOf)).toBe(true)
    expect(id?.anyOf).toContainEqual({ type: 'integer', minimum: 1 })
  })

  test('TypeBox out, builder in, TypeBox again', async () => {
    const original = t.Object({ email: t.String({ format: 'email' }) })
    const rebuilt = toTypeBox(fromJsonSchema(fromTypeBox(original)).toJsonSchema())

    const app = new Elysia().post('/x', () => 'ok', { body: rebuilt })
    await app.modules

    const response = await app.handle(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com' })
      })
    )

    expect(response.status).toBe(200)
  })

  test('says what it cannot build', () => {
    expect(() => toTypeBox({ type: 'tuple' })).toThrow(/Cannot build a TypeBox schema from type/)
  })
})
