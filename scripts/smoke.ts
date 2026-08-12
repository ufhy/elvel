#!/usr/bin/env bun
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import pc from 'picocolors'

/**
 * Smoke test — boots the real playground application and exercises the seams
 * that unit tests cannot reach: the bootstrap sequence end to end, Edge
 * rendering, static file serving, the exception handler, Artisan command
 * discovery, the code generators, and a real `listen()` on a socket.
 *
 * Run it on every framework change: `bun run smoke` (or `bun run verify`).
 *
 * Unlike the tests in `tests/`, this runs against `playground/` — the same
 * skeleton `bun run create` hands to users — so a broken template or a broken
 * stub fails here even when every package's unit tests still pass.
 */

const failures: string[] = []
let checks = 0

function check(label: string, condition: boolean, detail?: string): void {
  checks += 1
  if (condition) {
    console.log(`  ${pc.green('✔')} ${label}`)
    return
  }
  console.log(`  ${pc.red('✖')} ${label}${detail ? pc.dim(` — ${detail}`) : ''}`)
  failures.push(label)
}

function section(title: string): void {
  console.log(`\n${pc.bold(title)}`)
}

/**
 * Collect everything written to stdout *and* stderr while `body` runs.
 *
 * Both streams matter: commands report failures through `console.error`, and the
 * exception handler logs stack traces there for the deliberate error routes.
 */
async function captureOutput(body: () => Promise<unknown> | unknown): Promise<string> {
  const originalLog = console.log
  const originalError = console.error
  const lines: string[] = []

  const collect = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }

  console.log = collect
  console.error = collect

  try {
    await body()
  } finally {
    console.log = originalLog
    console.error = originalError
  }

  return lines.join('\n')
}

