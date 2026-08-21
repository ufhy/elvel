import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { BunSqlConnection, QueryBuilder, SchemaBuilder } from '@elvel/database'
import { betterAuth } from 'better-auth'
import { Elysia } from 'elysia'
import { elvelAdapter, migrationFor } from '../src/adapter.ts'
import { type AuthUser, Gate } from '../src/gate.ts'
import { AuthManager, type AuthSession } from '../src/manager.ts'
import { Policy } from '../src/policy.ts'
import { AuthorizationError, AuthorizationResponse } from '../src/response.ts'
import { messageFrom, sessionSummaries, withSession } from '../src/responses.ts'

// -------------------------------------------------------------------- the gate

type Article = { id: number; authorId: string }

class ArticlePolicy extends Policy<Article> {
  static override allowGuests = ['viewAny']

  override before(user: AuthUser | null): boolean | undefined {
    return user?.email === 'admin@example.com' ? true : undefined
  }

  viewAny(): boolean {
    return true
  }

  view(_user: AuthUser, article: Article): boolean {
    return article.id > 0
  }

  create(): boolean {
    return true
  }

  update(user: AuthUser, article: Article): boolean | AuthorizationResponse {
    if (article.authorId !== user.id) return AuthorizationResponse.deny('Not yours.')

    return true
  }

  delete(user: AuthUser, article: Article): AuthorizationResponse | boolean {
    return article.authorId === user.id
      ? true
      : AuthorizationResponse.denyAsNotFound(`No article [${article.id}].`)
  }
}

class ArticleModel implements Article {
  constructor(
    readonly id: number,
    readonly authorId: string
  ) {}
}

class FeaturedArticle extends ArticleModel {}

const ada: AuthUser = { id: 'ada', email: 'ada@example.com' }
const linus: AuthUser = { id: 'linus', email: 'linus@example.com' }
const admin: AuthUser = { id: 'root', email: 'admin@example.com' }

function gateFor(user: AuthUser | null): Gate {
  const gate = new Gate(() => user)
  gate.policy(ArticleModel, ArticlePolicy)

  return gate
}