// Built from a char code rather than a literal escape so the source file
// carries no control character of its own.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Strip ANSI colours so assertions do not depend on terminal styling. */
function plain(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

console.log(pc.bold(pc.cyan('\nElysian smoke test')))

const app = (await import('../playground/bootstrap/app.ts')).default

// ---------------------------------------------------------------- bootstrap

section('Bootstrap')
check('config files loaded', app.config.get<string>('app.name') !== undefined)
check('view binding registered', app.bound('view'))
check('events binding registered', app.bound('events'))
check('log binding registered', app.bound('log'))
check('db binding registered', app.bound('db'))
check('artisan binding registered', app.bound('artisan'))
check('routes mounted', app.router.routes.length >= 8, `${app.router.routes.length} routes`)

// --------------------------------------------------------------------- http

section('HTTP')

const landing = await app.handle(new Request('http://localhost/'))
const landingHtml = await landing.text()
check(
  'GET / is 200 text/html',
  landing.status === 200 && landing.headers.get('content-type')?.includes('text/html') === true
)
check('renderer prepends the doctype', landingHtml.startsWith('<!DOCTYPE html>'))
check('layout renders the title prop', landingHtml.includes('<title>Welcome'))
check('page body arrives as children', landingHtml.includes('<section class="hero">'))

const exercise = await app.handle(new Request('http://localhost/exercise/view'))
const exerciseHtml = await exercise.text()
check('view receives typed props', exerciseHtml.includes('<h1>Exercise</h1>'))
check(
  'array props map to elements',
  ['alpha', 'beta', 'gamma'].every((item) => exerciseHtml.includes(`<li>${item}</li>`))
)
check('conditionals render', exerciseHtml.includes('More than two items.'))
check('layout reads config() directly', exerciseHtml.includes('local'))
check(
  'safe escapes untrusted input',
  exerciseHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;') &&
    !exerciseHtml.includes('<script>alert(1)</script>')
)

const asyncView = await app.handle(new Request('http://localhost/exercise/async'))
check('async components resolve', (await asyncView.text()).includes('Hello Elysian'))

const raw = (await (await app.handle(new Request('http://localhost/exercise/render'))).json()) as {
  html: string
}
check('render() returns markup as a string', raw.html.includes('<h1>Raw</h1>'))

const support = (await (
  await app.handle(new Request('http://localhost/exercise/support'))
).json()) as Record<string, unknown>
check('Str.studly', support.studly === 'SendReports')
check('Str.plural', support.plural === 'categories')
check('Str.slug', support.slug === 'hello-world')
check('Arr.get dot access', support.dot === 'deep')
check('Collection chain', JSON.stringify(support.collection) === '[2,4,6]')

const configured = (await (
  await app.handle(new Request('http://localhost/exercise/config'))
).json()) as Record<string, unknown>
check('config() helper reads config', configured.name === app.config.get<string>('app.name'))
check('config() helper honours fallbacks', configured.missing === 'fallback')

const health = await app.handle(new Request('http://localhost/health'))
check('plain objects serialise to JSON', (await health.json()).status === 'ok')

const asset = await app.handle(new Request('http://localhost/css/app.css'))
check(
  'static assets are served from public/',
  asset.status === 200 && (asset.headers.get('content-type') ?? '').includes('text/css')
)

// ---------------------------------------------------------------- signals

section('Events')

// The listener logs on purpose; capture so the checks stay readable.
let dispatchResponse!: Response
await captureOutput(async () => {
  dispatchResponse = await app.handle(new Request('http://localhost/signal/dispatch'))
})

const dispatched = (await dispatchResponse.json()) as {
  responses: unknown[]
  recorded: number[]
}

check('a discovered listener runs without manual wiring', dispatched.recorded.includes(42))
check('listener responses come back to the caller', dispatched.responses.includes('recorded:42'))

const wildcard = (await (
  await app.handle(new Request('http://localhost/signal/wildcard'))
).json()) as { seen: string[] }

check(
  'wildcard patterns match by name',
  wildcard.seen.includes('probe.one') && wildcard.seen.includes('probe.two')
)
check('wildcard patterns do not over-match', !wildcard.seen.includes('unrelated.three'))

const halting = (await (
  await app.handle(new Request('http://localhost/signal/halting'))
).json()) as { order: string[]; responses: unknown[]; until: unknown }

check(
  'returning false stops propagation',
  halting.order.length === 1 && halting.order[0] === 'first'
)
check('until() returns the first non-null response', halting.until === 'answer')

section('Logging')

const logged = (await (await app.handle(new Request('http://localhost/signal/log'))).json()) as {
  channel: string
  levels: string[]
  messages: string[]
  context: Record<string, unknown>
}

check('extend() registers a custom driver', logged.channel === 'probe')
check('the level threshold drops quieter records', !logged.levels.includes('debug'))
check('records above the threshold are kept', logged.levels.join(',') === 'info,error')
check('placeholders interpolate from context', logged.messages.includes('User 7 signed in'))
check('withContext sticks to every record', logged.context.request_id === 'fixed-for-the-test')

section('Database')

// The playground is configured for sqlite; use a throwaway in-memory connection
// so the smoke test never touches the checked-in database file.
app.config.set('database.connections.smoke', { driver: 'sqlite', database: ':memory:' })

const smokeSchema = await app.make('db').schema('smoke')
await smokeSchema.create('smoke_users', (table) => {
  table.id()
  table.string('email').unique()
  table.boolean('active').default(true)
  table.timestamps()
})

check('schema builder creates a table', await smokeSchema.hasTable('smoke_users'))
check(
  'columns match the blueprint',
  (await smokeSchema.getColumnListing('smoke_users')).join(',') ===
    'id,email,active,created_at,updated_at'
)

const smokeUsers = await app.make('db').table('smoke_users', 'smoke')
const insertedId = await smokeUsers.insertGetId({ email: 'ada@example.com' })

check('insertGetId returns the new key', insertedId === 1)
check('defaults are applied', (await smokeUsers.where('id', 1).value<number>('active')) === 1)
check('count reads back', (await smokeUsers.count()) === 1)

let duplicateRejected = false
try {
  await smokeUsers.insert({ email: 'ada@example.com' })
} catch {
  duplicateRejected = true
}
check('the unique index is enforced', duplicateRejected)

// `artisan` is resolved further down; use the container directly here.
const statusOutput = plain(
  await captureOutput(() => app.make('artisan').run(['migrate:status', '--database', 'smoke']))
)
check(
  'migrate:status works before the tracking table exists',
  statusOutput.includes('MIGRATION') && statusOutput.includes('no')
)

// Everything below reads and writes through models, so give the app a fresh
// in-memory database as its *default* connection and run the real migrations and
// seeders against it. The checked-in sqlite file is never touched, and the
// assertions below do not depend on whatever state it happens to be in.
app.config.set('database.connections.smoke_default', { driver: 'sqlite', database: ':memory:' })
app.make('db').setDefaultConnection('smoke_default')

const migrateOutput = plain(
  await captureOutput(() => app.make('artisan').run(['migrate', '--force']))
)
check('the real migrations run on a fresh database', migrateOutput.includes('migration(s) applied'))

const seedOutput = plain(await captureOutput(() => app.make('artisan').run(['db:seed'])))
check('the real seeders run', seedOutput.includes('Seeding finished'))

section('Validation')

const registered = await app.handle(
  new Request('http://localhost/check/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'secret123',
      password_confirmation: 'secret123',
      role: 'member'
    })
  })
)

const registeredBody = (await registered.json()) as { validated?: Record<string, unknown> }

check('a valid payload passes both phases', registered.status === 200)
check(
  'validated() drops what was never validated',
  registeredBody.validated !== undefined && !('password_confirmation' in registeredBody.validated)
)

const rejected = await app.handle(
  new Request('http://localhost/check/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'A',
      email: 'not-an-email',
      password: 'short',
      password_confirmation: 'different',
      role: 'admin'
    })
  })
)

const rejectedBody = (await rejected.json()) as { errors?: Record<string, string[]> }

check('an invalid payload is a 422', rejected.status === 422)
check('every failing field is reported', Object.keys(rejectedBody.errors ?? {}).length === 4)
check(
  'required_if fires from another field',
  rejectedBody.errors?.team?.[0]?.includes('required when role is admin') === true
)
check(
  'confirmed compares the twin field',
  rejectedBody.errors?.password?.some((message) => message.includes('confirmation')) === true
)

// Phase one rejects a wrong *shape* before the handler runs at all.
const malformed = await captureOutput(() =>
  app.handle(
    new Request('http://localhost/check/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 42 })
    })
  )
)
check('phase one rejects a bad shape before the handler', malformed !== undefined)

const excluded = (await (
  await app.handle(
    new Request('http://localhost/check/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'cash', card_number: 'nonsense' })
    })
  )
).json()) as { passed: boolean; validated: Record<string, unknown> }

check('exclude_if drops the field instead of failing it', excluded.passed)
check('the excluded field is absent from validated()', !('card_number' in excluded.validated))

const unique = (await (await app.handle(new Request('http://localhost/check/unique'))).json()) as {
  passes: boolean
}
check('the unique rule reaches the real database', unique.passes === true)

section('HTTP: form requests, resources, session, CSRF')

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
  )
}

// These routes run the whole stack: form request → model → resource, against the
// migrated and seeded database above. Also exercised by hand over the network
// with `artisan serve` + curl, which is what caught the two bugs this section
// now guards: `withCount()` lost by `clone()`, and `whenLoaded()` returning the
// relation *method* instead of the loaded relation.

const created = await postJson('/check/articles', {
  title: '  Trimmed title  ',
  slug: 'trimmed-title',
  body: 'Long enough body text.',
  status: 'draft'
})
const createdBody = (await created.json()) as { data?: Record<string, unknown> }

check('a valid form request creates a model', created.status === 201)
check('prepareForValidation ran', createdBody.data?.title === 'Trimmed title')
check('the model came back with its new key', createdBody.data?.id === 5)

const invalid = await postJson('/check/articles', {
  title: 'x',
  slug: 'whatever',
  status: 'published'
})
const invalidBody = (await invalid.json()) as { errors?: Record<string, string[]> }

check('an invalid form request is a 422 with the bag', invalid.status === 422)
check(
  'the failing rule decides the message, not the field',
  invalidBody.errors?.title?.[0] === 'The title field must be at least 3 characters.'
)
check(
  'required_if fired from the sibling field',
  invalidBody.errors?.published_at?.[0]?.includes('required when status is published') === true
)

const duplicate = await postJson('/check/articles', {
  title: 'A duplicate slug',
  slug: 'article-0',
  body: 'Long enough body text.',
  status: 'draft'
})
const duplicateBody = (await duplicate.json()) as { errors?: Record<string, string[]> }

check('the unique rule reaches the database from a form request', duplicate.status === 422)
check(
  'and names the taken field',
  duplicateBody.errors?.slug?.[0] === 'The slug has already been taken.'
)

const forbidden = await postJson('/check/articles', { forbidden: 'yes', title: 'x' })
check('authorize() refusing is a 403, not a 422', forbidden.status === 403)
check('a refused request leaks no field errors', !('errors' in (await forbidden.json())))

const collection = (await (
  await app.handle(new Request('http://localhost/check/articles?perPage=2'))
).json()) as {
  data?: Array<Record<string, unknown>>
  meta?: { total?: number; lastPage?: number }
}

check('a resource collection is wrapped', Array.isArray(collection.data))
check('paginate() limits the page', collection.data?.length === 2)
check(
  'pagination totals travel as meta',
  collection.meta?.total === 5 && collection.meta?.lastPage === 3
)
check('a cast turns 0/1 into a boolean', collection.data?.[0]?.featured === true)
check(
  'a json cast decodes',
  (collection.data?.[0]?.meta as { index?: number } | undefined)?.index === 0
)
check('an accessor with no column appears', String(collection.data?.[0]?.excerpt).endsWith('…'))
check('withCount survives paginate()', collection.data?.[0]?.commentCount === 2)
check('and reports zero for a childless row', collection.data?.[1]?.commentCount === 0)
check('merge() flattens into the item', collection.data?.[0]?.self === '/check/articles/1')
check(
  'an unloaded relation is absent, not null',
  collection.data?.[0] !== undefined && !('comments' in collection.data[0])
)
check(
  'a field the viewer may not see is absent',
  collection.data?.[0] !== undefined && !('status' in collection.data[0])
)

const scoped = (await (
  await app.handle(new Request('http://localhost/check/articles?published=yes'))
).json()) as { data?: Array<Record<string, unknown>>; meta?: { total?: number } }
check('a local scope narrows the query', scoped.meta?.total === 2)

const eager = (await (
  await app.handle(new Request('http://localhost/check/articles/with-comments'))
).json()) as { data?: Array<{ comments?: Array<Record<string, unknown>> }> }