describe('Gate', () => {
  test('an ability decides by callback', async () => {
    const gate = new Gate(() => ada)
    gate.define('edit-settings', (current) => current?.email === 'ada@example.com')

    expect(await gate.allows('edit-settings')).toBe(true)
    expect(await gate.denies('edit-settings')).toBe(false)
  })

  test('an undefined ability denies rather than throwing', async () => {
    expect(await gateFor(ada).allows('nobody-defined-this')).toBe(false)
  })

  test('a guest is denied unless the ability opts in', async () => {
    const gate = new Gate(() => null)
    gate.define('read-public', () => true, { allowGuests: true })
    gate.define('read-private', () => true)

    expect(await gate.allows('read-public')).toBe(true)
    // The callback would have returned true; the guest never reaches it.
    expect(await gate.allows('read-private')).toBe(false)
  })

  test('a policy method is found from the model instance', async () => {
    const gate = gateFor(ada)
    const own = new ArticleModel(1, 'ada')

    expect(await gate.allows('view', own)).toBe(true)
    expect(await gate.allows('update', own)).toBe(true)
    expect(await gate.allows('update', new ArticleModel(2, 'linus'))).toBe(false)
  })

  test('a class argument finds the policy and is not passed on', async () => {
    // `create()` takes only the user: Laravel drops a leading class argument
    // because the policy already knows what it authorizes.
    expect(await gateFor(ada).allows('create', ArticleModel)).toBe(true)
  })

  test('a policy registered on a base class covers its subclasses', async () => {
    expect(await gateFor(ada).allows('view', new FeaturedArticle(3, 'ada'))).toBe(true)
  })

  test('a dashed ability maps onto the camelCase method', async () => {
    const gate = gateFor(ada)

    expect(await gate.allows('view-any', new ArticleModel(1, 'ada'))).toBe(true)
    expect(await gate.allows('view_any', new ArticleModel(1, 'ada'))).toBe(true)
  })

  test('a guest reaches only the abilities the policy lists', async () => {
    const gate = gateFor(null)

    expect(await gate.allows('viewAny', new ArticleModel(1, 'ada'))).toBe(true)
    expect(await gate.allows('view', new ArticleModel(1, 'ada'))).toBe(false)
  })

  test('the policy before() hook overrides every method', async () => {
    const gate = gateFor(admin)

    // `update` would deny: the article belongs to someone else.
    expect(await gate.allows('update', new ArticleModel(1, 'ada'))).toBe(true)
  })

  test('inspect carries the policy message and status', async () => {
    const denied = await gateFor(ada).inspect('update', new ArticleModel(2, 'linus'))

    expect(denied.denied()).toBe(true)
    expect(denied.message).toBe('Not yours.')
    expect(denied.status()).toBe(403)
  })

  test('a policy may deny as a 404', async () => {
    const denied = await gateFor(ada).inspect('delete', new ArticleModel(9, 'linus'))

    expect(denied.status()).toBe(404)
    expect(denied.message).toBe('No article [9].')
  })

  test('authorize throws with the status the policy chose', async () => {
    const gate = gateFor(ada)

    await expect(gate.authorize('delete', new ArticleModel(9, 'linus'))).rejects.toThrow(
      AuthorizationError
    )

    try {
      await gate.authorize('delete', new ArticleModel(9, 'linus'))
    } catch (error) {
      expect((error as AuthorizationError).status).toBe(404)
    }
  })

  test('before callbacks short-circuit, and null falls through', async () => {
    const seen: string[] = []
    const gate = new Gate(() => ada)

    gate.define('publish', () => {
      seen.push('ability')
      return false
    })
    gate.before(() => {
      seen.push('first')
      return undefined
    })
    gate.before((current) => (current?.email === 'ada@example.com' ? true : undefined))

    expect(await gate.allows('publish')).toBe(true)
    expect(seen).toEqual(['first'])
  })

  test('an after callback may supply a verdict but never overturn one', async () => {
    const gate = new Gate(() => ada)
    gate.define('known', () => false)
    gate.after(() => true)

    // A defined ability answered false; the after callback cannot flip it.
    expect(await gate.allows('known')).toBe(false)
    // Nothing answered this one, so the after callback decides.
    expect(await gate.allows('unknown')).toBe(true)
  })

  test('check, any and none combine abilities', async () => {
    const gate = new Gate(() => ada)
    gate.define('a', () => true)
    gate.define('b', () => false)

    expect(await gate.check(['a', 'a'])).toBe(true)
    expect(await gate.check(['a', 'b'])).toBe(false)
    expect(await gate.any(['a', 'b'])).toBe(true)
    expect(await gate.none(['b'])).toBe(true)
  })

  test('forUser answers for someone else without touching the original', async () => {
    const gate = gateFor(ada)
    const own = new ArticleModel(1, 'ada')

    expect(await gate.forUser(linus).allows('update', own)).toBe(false)
    expect(await gate.allows('update', own)).toBe(true)
  })

  test('allowIf and denyIf authorize on the spot', async () => {
    const gate = new Gate(() => ada)

    expect((await gate.allowIf(true)).allowed()).toBe(true)
    await expect(gate.allowIf(false, 'Nope.')).rejects.toThrow('Nope.')
    await expect(gate.denyIf(() => true, 'Denied.')).rejects.toThrow('Denied.')
  })

  test('a policy may be async', async () => {
    class AsyncPolicy extends Policy {
      async view(): Promise<boolean> {
        await Promise.resolve()
        return true
      }
    }

    const gate = new Gate(() => ada)
    gate.policy(ArticleModel, AsyncPolicy)

    expect(await gate.allows('view', new ArticleModel(1, 'ada'))).toBe(true)
  })

  test('gate.evaluated is dispatched with the outcome', async () => {
    const events: Array<Record<string, unknown>> = []
    const gate = new Gate(
      () => ada,
      () => ({
        dispatch: (event: string, payload?: unknown) => {
          events.push({ event, payload })
          return undefined
        }
      })
    )

    gate.define('ping', () => true)
    await gate.allows('ping')

    const [first] = events

    expect(first?.event).toBe('gate.evaluated')
    expect((first?.payload as { result: unknown } | undefined)?.result).toBe(true)
  })
})

describe('AuthorizationResponse', () => {
  test('allow and deny carry a message', () => {
    expect(AuthorizationResponse.allow('Fine.').allowed()).toBe(true)
    expect(AuthorizationResponse.deny().message).toBe('This action is unauthorized.')
  })

  test('an allowed response has no status', () => {
    expect(AuthorizationResponse.allow().status()).toBeUndefined()
    expect(AuthorizationResponse.denyWithStatus(402).status()).toBe(402)
  })

  test('authorize() throws only when denied', () => {
    expect(AuthorizationResponse.allow().authorize().allowed()).toBe(true)
    expect(() => AuthorizationResponse.deny('No.').authorize()).toThrow('No.')
  })
})

// ----------------------------------------------------------------- the manager

describe('AuthManager', () => {
  const session = (id: string): AuthSession => ({
    user: { id, email: `${id}@example.com` },
    session: { id: `session-${id}` }
  })

  const manager = new AuthManager({
    handler: async () => new Response(),
    api: { getSession: async () => null }
  })

  test('outside a request there is no user', () => {
    expect(manager.user()).toBeNull()
    expect(manager.check()).toBe(false)
    expect(manager.guest()).toBe(true)
  })

  test('runWith puts a user in scope, including for nested calls', async () => {
    const seen = await manager.runWith(session('ada'), async () => {
      const nested = async () => manager.id()

      return { direct: manager.user()?.id, nested: await nested() }
    })

    expect(seen).toEqual({ direct: 'ada', nested: 'ada' })
    // The scope is gone again once the callback returned.
    expect(manager.user()).toBeNull()
  })

  test('a resolve failure is a guest, not an error', async () => {
    const failing = new AuthManager({
      handler: async () => new Response(),
      api: {
        getSession: async () => {
          throw new Error('cookie is nonsense')
        }
      }
    })

    expect(await failing.resolve(new Request('http://localhost/'))).toBeNull()
  })

  /**
   * What `actingAs` stands on.
   *
   * The override has to sit inside `resolve()` rather than beside it, because
   * `resolve()` is the single door every path uses — `withSession`, `remember`,
   * and the provider's hook. An override anywhere else would work for one of
   * them and quietly not for the others.
   */
  test('impersonation overrides what better-auth would answer', async () => {
    const real = new AuthManager({
      handler: async () => new Response(),
      api: { getSession: async () => session('grace') }
    })

    expect((await real.resolve(new Request('http://localhost/')))?.user.id).toBe('grace')

    real.impersonate(session('ada'))
    expect((await real.resolve(new Request('http://localhost/')))?.user.id).toBe('ada')

    // Impersonating a guest is distinct from not impersonating at all.
    real.impersonate(null)
    expect(await real.resolve(new Request('http://localhost/'))).toBeNull()

    real.stopImpersonating()
    expect((await real.resolve(new Request('http://localhost/')))?.user.id).toBe('grace')
  })
})

describe('request scope', () => {
  /**
   * The scope has to survive from the hook that enters it into the handler, and
   * two concurrent requests must never see each other's user. This is the
   * arrangement the provider uses, reproduced here so a change in Elysia's hook
   * compilation cannot break it silently.
   */
  test('a synchronous hook carries the scope into the handler', async () => {
    const storage = new AsyncLocalStorage<{ who: string }>()
    const pending = new WeakMap<Request, string>()

    const app = new Elysia()
      .onRequest(async ({ request }) => {
        await Promise.resolve()
        pending.set(request, request.headers.get('x-who') ?? 'guest')
      })
      .onBeforeHandle({ as: 'global' }, ({ request }) => {
        storage.enterWith({ who: pending.get(request) ?? 'guest' })
      })
      .get('/who', async () => {
        await Promise.resolve()
        const deeper = async () => storage.getStore()?.who ?? null

        return { who: await deeper() }
      })

    const [ada, guest] = await Promise.all([
      app
        .handle(new Request('http://localhost/who', { headers: { 'x-who': 'ada' } }))
        .then((response) => response.json()),
      app.handle(new Request('http://localhost/who')).then((response) => response.json())
    ])

    expect(ada).toEqual({ who: 'ada' })
    expect(guest).toEqual({ who: 'guest' })
  })
})