check(
  'an eager-loaded relation is nested through its own resource',
  eager.data?.[0]?.comments?.length === 2
)
check('the nested resource shapes the children', eager.data?.[0]?.comments?.[0]?.author === 'Ada')
check('a row with no children gets an empty relation', eager.data?.[1]?.comments?.length === 0)

const asEditor = (await (
  await app.handle(new Request('http://localhost/check/articles/1?editor=yes&withComments=yes'))
).json()) as { data?: Record<string, unknown> }
check('a permitted field appears', asEditor.data?.status === 'published')
check(
  'load() fills the relation after the fact',
  (asEditor.data?.comments as unknown[] | undefined)?.length === 2
)

// Captured because the handler reports the exception; the checks stay readable.
let missingStatus = 0
await captureOutput(async () => {
  missingStatus = (await app.handle(new Request('http://localhost/check/articles/999'))).status
})
check('a missing model is a 404', missingStatus === 404)

const trashed = (await (
  await app.handle(new Request('http://localhost/check/articles/5', { method: 'DELETE' }))
).json()) as { trashed?: boolean; visible?: number; withTrashed?: number }

check('delete() soft deletes', trashed.trashed === true)
check('the default query stops seeing it', trashed.visible === 4)
check('withTrashed still does', trashed.withTrashed === 5)

const restored = (await (await postJson('/check/articles/5/restore', {})).json()) as {
  trashed?: boolean
  visible?: number
}

check('restore() brings it back', restored.trashed === false && restored.visible === 5)

// The session routes are deliberately not CSRF-exempt.
const tokenResponse = await app.handle(new Request('http://localhost/session/token'))
const tokenBody = (await tokenResponse.json()) as { token: string }
const cookie = tokenResponse.headers.get('set-cookie') ?? ''

check('a session cookie is issued', cookie.includes('elysian_session='))
check(
  'the cookie is HttpOnly and SameSite=Lax',
  cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax')
)
check('a session carries a CSRF token', tokenBody.token.length === 40)

const jarCookie = cookie.split(';')[0] as string

const blocked = await postJson('/session/visit', {}, { cookie: jarCookie })
check('a write without a CSRF token is a 419', blocked.status === 419)

const allowed = await postJson('/session/visit', { _token: tokenBody.token }, { cookie: jarCookie })
check('a write with the token succeeds', allowed.status === 200)

const withHeader = await postJson(
  '/session/visit',
  {},
  { cookie: jarCookie, 'x-csrf-token': tokenBody.token }
)
check('the token is also accepted from the header', withHeader.status === 200)

const tampered = await postJson(
  '/session/visit',
  { _token: `${tokenBody.token}x` },
  { cookie: jarCookie }
)
check('a wrong token is rejected', tampered.status === 419)

// Read the flash on the very next request: any request in between ages it by
// one, which is exactly what flash data means.
const flashed = (await (
  await app.handle(
    new Request('http://localhost/session/status', { headers: { cookie: jarCookie } })
  )
).json()) as { status: string | null }
check('flash data survives exactly one request', flashed.status === 'Visited!')

const visited = (await (
  await app.handle(
    new Request('http://localhost/session/token', { headers: { cookie: jarCookie } })
  )
).json()) as { visits: number }
check('session data persists across requests', visited.visits === 2)

const gone = (await (
  await app.handle(
    new Request('http://localhost/session/status', { headers: { cookie: jarCookie } })
  )
).json()) as { status: string | null }
check('and is gone on the next one', gone.status === null)

const forged = await postJson('/session/visit', { _token: tokenBody.token })
check('a token without the matching session cookie is rejected', forged.status === 419)

// --------------------------------------------------------------------- auth

section('Auth: better-auth on our adapter, and the Gate')

/** Sign in and return the better-auth cookie, ignoring any other. */
async function signIn(email: string, password = 'secret123'): Promise<string> {
  const response = await postJson('/api/auth/sign-in/email', { email, password })
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
  const found = cookies.find((value) => value.startsWith('better-auth.session_token')) ?? ''

  return found.split(';')[0] ?? ''
}

const signedUp = await postJson('/api/auth/sign-up/email', {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'secret123'
})
check('better-auth signs a user up through our adapter', signedUp.status === 200)

const users = await app.make('db').table('user')
check('the user landed in our own table', (await users.count()) === 1)
check(
  'the password is hashed on the account, not on the user',
  (await (await app.make('db').table('account')).count()) === 1
)

// A second sign-up must lose to the unique index the generated migration wrote.
const duplicateUser = await captureOutput(() =>
  postJson('/api/auth/sign-up/email', {
    name: 'Ada again',
    email: 'ada@example.com',
    password: 'secret123'
  })
)
check('a duplicate e-mail is refused', duplicateUser !== undefined && (await users.count()) === 1)