// ----------------------------------------------------------------- the adapter

/** Declared so the test can hold the exact instance type `betterAuth` returns. */
function makeAuth(db: never) {
  return betterAuth({
    secret: 'a-test-secret-of-at-least-32-characters',
    baseURL: 'http://localhost',
    emailAndPassword: { enabled: true },
    database: elvelAdapter(db, { dialect: 'sqlite' })
  })
}

describe('elvelAdapter', () => {
  let connection: BunSqlConnection
  let auth: ReturnType<typeof makeAuth>

  const table = (name: string) => new QueryBuilder(connection, name)

  beforeEach(async () => {
    connection = await BunSqlConnection.make('auth-test', {
      driver: 'sqlite',
      database: ':memory:'
    })

    const schema = new SchemaBuilder(connection)

    await schema.create('user', (blueprint) => {
      blueprint.string('id').primary()
      blueprint.string('name')
      blueprint.string('email').unique()
      blueprint.boolean('emailVerified')
      blueprint.text('image').nullable()
      blueprint.timestamp('createdAt')
      blueprint.timestamp('updatedAt')
    })
    await schema.create('session', (blueprint) => {
      blueprint.string('id').primary()
      blueprint.timestamp('expiresAt')
      blueprint.text('token').unique()
      blueprint.timestamp('createdAt')
      blueprint.timestamp('updatedAt')
      blueprint.text('ipAddress').nullable()
      blueprint.text('userAgent').nullable()
      blueprint.string('userId')
    })
    await schema.create('account', (blueprint) => {
      blueprint.string('id').primary()
      blueprint.text('accountId')
      blueprint.text('providerId')
      blueprint.string('userId')
      blueprint.text('accessToken').nullable()
      blueprint.text('refreshToken').nullable()
      blueprint.text('idToken').nullable()
      blueprint.timestamp('accessTokenExpiresAt').nullable()
      blueprint.timestamp('refreshTokenExpiresAt').nullable()
      blueprint.text('scope').nullable()
      blueprint.text('password').nullable()
      blueprint.timestamp('createdAt')
      blueprint.timestamp('updatedAt')
    })
    await schema.create('verification', (blueprint) => {
      blueprint.string('id').primary()
      blueprint.text('identifier')
      blueprint.text('value')
      blueprint.timestamp('expiresAt')
      blueprint.timestamp('createdAt')
      blueprint.timestamp('updatedAt')
    })

    // The manager shape the adapter needs, bound to this one connection.
    const db = {
      connection: async () => connection,
      table: async (name: string) => new QueryBuilder(connection, name)
    } as never

    auth = makeAuth(db)
  })

  afterEach(async () => {
    await connection.disconnect()
  })

  test('signing up writes a user and an account through the query builder', async () => {
    const result = await auth.api.signUpEmail({
      body: { name: 'Ada', email: 'ada@example.com', password: 'secret123' }
    })

    expect(result.user.email).toBe('ada@example.com')

    const row = await table('user').where('email', '=', 'ada@example.com').first()
    expect(row?.name).toBe('Ada')
    // sqlite has no boolean, and better-auth asked for one: 0 on the way in.
    expect(row?.emailVerified).toBe(0)

    // The password lives on `account`, never on `user`.
    expect(await table('account').count()).toBe(1)
    expect(String((await table('account').first())?.password ?? '')).not.toBe('secret123')
  })

  test('a session is created and read back with its user', async () => {
    await auth.api.signUpEmail({
      body: { name: 'Ada', email: 'ada@example.com', password: 'secret123' }
    })

    const signedIn = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: 'secret123' },
      asResponse: true
    })

    const cookie = signedIn.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('better-auth.session_token')
    // Two: signing up already signs in, and signing in again opens another.
    expect(await table('session').count()).toBe(2)

    const headers = new Headers({ cookie: cookie.split(';')[0] ?? '' })
    const session = await auth.api.getSession({ headers })

    // The join is emulated by better-auth's own fallback, which is why the
    // adapter does not implement one.
    expect(session?.user.email).toBe('ada@example.com')
  })

  test('a duplicate e-mail is refused by the unique index', async () => {
    await auth.api.signUpEmail({
      body: { name: 'Ada', email: 'ada@example.com', password: 'secret123' }
    })

    await expect(
      auth.api.signUpEmail({
        body: { name: 'Ada again', email: 'ada@example.com', password: 'secret123' }
      })
    ).rejects.toThrow()

    expect(await table('user').count()).toBe(1)
  })

  test('dates round-trip as Dates even though sqlite stores text', async () => {
    const { user } = await auth.api.signUpEmail({
      body: { name: 'Ada', email: 'ada@example.com', password: 'secret123' }
    })

    expect(user.createdAt).toBeInstanceOf(Date)

    const stored = await table('user').where('email', '=', 'ada@example.com').first()
    expect(typeof stored?.createdAt).toBe('string')
  })
})

describe('migrationFor', () => {
  const tables = {
    user: {
      modelName: 'user',
      order: 1,
      fields: {
        name: { type: 'string' as const, required: true, sortable: true },
        email: { type: 'string' as const, required: true, unique: true, sortable: true },
        emailVerified: { type: 'boolean' as const, required: true },
        image: { type: 'string' as const, required: false },
        createdAt: { type: 'date' as const, required: true }
      }
    },
    session: {
      modelName: 'sessions',
      order: 2,
      fields: {
        token: { type: 'string' as const, required: true, unique: true },
        userId: {
          type: 'string' as const,
          required: true,
          index: true,
          references: { model: 'user', field: 'id', onDelete: 'cascade' as const }
        }
      }
    }
  }

  const code = migrationFor(tables as never, 'sqlite')

  test('tables come out in declared order, and drop in reverse', () => {
    expect(code.indexOf("create('user'")).toBeLessThan(code.indexOf("create('sessions'"))
    expect(code.indexOf("dropIfExists('sessions')")).toBeLessThan(
      code.indexOf("dropIfExists('user')")
    )
  })

  test('a string primary key is added, since better-auth generates ids', () => {
    expect(code).toContain("table.string('id').primary()")
  })

  test('modifiers follow the field attributes', () => {
    expect(code).toContain("table.string('email').unique()")
    expect(code).toContain("table.text('image').nullable()")
    expect(code).toContain("table.timestamp('createdAt')")
    expect(code).toContain("table.boolean('emailVerified')")
  })

  /**
   * MySQL refuses `BLOB/TEXT column 'token' used in key specification without a
   * key length`, so a `text` column carrying `.unique()` or `.index()` makes the
   * whole migration unrunnable there — and `session.token` is unique without
   * being `sortable`, so that was every application's migration, not an edge
   * case. Found by running a generated migration against a real MySQL for the
   * first time, in `dialects.test.ts`.
   */
  test('a keyed string is varchar, not text, whatever sortable says', () => {
    expect(code).toContain("table.string('token').unique()")
    expect(code).not.toMatch(/table\.text\('[A-Za-z]+'\)(\.nullable\(\))?\.(unique|index)\(\)/)
  })

  /**
   * `diffMigrationFor` renders only the tables that do not exist yet, and a
   * foreign key inside that subset still points at a schema key outside it.
   * Resolved against the subset, `userId → user` found nothing and fell back to
   * the raw key — so a diff adding a plugin emitted `.on('user')` against an
   * application whose table is called something else, and Postgres answered
   * `relation "user" does not exist`.
   */
  test('a subset still resolves a reference to a table outside it', () => {
    const subset = { session: tables.session } as never
    const rendered = migrationFor(subset, 'sqlite', tables as never)

    expect(rendered).toContain(".on('user')")
    expect(rendered).not.toContain("create('user'")
  })

  test('a reference targets the table its schema key resolves to', () => {
    // `references.model` is the schema key `user`; the FK must name the table.
    expect(code).toContain("table.foreign(['userId']).references(['id']).on('user')")
    expect(code).toContain(".onDelete('cascade')")
  })

  test('the generated file is a migration our migrator understands', () => {
    expect(code).toContain("import { Migration, type MigrationContext } from '@elvel/database'")
    expect(code).toContain('async up({ schema }: MigrationContext)')
    expect(code).toContain('async down({ schema }: MigrationContext)')
  })
})