const adaCookie = await signIn('ada@example.com')
check('signing in issues a session cookie', adaCookie.startsWith('better-auth.session_token='))
check('the session row is ours too', (await (await app.make('db').table('session')).count()) >= 1)

const guestWho = (await (
  await app.handle(new Request('http://localhost/check/whoami'))
).json()) as { guest: boolean }
check('a request with no cookie is a guest', guestWho.guest === true)

let unauthenticated = 0
await captureOutput(async () => {
  unauthenticated = (await app.handle(new Request('http://localhost/check/me'))).status
})
check('a route that requires a user answers 401', unauthenticated === 401)

const me = (await (
  await app.handle(new Request('http://localhost/check/me', { headers: { cookie: adaCookie } }))
).json()) as { email?: string; verified?: boolean }
check('the signed-in user reaches the handler', me.email === 'ada@example.com')
check('and arrives unverified', me.verified === false)

// Two requests at once: the scope is per request, not per process.
const [scopedAda, scopedGuest] = await Promise.all([
  app
    .handle(new Request('http://localhost/check/whoami', { headers: { cookie: adaCookie } }))
    .then((response) => response.json() as Promise<{ email: string | null }>),
  app
    .handle(new Request('http://localhost/check/whoami'))
    .then((response) => response.json() as Promise<{ email: string | null }>)
])
check(
  'concurrent requests do not share the user',
  scopedAda.email === 'ada@example.com' && scopedGuest.email === null
)

const abilities = (await (
  await app.handle(
    new Request('http://localhost/check/abilities', { headers: { cookie: adaCookie } })
  )
).json()) as { statusPage: boolean; admin: boolean }
check('an ability may allow guests', abilities.statusPage === true)
check('an ability the user does not have denies', abilities.admin === false)

const unverified = await captureOutput(() => Promise.resolve())
void unverified

let refused!: Response
await captureOutput(async () => {
  refused = await postJson(
    '/check/guarded/articles',
    { title: 'Ada article', slug: 'ada-article', body: 'Body long enough.' },
    { cookie: adaCookie }
  )
})
const refusedBody = (await refused.json()) as { message?: string }
check('a policy denial is a 403', refused.status === 403)
check(
  "and carries the policy's own message",
  refusedBody.message === 'Verify your e-mail before publishing.'
)

// better-auth's tables are ordinary tables on our connection, which is what lets
// an administrative task like this one use the query builder.
await (await app.make('db').table('user'))
  .where('email', '=', 'ada@example.com')
  .update({ emailVerified: 1 })

const authored = await postJson(
  '/check/guarded/articles',
  { title: 'Ada article', slug: 'ada-article', body: 'Body long enough.' },
  { cookie: adaCookie }
)
const authoredBody = (await authored.json()) as { id?: number; author_id?: string }
check('the same request passes once the policy is satisfied', authored.status === 201)
check(
  'the handler read the author from the request scope',
  typeof authoredBody.author_id === 'string'
)

const ownUpdate = await app.handle(
  new Request(`http://localhost/check/guarded/articles/${authoredBody.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: adaCookie },
    body: JSON.stringify({ title: 'Ada article, edited' })
  })
)
check('the owner may update', ownUpdate.status === 200)

let foreignUpdate!: Response
await captureOutput(async () => {
  foreignUpdate = await app.handle(
    new Request('http://localhost/check/guarded/articles/1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adaCookie },
      body: JSON.stringify({ title: 'Hostile takeover' })
    })
  )
})
check('someone else’s article is refused', foreignUpdate.status === 403)

let hidden!: Response
await captureOutput(async () => {
  hidden = await app.handle(
    new Request('http://localhost/check/guarded/articles/2', {
      method: 'DELETE',
      headers: { cookie: adaCookie }
    })
  )
})
check('a policy may deny as a 404 instead of admitting the row exists', hidden.status === 404)

await postJson('/api/auth/sign-up/email', {
  name: 'Admin',
  email: 'admin@example.com',
  password: 'secret123'
})
const adminCookie = await signIn('admin@example.com')

const adminUpdate = await app.handle(
  new Request('http://localhost/check/guarded/articles/1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ title: 'Admin edited' })
  })
)
check('the policy before() hook overrides ownership', adminUpdate.status === 200)

const adminAbilities = (await (
  await app.handle(
    new Request('http://localhost/check/abilities', { headers: { cookie: adminCookie } })
  )
).json()) as { admin: boolean }
check('an ability the user does have allows', adminAbilities.admin === true)

// better-auth refuses a cookie-bearing write with no `Origin` — its own CSRF
// defence, and the reason these endpoints are exempt from the session package's.
// A browser always sends one; a smoke test has to say so explicitly.
const origin = app.config.get<string>('app.url', 'http://localhost:3000')

const forgedSignOut = await postJson('/api/auth/sign-out', {}, { cookie: adaCookie })
check('better-auth refuses a write with no Origin', forgedSignOut.status === 403)

const untrustedSignOut = await postJson(
  '/api/auth/sign-out',
  {},
  { cookie: adaCookie, origin: 'http://evil.example.com' }
)
check('and refuses an untrusted one', untrustedSignOut.status === 403)

const signedOut = await postJson('/api/auth/sign-out', {}, { cookie: adaCookie, origin })
check('signing out from a trusted origin is handled', signedOut.status === 200)

const afterSignOut = (await (
  await app.handle(new Request('http://localhost/check/whoami', { headers: { cookie: adaCookie } }))
).json()) as { guest: boolean }
check('the session is gone once signed out', afterSignOut.guest === true)

// -------------------------------------------------------------------- cache

section('Cache: every driver through the same routes')

/**
 * The point of running the same routes per store is that a cache which behaves
 * differently per driver is worse than none: code written against the array store
 * has to keep working against Redis.
 */
const stores = ['array', 'file', 'database']

// Redis only when a server answers, as the dialect suites do.
const redisReachable = await (async () => {
  try {
    const probe = app.make('cache').store('redis')

    await probe.put('smoke:probe', 1, 5)
    await probe.forget('smoke:probe')

    return true
  } catch {
    console.log(`  ${pc.dim('skipping redis: no server reachable')}`)

    return false
  }
})()

if (redisReachable) stores.push('redis')

for (const store of stores) {
  await app.handle(
    new Request(`http://localhost/check/cache/articles?store=${store}`, { method: 'DELETE' })
  )

  const first = (await (
    await app.handle(new Request(`http://localhost/check/cache/articles?store=${store}`))
  ).json()) as { titles: string[]; queried: boolean }

  const second = (await (
    await app.handle(new Request(`http://localhost/check/cache/articles?store=${store}`))
  ).json()) as { titles: string[]; queried: boolean }

  check(
    `${store}: remember runs the query once`,
    first.queried && !second.queried && second.titles.length === first.titles.length
  )

  const basics = (await (
    await app.handle(new Request(`http://localhost/check/cache/basics?store=${store}`))
  ).json()) as Record<string, unknown>

  check(
    `${store}: add writes only when absent`,
    basics.added === true && basics.addedAgain === false
  )
  check(`${store}: increment counts`, basics.counter === 5)
  check(
    `${store}: structured values round-trip`,
    JSON.stringify(basics.shape) === '{"nested":{"ok":true},"list":[1,2]}'
  )
  check(`${store}: pull reads and forgets`, basics.pulled === 'first' && basics.afterPull === null)
  check(`${store}: a miss falls back`, basics.missing === 'fallback')

  const tags = (await (
    await app.handle(new Request(`http://localhost/check/cache/tags?store=${store}`))
  ).json()) as { people: string | null; places: string | null }

  check(
    `${store}: flushing one tag leaves the others`,
    tags.people === null && tags.places === 'tagged-places'
  )

  const lock = (await (
    await app.handle(
      new Request(`http://localhost/check/cache/lock?store=${store}`, { method: 'POST' })
    )
  ).json()) as { acquired: boolean; contenderTimedOut: boolean }

  check(
    `${store}: a lock is exclusive and times a contender out`,
    lock.acquired && lock.contenderTimedOut
  )
}

// Stale-while-revalidate, on the array store so the timing is not disk-bound.
await app.handle(new Request('http://localhost/check/cache/flexible?reset=yes&store=array'))

const fresh = (await (
  await app.handle(new Request('http://localhost/check/cache/flexible?store=array'))
).json()) as { age: number }
check('flexible serves a fresh value immediately', fresh.age < 1000)

await Bun.sleep(1100)

const stale = (await (
  await app.handle(new Request('http://localhost/check/cache/flexible?store=array'))
).json()) as { age: number }
check('a stale value is served rather than recomputed inline', stale.age > 1000)

await Bun.sleep(200)

const refreshed = (await (
  await app.handle(new Request('http://localhost/check/cache/flexible?store=array'))
).json()) as { age: number }
check('and the refresh happened in the background', refreshed.age < 1000)

await app.handle(new Request('http://localhost/check/cache/limit', { method: 'DELETE' }))

const attempts: number[] = []
for (let attempt = 0; attempt < 3; attempt += 1) {
  attempts.push(
    (await app.handle(new Request('http://localhost/check/cache/limit', { method: 'POST' }))).status
  )
}
check(
  'the rate limiter allows up to the limit',
  attempts.slice(0, 2).every((code) => code === 200)
)
check('and answers 429 past it', attempts[2] === 429)

const limited = (await (
  await app.handle(new Request('http://localhost/check/cache/limit', { method: 'POST' }))
).json()) as { retryAfter?: number }
check('with a retry-after the client can use', (limited.retryAfter ?? 0) > 0)

// The commands, on the real store.
const cleared = plain(await captureOutput(() => app.make('artisan').run(['cache:clear'])))
check('cache:clear flushes the default store', cleared.includes('flushed'))