describe('named guards', () => {
  test('a token guard identifies the caller its own way', async () => {
    const manager = new AuthManager({} as never)

    manager.extend('api', async (request) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '')

      return token === 'good-token' ? ({ id: 'svc-1', email: 'svc@example.com' } as never) : null
    })

    const request = new Request('http://localhost/api/orders', {
      headers: { authorization: 'Bearer good-token' }
    })

    await manager.runWith(null, async () => {
      manager.enterScope(null, request)

      // The session guard sees nobody; the token guard sees the service.
      expect<boolean>(manager.check()).toBe(false)
      expect<boolean>(await manager.guard('api').check()).toBe(true)
      expect<unknown>(await manager.guard('api').id()).toBe('svc-1')
    })
  })

  test('the resolver runs per call, so a revoked token stops working', async () => {
    const manager = new AuthManager({} as never)
    let revoked = false

    manager.extend('api', async () => (revoked ? null : ({ id: 'svc-1' } as never)))

    const request = new Request('http://localhost/api/orders')

    await manager.runWith(null, async () => {
      manager.enterScope(null, request)

      expect<boolean>(await manager.guard('api').check()).toBe(true)

      revoked = true

      // Nothing is cached across calls: a token revoked a second ago must not
      // still be trusted.
      expect<boolean>(await manager.guard('api').check()).toBe(false)
    })
  })

  test('an unknown guard names the ones that exist', () => {
    const manager = new AuthManager({} as never)

    expect(() => manager.guard('nope')).toThrow('Known guards: session')
  })

  test('a guard outside a request refuses rather than answering no', () => {
    const manager = new AuthManager({} as never)
    manager.extend('api', async () => null)

    // "No user" and "there is no request to read" are different answers, and
    // conflating them hides a bug in a console command.
    expect(() => manager.guard('api')).toThrow('only be used inside a request')
  })
})

describe('the response glue a server-rendered application needs', () => {
  test('withSession carries better-auth’s cookies onto the redirect', () => {
    const from = new Response(null, {
      headers: [
        ['set-cookie', 'session=abc; Path=/; HttpOnly'],
        ['set-cookie', 'other=def; Path=/']
      ]
    })

    const to = new Response(null, { status: 303, headers: { location: '/dashboard' } })
    const carried = withSession(from, to)

    // Without this the sign-in "works" and the browser is never given a
    // session, which is the bug this exists to prevent.
    expect<string[]>(carried.headers.getSetCookie()).toEqual([
      'session=abc; Path=/; HttpOnly',
      'other=def; Path=/'
    ])
    expect<number>(carried.status).toBe(303)
    expect(carried.headers.get('location')).toBe('/dashboard')
  })

  test('messageFrom prefers what better-auth said, and falls back quietly', async () => {
    const said = Response.json({ message: 'That address is already taken.' }, { status: 400 })
    const silent = new Response('not json at all', { status: 500 })

    expect(await messageFrom(said, 'Something went wrong.')).toBe('That address is already taken.')
    expect(await messageFrom(silent, 'Something went wrong.')).toBe('Something went wrong.')
  })

  test('sessionSummaries marks the browser doing the asking', () => {
    const headers = new Headers({ cookie: 'better-auth.session_token=tok-2.signature; other=1' })

    const rows = sessionSummaries(
      [
        { token: 'tok-1', userAgent: 'Firefox', ipAddress: '' },
        { token: 'tok-2', userAgent: 'Chrome', createdAt: new Date('2026-01-02T03:04:05Z') }
      ],
      headers
    )

    // Marking the wrong row current offers a "sign this out" button that ends
    // the session being read in.
    expect<boolean[]>(rows.map((row) => row.current)).toEqual([false, true])
    // An empty string is what better-auth stores when it was never told; `??`
    // would keep it and leave a row with neither a value nor a fallback.
    expect(rows[0]?.ipAddress).toBeUndefined()
    expect(rows[1]?.createdAt).toBe('2026-01-02 03:04')
  })

  test('and answers an empty list for anything that is not one', () => {
    expect<unknown[]>(sessionSummaries(undefined, new Headers())).toEqual([])
  })
})