await app.make('cache').store().put('smoke:key', 'value', 60)
const forgotten = plain(
  await captureOutput(() => app.make('artisan').run(['cache:forget', 'smoke:key']))
)
check('cache:forget removes one key', forgotten.includes('Forgotten: smoke:key'))

const missing = plain(
  await captureOutput(() => app.make('artisan').run(['cache:forget', 'smoke:never']))
)
check('and says so when the key was not cached', missing.includes('Not cached'))

await app.make('cache').store('database').put('smoke:pruned', 'value', 1)
await Bun.sleep(1100)

const pruned = plain(
  await captureOutput(() => app.make('artisan').run(['cache:prune', '--store', 'database']))
)
check('cache:prune deletes expired rows', /Pruned [1-9]/.test(pruned))

const nothingToPrune = plain(
  await captureOutput(() => app.make('artisan').run(['cache:prune', '--store', 'array']))
)
check(
  'and explains itself on a store that expires its own entries',
  nothingToPrune.includes('nothing to prune')
)

// Leave nothing behind: the file store writes into storage/, and Redis is shared.
for (const store of stores) await app.make('cache').store(store).flush()

// ---------------------------------------------------------------- exceptions

section('Exceptions')

// The handler reports these to stderr on purpose; capture so the smoke output
// stays readable instead of burying the checks under stack traces.
const errorResponses = await (async () => {
  let notFound!: Response
  let boom!: Response
  let unknownPath!: Response

  await captureOutput(async () => {
    notFound = await app.handle(new Request('http://localhost/exercise/not-found'))
    boom = await app.handle(new Request('http://localhost/exercise/boom'))
    unknownPath = await app.handle(new Request('http://localhost/no-such-page'))
  })

  return { notFound, boom, unknownPath }
})()

check(
  'HttpException keeps its status and message',
  errorResponses.notFound.status === 404 &&
    (await errorResponses.notFound.json()).message === 'Deliberately missing'
)
check('unhandled errors become 500', errorResponses.boom.status === 500)
check(
  'unknown paths render a humanised 404',
  errorResponses.unknownPath.status === 404 &&
    (await errorResponses.unknownPath.json()).message === 'Not Found'
)

// ------------------------------------------------------------------- console

section('Console')

const artisan = app.make('artisan')
const commandNames = artisan.all().map((command) => command.signature.split(' ')[0])

check(
  'framework commands registered',
  ['serve', 'route:list', 'about'].every((name) => commandNames.includes(name))
)
check('generators registered', commandNames.filter((name) => name?.startsWith('make:')).length >= 7)
check('application commands are discovered', commandNames.includes('ping'))

const pingOutput = plain(
  await captureOutput(() => artisan.run(['ping', 'elysian', '--repeat', '2']))
)
check('signature arguments bind', pingOutput.includes('pong elysian'))
check('repeatable execution honours options', pingOutput.split('pong elysian').length - 1 === 2)

const loudOutput = plain(await captureOutput(() => artisan.run(['ping', 'world', '--loud'])))
check('boolean flags bind', loudOutput.includes('PONG WORLD'))

let unknownCommandStatus = 0
const unknownCommandOutput = plain(
  await captureOutput(async () => {
    unknownCommandStatus = await artisan.run(['nope:nope'])
  })
)
check(
  'unknown commands exit non-zero and explain',
  unknownCommandStatus === 1 && unknownCommandOutput.includes('is not defined')
)

const aboutOutput = plain(await captureOutput(() => artisan.run(['about'])))
check('about reports the environment', aboutOutput.includes('Application Name'))

let routeListStatus = 1
const routeListOutput = plain(
  await captureOutput(async () => {
    routeListStatus = await artisan.run(['route:list'])
  })
)
check(
  'route:list lists the mounted routes',
  routeListStatus === 0 && routeListOutput.includes('/exercise/view')
)

const help = plain(await captureOutput(() => artisan.run(['make:controller', '--help'])))
check(
  '--help documents arguments and options',
  help.includes('<name>') && help.includes('--resource')
)

// ----------------------------------------------------------------- generators

section('Generators')

const generated = [
  app.appPath('Http', 'Controllers', 'SmokeThingController.ts'),
  app.appPath('Http', 'Controllers', 'nested', 'SmokeNestedController.ts'),
  app.resourcePath('views', 'smoke', 'probe.tsx'),
  app.appPath('Providers', 'SmokeServiceProvider.ts'),
  app.appPath('Console', 'Commands', 'SmokeJob.ts'),
  app.resourcePath('views', 'components', 'SmokeAlert.tsx'),
  app.appPath('Events', 'SmokeHappened.ts'),
  app.appPath('Listeners', 'RecordSmoke.ts')
]

try {
  await captureOutput(() => artisan.run(['make:controller', 'SmokeThing', '--resource']))
  const controllerSource = await Bun.file(generated[0] as string).text()
  check('make:controller --resource writes a file', controllerSource.length > 0)
  check(
    'resource stub names the controller instance',
    controllerSource.includes("controller('smoke-thing'")
  )
  check('resource stub pluralises the prefix', controllerSource.includes("'/smoke-things'"))

  await captureOutput(() => artisan.run(['make:controller', 'nested/SmokeNested']))
  check('nested names create subdirectories', await Bun.file(generated[1] as string).exists())

  await captureOutput(() => artisan.run(['make:view', 'smoke.probe']))
  const viewSource = await Bun.file(generated[2] as string).text()
  check('make:view writes a .tsx component', viewSource.includes('export function Probe('))
  check('view class name uses the last segment only', viewSource.includes('ProbeProps'))
  check(
    'layout import depth matches the nesting',
    viewSource.includes("from '../components/layout.tsx'")
  )

  await captureOutput(() => artisan.run(['make:component', 'SmokeAlert']))
  const componentSource = await Bun.file(generated[5] as string).text()
  check(
    'make:component writes a component',
    componentSource.includes('export function SmokeAlert(')
  )

  await captureOutput(() => artisan.run(['make:provider', 'Smoke']))
  const providerSource = await Bun.file(generated[3] as string).text()
  check(
    'make:provider suffixes the class name',
    providerSource.includes('class SmokeServiceProvider')
  )

  await captureOutput(() => artisan.run(['make:command', 'SmokeJob']))
  const commandSource = await Bun.file(generated[4] as string).text()
  check('make:command derives a signature', commandSource.includes("signature = 'smoke:job"))

  await captureOutput(() => artisan.run(['make:event', 'SmokeHappened']))
  const eventSource = await Bun.file(generated[6] as string).text()
  check(
    'make:event writes a class with a stable eventName',
    eventSource.includes("eventName = 'smoke.happened'")
  )

  await captureOutput(() =>
    artisan.run(['make:listener', 'RecordSmoke', '--event', 'SmokeHappened'])
  )
  const listenerSource = await Bun.file(generated[7] as string).text()
  check(
    'make:listener subscribes to the given event',
    listenerSource.includes("listen('smoke.happened'")
  )

  const refused = plain(await captureOutput(() => artisan.run(['make:view', 'smoke.probe'])))
  check('existing files are not overwritten', refused.includes('already exists'))

  const forced = await captureOutput(() => artisan.run(['make:view', 'smoke.probe', '--force']))
  check('--force overwrites', plain(forced).includes('View created'))
} finally {
  await Promise.all(generated.map((path) => rm(path, { force: true })))
  await rm(app.resourcePath('views', 'smoke'), { recursive: true, force: true })
  await rm(app.appPath('Http', 'Controllers', 'nested'), { recursive: true, force: true })
}

// ------------------------------------------------------------------ scaffolder

section('Scaffolder')

const scaffoldTarget = join(app.basePath(), '..', '.smoke-scaffold')

try {
  await rm(scaffoldTarget, { recursive: true, force: true })

  const result = Bun.spawnSync({
    cmd: ['bun', 'packages/create-elysian/src/index.ts', '.smoke-scaffold'],
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe'
  })

  check('create-elysian exits cleanly', result.exitCode === 0, `exit ${result.exitCode}`)

  const manifest = await Bun.file(join(scaffoldTarget, 'package.json')).json()
  check('_package.json is renamed', manifest.name === '.smoke-scaffold')
  check(
    'workspace mode links the framework',
    manifest.dependencies['@elysian/core'] === 'workspace:*',
    manifest.dependencies['@elysian/core']
  )
  check('.gitignore is renamed', await Bun.file(join(scaffoldTarget, '.gitignore')).exists())
  check('.env is written from the example', await Bun.file(join(scaffoldTarget, '.env')).exists())

  const scaffoldedView = await Bun.file(
    join(scaffoldTarget, 'resources/views/pages/landing.tsx')
  ).text()
  check('view components are copied verbatim', scaffoldedView.includes('export function Landing('))
  const scaffoldedTsconfig = await Bun.file(join(scaffoldTarget, 'tsconfig.json')).text()
  check('scaffolded tsconfig wires the JSX runtime', scaffoldedTsconfig.includes('@kitajs/html'))
} finally {
  await rm(scaffoldTarget, { recursive: true, force: true })
}

// -------------------------------------------------------------------- server

section('Server')

const port = 41_987
await app.listen(port, '127.0.0.1')

try {
  const response = await fetch(`http://127.0.0.1:${port}/health`)
  check('listen() serves real requests', response.status === 200)
  check('reported port matches', app.router.server?.port === port)
} finally {
  app.router.stop()
}

// -------------------------------------------------------------------- summary

console.log()
if (failures.length === 0) {
  console.log(pc.green(pc.bold(`  ${checks} checks passed`)))
  process.exit(0)
}

console.log(pc.red(pc.bold(`  ${failures.length} of ${checks} checks failed:`)))
for (const failure of failures) console.log(pc.red(`    - ${failure}`))
process.exit(1)
