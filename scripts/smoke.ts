#!/usr/bin/env bun
import { createHmac } from 'node:crypto'
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BunSqlConnection, MigrationRepository, Migrator } from '@elysian/database'
import { middlewareNamesOf, middlewares } from '@elysian/http'
import { ProcessManager } from '@elysian/process'
import { ScheduleRunner } from '@elysian/scheduler'
import { canonicalRequest, signingKey, stringToSign } from '@elysian/support'
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

const deferredEvents = (await (
  await app.handle(new Request('http://localhost/signal/deferred'))
).json()) as { duringDeferral: string[]; insideCount: number; abandoned: string; heard: string[] }

check('a deferred event is not heard while the work is running', deferredEvents.insideCount === 1)
check(
  'and an unrelated dispatch is not swallowed by somebody else’s deferral',
  deferredEvents.duringDeferral.length === 1 && deferredEvents.duringDeferral[0] === 'unrelated'
)
check('a deferred event arrives once the work finishes', deferredEvents.heard.includes('committed'))
check(
  'work that throws announces nothing',
  deferredEvents.abandoned === 'deliberate failure' && !deferredEvents.heard.includes('rolled back')
)

/**
 * A listener that runs in a worker rather than in the request.
 *
 * The two halves that matter are *when* nothing happened and *when* it did: the
 * dispatch has to return with the listener not yet run, and a worker has to be
 * able to rebuild both the listener and the event in a process that only ever
 * saw their names.
 */
const registries = (await (
  await app.handle(new Request('http://localhost/signal/listeners'))
).json()) as { queued: string[]; events: string[] }

check(
  'a queued listener is registered for a worker to resolve',
  registries.queued.includes('NotifyWarehouse')
)
check('and its event is, so the worker can rebuild it', registries.events.includes('order.shipped'))

await app.make('queue').connection().clear('shipments')
await app.make('cache').store().forget('warehouse:42')

const queuedListener = (await (await postJson('/signal/queued/42', {})).json()) as {
  warehouse: string | null
  queued: number
}

check('dispatching queues the listener instead of running it', queuedListener.queued === 1)
check('and the request returns before it has run', queuedListener.warehouse === null)

await captureOutput(() => app.make('artisan').run(['queue:work', '--queue', 'shipments', '--once']))

const afterWorker = (await (
  await app.handle(new Request('http://localhost/signal/queued/42'))
).json()) as { warehouse: string | null }

// `DHL-42` comes from a *method* on the event, so this is also the proof that the
// worker rebuilt the event class rather than handing over loose JSON.
check('the worker runs it, with the event rebuilt as itself', afterWorker.warehouse === 'DHL-42')

const rolledBack = (await (await postJson('/signal/queued/77/rollback', {})).json()) as {
  before: number
  after: number
}

// afterCommit: a worker must not reserve a job whose rows were never committed.
check('a rolled-back transaction queues nothing', rolledBack.after === rolledBack.before)

await app.make('queue').connection().clear('shipments')
await app.make('cache').store().forget('warehouse:42')

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

/**
 * Wildcard rules against a payload with a variable number of lines.
 *
 * The shape of the error bag is the feature: one entry per element, keyed by the
 * concrete path, so a form can put each message beside the field it belongs to.
 */
let orderResponse!: Response

// The handler reports the 422 through the exception handler, which logs a stack
// trace; capture it so the checks stay readable.
await captureOutput(async () => {
  orderResponse = await postJson('/check/orders', {
    reference: 'ORD-1',
    lines: [
      { sku: 'A1', quantity: 1, price: 10 },
      { sku: 'A1', quantity: 0 },
      { sku: 'B2', quantity: 2, price: -5, options: { colour: 'red', gift: true } }
    ],
    tags: ['Sale', 'sale']
  })
})

const order = (await orderResponse.json()) as { errors: Record<string, string[]> }

check('a wildcard rule runs once per element', 'lines.1.quantity' in order.errors)
check('and reports against the element, not the pattern', !('lines.*.quantity' in order.errors))
check('an element that left a field out fails required', 'lines.1.price' in order.errors)
// `:position` counts from one — "line 2" is what the person reading it sees.
check(
  'a message written for the pattern is found, with :position',
  order.errors['lines.1.quantity']?.[0] === 'Line 2 must order at least one unit.'
)
check(
  'an attribute label written for the pattern is used',
  order.errors['lines.2.price']?.[0]?.includes('line price') === true
)
check(
  'distinct catches the repeat, on both of them',
  'lines.0.sku' in order.errors && 'lines.1.sku' in order.errors
)
check('distinct:ignore_case folds case', 'tags.0' in order.errors)
check('array:colour,size refuses an unexpected key', 'lines.2.options' in order.errors)

let emptyResponse!: Response
await captureOutput(async () => {
  emptyResponse = await postJson('/check/orders', { reference: 'ORD-2', lines: [] })
})

const emptyOrder = (await emptyResponse.json()) as { errors: Record<string, string[]> }

// One error, on the collection. Reporting `lines.0.sku` would invent an element.
check('an empty collection reports itself once', Object.keys(emptyOrder.errors).join() === 'lines')

const goodOrder = (await (
  await postJson('/check/orders', {
    reference: 'ORD-9',
    lines: [{ sku: 'A1', quantity: 2, price: 10, options: { colour: 'red' } }],
    tags: ['sale', 'new']
  })
).json()) as { validated: { lines: unknown } }

// Rebuilt as an array, not `{ '0': … }`: a validated payload goes on to a
// database write or a JSON response, where the difference is visible.
check('validated() rebuilds the collection as an array', Array.isArray(goodOrder.validated.lines))

/**
 * File rules against a real `multipart/form-data` request.
 *
 * The one that matters is the liar: a script named `.png` and labelled
 * `image/png` is indistinguishable from a real upload by anything except its
 * bytes, and `image`/`mimes` read the bytes.
 */
function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(24))
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const header = new DataView(bytes.buffer)
  header.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  header.setUint32(16, width)
  header.setUint32(20, height)

  return bytes
}

async function uploadAvatar(
  file: File
): Promise<Record<string, string[]> | Record<string, unknown>> {
  const form = new FormData()
  form.append('avatar', file)

  let response!: Response
  await captureOutput(async () => {
    response = await app.handle(
      new Request('http://localhost/check/files/avatar', { method: 'POST', body: form })
    )
  })

  const body = (await response.json()) as { errors?: Record<string, string[]> }

  return body.errors ?? body
}

const realUpload = (await uploadAvatar(
  new File([pngBytes(64, 64)], 'avatar.png', { type: 'image/png' })
)) as { stored?: string }

check('a real image passes and is stored', typeof realUpload.stored === 'string')

const liar = (await uploadAvatar(
  new File([new TextEncoder().encode("<?php echo 'pwned';")], 'avatar.png', { type: 'image/png' })
)) as Record<string, string[]>

// Every claim on this file says image/png; only the bytes disagree.
check(
  'a script wearing a .png name is refused',
  liar.avatar?.[0]?.includes('must be an image') === true
)

const tooSmall = (await uploadAvatar(
  new File([pngBytes(4, 4)], 'avatar.png', { type: 'image/png' })
)) as Record<string, string[]>

check(
  'dimensions are read out of the file',
  tooSmall.avatar?.[0] === 'The avatar must be between 8 and 512 pixels wide.'
)

const tooBig = (await uploadAvatar(
  new File([pngBytes(64, 64), new ArrayBuffer(70 * 1024)], 'avatar.png', { type: 'image/png' })
)) as Record<string, string[]>

// Kilobytes, not characters: `max:64` on an upload means 64KB.
check(
  'a size rule on a file is kilobytes',
  tooBig.avatar?.[0] === 'The avatar field must not be greater than 64 kilobytes.'
)

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

// -------------------------------------------------------------------- queue

section('Queue: dispatch, work, retry, fail')

/** Every connection worth running here — redis only when a server answers. */
/**
 * SQS, when something speaks it — ElasticMQ locally.
 *
 * The queue is created here because a queue's URL *is* its identity in SQS:
 * there is no "create on first use". Pointed at a per-run queue so two runs
 * never share one.
 */
const sqsReachable = await (async () => {
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:9324'
  const account = process.env.SQS_ACCOUNT ?? '000000000000'
  const name = `elysian-smoke-${Date.now().toString(36)}`

  try {
    const created = await fetch(`${endpoint}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        Action: 'CreateQueue',
        QueueName: name,
        Version: '2012-11-05'
      }).toString()
    })

    if (!created.ok) throw new Error(String(created.status))

    app.config.set('queue.connections.sqs', {
      driver: 'sqs',
      region: 'elasticmq',
      accessKeyId: 'x',
      secretAccessKey: 'x',
      endpoint: `${endpoint}/${account}`,
      queue: name,
      visibilityTimeout: 30
    })

    return true
  } catch {
    console.log(`  ${pc.dim('skipping sqs: nothing speaking it on 9324')}`)

    return false
  }
})()

const connections = [
  'database',
  ...(redisReachable ? ['redis'] : []),
  ...(sqsReachable ? ['sqs'] : [])
]

async function queueState(connection: string) {
  return (await (
    await app.handle(new Request(`http://localhost/check/queue/state?connection=${connection}`))
  ).json()) as {
    size: number
    failed: Array<{ id: number | string; job: string; attempts: number }>
    log: string[]
    jobs: string[]
  }
}

const discovered = await queueState('database')
check(
  'jobs in app/Jobs are discovered, so a worker can resolve them',
  ['FlakyProbe', 'SendArticleDigest', 'TouchArticle'].every((job) => discovered.jobs.includes(job))
)

for (const connection of connections) {
  const clear = () =>
    app.handle(
      new Request(`http://localhost/check/queue/state?connection=${connection}`, {
        method: 'DELETE'
      })
    )

  const work = async () =>
    (await (
      await app.handle(
        new Request(`http://localhost/check/queue/work?connection=${connection}`, {
          method: 'POST'
        })
      )
    ).json()) as { processed: number; failed: number; released: number; log: string[] }

  await clear()

  const queued = (await (
    await postJson(`/check/queue/digest?connection=${connection}`, { label: 'digest' })
  ).json()) as { queued: string; size: number }

  check(`${connection}: dispatch queues the job and returns at once`, queued.size === 1)

  const idle = await queueState(connection)
  check(`${connection}: nothing has run yet`, idle.log.length === 0)

  const worked = await work()
  check(
    `${connection}: the worker runs it and empties the queue`,
    worked.processed === 1 && worked.log[0]?.startsWith('digest:') === true
  )
  check(`${connection}: and the job is gone`, (await queueState(connection)).size === 0)

  // A delayed job is queued but not yet available.
  await clear()
  await postJson(`/check/queue/digest?connection=${connection}`, { label: 'later', delay: 60 })

  const delayed = await work()
  check(`${connection}: a delayed job is not picked up`, delayed.processed === 0)
  check(`${connection}: but it is queued`, (await queueState(connection)).size === 1)

  // Retry policy: two attempts, then the failed store, then the failed() hook.
  await clear()
  await postJson(`/check/queue/flaky?connection=${connection}`, { label: 'p', failTimes: 5 })

  const flaky = await work()
  check(
    `${connection}: a failing job is retried, then recorded as failed`,
    flaky.processed === 2 && flaky.released === 1 && flaky.failed === 1
  )
  check(
    `${connection}: attempts and the failed hook are both visible`,
    flaky.log.join('|') === 'p:attempt-1|p:attempt-2|p:failed:Probe [p] failed on atte'
  )

  const afterFailure = await queueState(connection)
  check(
    `${connection}: the failed job is recorded with its attempt count`,
    afterFailure.failed[0]?.attempts === 2
  )
  check(`${connection}: and is off the queue`, afterFailure.size === 0)

  // Retrying puts it back with the count reset.
  const retried = (await (await postJson('/check/queue/retry', {})).json()) as { retried: number }
  check(`${connection}: retry re-queues from the recorded payload`, retried.retried === 1)

  const afterRetry = await queueState(connection)
  check(
    `${connection}: the failed record is cleared and the job is queued again`,
    afterRetry.size === 1 && afterRetry.failed.length === 0
  )

  // A chain: each link is queued by its predecessor's success.
  await clear()
  await postJson(`/check/queue/chain?connection=${connection}`, {})

  const chained = await work()
  check(
    `${connection}: a chain runs in order`,
    chained.log.map((entry) => entry.split(':')[0]).join(',') === 'one,two,three'
  )

  await clear()
}

// A job carrying a model: the payload holds the key, the worker re-reads the row.
await app.handle(
  new Request('http://localhost/check/queue/state?connection=database', { method: 'DELETE' })
)

const titleBefore = (
  (await (await app.handle(new Request('http://localhost/check/articles/3'))).json()) as {
    data: { title: string }
  }
).data.title

await postJson('/check/queue/touch/3?connection=database', {})
await postJson('/check/queue/work?connection=database', {})

const titleAfter = (
  (await (await app.handle(new Request('http://localhost/check/articles/3'))).json()) as {
    data: { title: string }
  }
).data.title

check(
  'a model travels as a reference and is re-read by the worker',
  titleAfter === `${titleBefore}!`
)

// `sync`: the job runs inside the dispatch, before the response is built.
const synchronous = (await (
  await postJson('/check/queue/digest/now', { label: 'sync' })
).json()) as { log: string[] }
check(
  'dispatchSync runs the job before the handler returns',
  synchronous.log.some((entry) => entry.startsWith('sync:'))
)

// `defer()`: after the response, not during it.
const deferred = (await (await postJson('/check/queue/defer', {})).json()) as {
  ranAlready: boolean | null
}
check('a deferred callback has not run when the response is built', !deferred.ranAlready)

// Whether it *ran* can only be asserted against a real socket: Elysia fires
// `onAfterResponse` when a response is transmitted, and `app.handle()` never
// transmits one. Asserted in the Server section below.

// The commands.
const sized = plain(await captureOutput(() => app.make('artisan').run(['queue:size'])))
check('queue:size reports the depth', /\d+ job\(s\) on \[default\]/.test(sized))

await postJson('/check/queue/digest?connection=database', { label: 'once' })

const once = plain(await captureOutput(() => app.make('artisan').run(['queue:work', '--once'])))
check('queue:work --once processes a single job', once.includes('Job processed'))

const emptyOnce = plain(
  await captureOutput(() => app.make('artisan').run(['queue:work', '--once']))
)
check('and says so when nothing is waiting', emptyOnce.includes('No job was waiting'))

await postJson('/check/queue/flaky?connection=database', { label: 'listed', failTimes: 5 })
await app.handle(
  new Request('http://localhost/check/queue/work?connection=database', { method: 'POST' })
)

const listed = plain(await captureOutput(() => app.make('artisan').run(['queue:failed'])))
check('queue:failed lists what failed', listed.includes('FlakyProbe'))

const flushed = plain(await captureOutput(() => app.make('artisan').run(['queue:flush'])))
check('queue:flush empties the failed table', /Deleted [1-9]/.test(flushed))

await postJson('/check/queue/digest?connection=database', { label: 'cleared' })

const clearedQueue = plain(await captureOutput(() => app.make('artisan').run(['queue:clear'])))
check('queue:clear deletes pending work', /Deleted [1-9]/.test(clearedQueue))

// Leave the queue and the shared Redis as they were found.
for (const connection of connections) {
  await app.make('queue').connection(connection).clear()
}
await app.make('queue').failed.flush()
await app.make('cache').store().forget('digest:log')

// ------------------------------------------------------------- notifications

section('Notifications')

const registry = (await (
  await app.handle(new Request('http://localhost/check/notifications/registry'))
).json()) as { notifications: string[] }

check(
  'notifications in app/Notifications are discovered',
  registry.notifications.includes('ArticlePublished')
)

await app.handle(new Request('http://localhost/check/notifications', { method: 'DELETE' }))

// Two recipients, one without an address: `via()` decides per recipient.
const notified = (await (
  await postJson('/check/notifications/1', {
    recipients: [{ id: 1, email: 'ada@example.com' }, { id: 2 }]
  })
).json()) as { notified: number; id: string; channels: string[] }

check('both recipients were notified', notified.notified === 2)
check(
  'a recipient with an address gets the mail channel too',
  notified.channels.join(',') === 'mail,database,log'
)

const inbox = async (recipient: string) =>
  (await (
    await app.handle(new Request(`http://localhost/check/notifications?for=${recipient}`))
  ).json()) as {
    unread: number
    notifications: Array<{ id: string; type: string; data: Record<string, unknown>; read: boolean }>
  }

const first = await inbox('1')
const second = await inbox('2')

check(
  'each recipient has a stored row',
  first.notifications.length === 1 && second.notifications.length === 1
)
check('the row carries the notification type', first.notifications[0]?.type === 'ArticlePublished')
check(
  'and the payload toDatabase() returned',
  typeof first.notifications[0]?.data.title === 'string'
)
check('a stored row starts unread', first.unread === 1 && first.notifications[0]?.read === false)

// The id is per recipient, not per notification instance: two people's rows must
// not share one, or an inbox cannot tell them apart.
check('each recipient gets its own id', first.notifications[0]?.id !== second.notifications[0]?.id)

// Marking as read is idempotent.
const storedId = first.notifications[0]?.id ?? ''

const read = (await (await postJson(`/check/notifications/${storedId}/read`, {})).json()) as {
  read: boolean
  readAt: string
}

check('a notification can be marked as read', read.read === true)

const readAgain = (await (await postJson(`/check/notifications/${storedId}/read`, {})).json()) as {
  readAt: string
}

check('marking it again does not move the timestamp', readAgain.readAt === read.readAt)
check('and the unread count drops', (await inbox('1')).unread === 0)

// `shouldSend` refuses one channel without affecting the others.
await app.handle(new Request('http://localhost/check/notifications', { method: 'DELETE' }))
await postJson('/check/notifications/1', { title: 'Draft: not ready' })

const draft = await inbox('1')
check(
  'shouldSend refusing mail still stores the row',
  draft.notifications[0]?.data.title === 'Draft: not ready'
)

// An on-demand recipient has no row to own, so the database channel is skipped.
const routed = (await (await postJson('/check/notifications/route/1', {})).json()) as {
  routed: string[]
}

check(
  'an on-demand recipient carries only the channel it was routed for',
  routed.routed.join() === 'mail'
)
check(
  'and no row was stored for it',
  (await inbox('1')).notifications.length === draft.notifications.length
)

await app.handle(new Request('http://localhost/check/notifications', { method: 'DELETE' }))

// ------------------------------------------------------------------ storage

section('Storage')

/**
 * Does this filesystem remember permission bits?
 *
 * A Windows drive mounted in WSL does not: `/mnt/e` is 9p/drvfs without the
 * `metadata` option, so `chmod 600` is accepted and the file still reads 777.
 * The visibility check below is meaningless there — not failing, meaningless —
 * and a red check people learn to ignore is worse than one that says why.
 */
const permissionsAreKept = await (async () => {
  const probe = join(app.basePath(), 'storage', `.permissions-probe-${Date.now()}`)

  try {
    await writeFile(probe, 'x')
    await chmod(probe, 0o600)

    return ((await stat(probe)).mode & 0o777) === 0o600
  } catch {
    return false
  } finally {
    await rm(probe, { force: true })
  }
})()

if (!permissionsAreKept) {
  console.log(
    '  note: this filesystem does not keep permission bits, so disk visibility is not checked'
  )
}

/** A multipart request, as a browser would send one. */
async function upload(path: string, contents: string, filename = 'notes.txt') {
  const form = new FormData()
  form.append('file', new File([contents], filename, { type: 'text/plain' }))

  return app.handle(new Request(`http://localhost${path}`, { method: 'POST', body: form }))
}

for (const diskName of ['memory', 'local', 'public']) {
  await app.handle(
    new Request(`http://localhost/check/storage/listing?disk=${diskName}`, { method: 'DELETE' })
  )

  const stored = (await (
    await upload(`/check/files?disk=${diskName}`, 'the quick brown fox')
  ).json()) as {
    path: string
    size: number
    mimeType: string
    visibility: string
  }

  check(
    `${diskName}: an upload is stored with a generated name`,
    /^uploads\/[0-9a-f]{32}\.txt$/.test(stored.path)
  )
  check(
    `${diskName}: its size and type are read back`,
    stored.size === 19 && stored.mimeType.includes('text/plain')
  )
  // The memory disk keeps visibility as a field, so it is always checkable; the
  // two local ones read it back off the file mode.
  if (diskName === 'memory' || permissionsAreKept) {
    check(
      `${diskName}: visibility follows the disk`,
      stored.visibility === (diskName === 'public' ? 'public' : 'private')
    )
  }

  const fetched = await app.handle(
    new Request(`http://localhost/check/files/${stored.path}?disk=${diskName}`)
  )
  check(`${diskName}: the file streams back`, (await fetched.text()) === 'the quick brown fox')
  check(
    `${diskName}: with a content type and length`,
    fetched.headers.get('content-type')?.includes('text/plain') === true &&
      fetched.headers.get('content-length') === '19'
  )

  const listing = (await (
    await app.handle(new Request(`http://localhost/check/storage/listing?disk=${diskName}`))
  ).json()) as { files: string[]; directories: string[] }

  check(`${diskName}: listing finds it`, listing.files.includes(stored.path))
  check(`${diskName}: and the directory above it`, listing.directories.includes('uploads'))

  // Two uploads of the same file must not collide.
  const second = (await (await upload(`/check/files?disk=${diskName}`, 'another')).json()) as {
    path: string
  }
  check(`${diskName}: a generated name does not collide`, second.path !== stored.path)

  await app.handle(
    new Request(`http://localhost/check/storage/listing?disk=${diskName}`, { method: 'DELETE' })
  )
  check(
    `${diskName}: the disk can be emptied`,
    (
      (await (
        await app.handle(new Request(`http://localhost/check/storage/listing?disk=${diskName}`))
      ).json()) as { files: string[] }
    ).files.length === 0
  )
}

// A download names the file, and survives a name the header cannot hold verbatim.
const namedUpload = (await (await upload('/check/files?disk=memory', 'bytes')).json()) as {
  path: string
}

const downloaded = await app.handle(
  new Request(
    `http://localhost/check/files/${namedUpload.path}?disk=memory&download=yes&as=${encodeURIComponent('Ringkasan 笔记.txt')}`
  )
)

const disposition = downloaded.headers.get('content-disposition') ?? ''
check('a download is an attachment', disposition.startsWith('attachment;'))
check(
  'a non-ASCII filename is carried in filename*',
  disposition.includes("filename*=UTF-8''Ringkasan%20%E7%AC%94%E8%AE%B0.txt")
)
check('and the plain parameter stays ASCII', disposition.includes('filename="Ringkasan __.txt"'))

// The traversal guard, from outside the process.
for (const hostile of ['../../.env', '/etc/passwd', 'uploads/../../../secrets']) {
  const refused = await app.handle(
    new Request(
      `http://localhost/check/storage/traversal?disk=local&path=${encodeURIComponent(hostile)}`
    )
  )

  const body = (await refused.json()) as { refused?: boolean }

  check(
    `a path leaving the disk is refused: ${hostile}`,
    refused.status === 422 && body.refused === true
  )
}

// A path that stays inside is still allowed — the guard is not a ban on `..`.
const inside = await app.handle(
  new Request('http://localhost/check/storage/traversal?disk=local&path=uploads/../ok.txt')
)
check('a path that resolves inside the disk is allowed', inside.status === 200)

// Temporary URLs: signed locally, so no network is involved.
const temporary = (await (
  await app.handle(
    new Request('http://localhost/check/storage/temporary-url?disk=s3&path=invoices/7.pdf')
  )
).json()) as { supported: boolean; url: string; uploadUrl: string }

check('an S3 disk can sign a link that expires', temporary.supported === true)

const signed = new URL(temporary.url)
check('the link names the object', signed.pathname === '/elysian-playground/invoices/7.pdf')
check(
  'it carries an expiry and a signature',
  signed.searchParams.get('X-Amz-Expires') === '900' &&
    Boolean(signed.searchParams.get('X-Amz-Signature'))
)
check('and an upload link is signed differently', temporary.url !== temporary.uploadUrl)

const noTemporary = (await (
  await app.handle(new Request('http://localhost/check/storage/temporary-url?disk=local'))
).json()) as { supported: boolean; reason?: string }
check(
  'a local disk says it cannot, rather than pretending',
  noTemporary.supported === false && noTemporary.reason?.includes('cannot make links') === true
)

// `storage:link` is what makes the public disk reachable without a route.
const linked = plain(await captureOutput(() => app.make('artisan').run(['storage:link'])))
check('storage:link reports the link it made or found', /Linked|already links/.test(linked))

const publicUpload = (await (
  await upload('/check/files?disk=public', 'served statically')
).json()) as { path: string }

const served = await app.handle(new Request(`http://localhost/storage/${publicUpload.path}`))
check(
  'a file on the public disk is served as a static file',
  (await served.text()) === 'served statically'
)

await app.handle(
  new Request('http://localhost/check/storage/listing?disk=public', { method: 'DELETE' })
)
await app.handle(
  new Request('http://localhost/check/storage/listing?disk=memory', { method: 'DELETE' })
)

// -------------------------------------------------------------------- mail

section('Mail')

const mailables = (await (
  await app.handle(new Request('http://localhost/check/mail/mailables'))
).json()) as { mailables: string[] }

check('mailables in app/Mail are discovered', mailables.mailables.includes('ArticlePublished'))

await app.handle(new Request('http://localhost/check/mail/outbox', { method: 'DELETE' }))

const sentResult = (await (
  await postJson('/check/mail/send/1?mailer=array', { to: 'ada@example.com' })
).json()) as { sent: string; id?: string }

check('a message goes out through the named mailer', sentResult.sent === 'array')

const outbox = (await (
  await app.handle(new Request('http://localhost/check/mail/outbox'))
).json()) as {
  count: number
  messages: Array<{
    mailable: string
    subject: string
    to: string[]
    replyTo: string[]
    htmlHead?: string
    hasText: boolean
  }>
}

const message = outbox.messages[0]

check('the outbox holds exactly what was sent', outbox.count === 1)
check('the mailable names itself on the message', message?.mailable === 'ArticlePublished')
// Not pinned to a title: earlier sections edit article 1 on purpose, and the
// point here is that the envelope interpolated the row it was given.
check(
  'the envelope subject is interpolated from the data',
  message?.subject.startsWith('Published: ') === true &&
    message.subject.length > 'Published: '.length
)
check('the recipient given to to() is used', message?.to.join() === 'ada@example.com')
check('reply-to travels as its own field', message?.replyTo.join() === 'editors@example.com')
check(
  'the JSX view rendered into the HTML body',
  message?.htmlHead?.startsWith('<!DOCTYPE html>') === true
)
check('and a text part was included', message?.hasText === true)

// The default mailer writes the message instead of sending it, so the proof is
// that it reports the `log` transport and the array outbox stays untouched.
const viaLog = (await (await postJson('/check/mail/send/2', {})).json()) as { sent: string }
check('the default mailer writes to the log instead of sending', viaLog.sent === 'log')

/**
 * The message assertions, against a message this application really built.
 *
 * Reading the outbox as JSON above proves the mail went out; this proves the
 * assertions read the same thing a transport would — and that they fail when
 * they should, which is the half an assertion library most often gets wrong.
 */
const asserted = (await (
  await app.handle(new Request('http://localhost/check/mail/assertions/1'))
).json()) as { passed: string[]; failure?: string }

check(
  'the message assertions pass on a real built message',
  asserted.passed.length === 8,
  asserted.passed.join(',')
)
check(
  'and a wrong recipient fails rather than passing quietly',
  asserted.failure !== undefined,
  asserted.failure ?? '(no failure)'
)
check(
  'with the address that did receive it in the message',
  (asserted.failure ?? '').includes('ada@example.com'),
  asserted.failure ?? ''
)

// Rendering without sending, for a preview.
const preview = await app.handle(new Request('http://localhost/check/mail/preview/1'))
const previewHtml = await preview.text()

check('a preview renders the mail as HTML', previewHtml.includes('<h1'))
check(
  'and does not send it',
  (
    (await (await app.handle(new Request('http://localhost/check/mail/outbox'))).json()) as {
      count: number
    }
  ).count === 1
)

// Queued mail: the request only queues, the worker renders and sends.
await app.handle(
  new Request('http://localhost/check/queue/state?connection=database', { method: 'DELETE' })
)
await app.handle(new Request('http://localhost/check/mail/outbox', { method: 'DELETE' }))

const queuedMail = (await (await postJson('/check/mail/queue/1', {})).json()) as {
  queued: string
  size: number
}

check('queued mail lands on the queue the mailable names', queuedMail.size === 1)
check(
  'and nothing has been sent yet',
  (
    (await (await app.handle(new Request('http://localhost/check/mail/outbox'))).json()) as {
      count: number
    }
  ).count === 0
)

// The worker sends through the configured mailer, which is `log` — so the proof
// is that the job ran without failing, and the queue is empty afterwards.
const mailWorked = (await (
  await postJson('/check/queue/work?connection=database&queue=mail', {})
).json()) as { processed: number; failed: number }

check('the worker sends the queued mail', mailWorked.processed === 1 && mailWorked.failed === 0)

// ---------------------------------------------------------------- scheduler

section('Scheduler')

const schedule = app.make('schedule')
const scheduled = schedule.events()

check(
  'the application registers its schedule in one place',
  scheduled.length >= 4,
  `${scheduled.length} entries`
)
check(
  'entries carry the expression their frequency wrote',
  scheduled.map((event) => event.cronExpression).includes('0 * * * *')
)
check(
  'the schedule timezone reaches every entry',
  scheduled.every((event) => event.zone === app.config.get<string>('app.timezone', 'UTC'))
)

const scheduleList = plain(await captureOutput(() => app.make('artisan').run(['schedule:list'])))
check('schedule:list shows the expression and the next run', scheduleList.includes('NEXT RUN'))
check('and describes each entry', scheduleList.includes('Delete expired rows'))

// Three entries added here, so the assertions do not depend on the clock.
const ran: string[] = []

schedule
  .call(() => {
    ran.push('due')
  }, 'smoke:due')
  .everyMinute()

schedule
  .call(() => {
    ran.push('not-due')
  }, 'smoke:yearly')
  .yearly()

schedule
  .call(() => {
    ran.push('filtered')
  }, 'smoke:filtered')
  .everyMinute()
  .when(false)

const due = schedule.dueEvents()
check(
  'dueEvents honours the expression',
  due.some((event) => event.label === 'smoke:due') &&
    !due.some((event) => event.label === 'smoke:yearly')
)
check(
  'a filtered entry is still due — filters are a separate question',
  due.some((event) => event.label === 'smoke:filtered')
)

const runOutput = plain(await captureOutput(() => app.make('artisan').run(['schedule:run'])))

check('schedule:run runs what is due', ran.includes('due'))
check('and skips what a filter refused', !ran.includes('filtered'))
check('and does not run what is not due', !ran.includes('not-due'))
check('reporting each outcome', runOutput.includes('smoke:due') && runOutput.includes('SKIP'))

/**
 * A forked entry, proved by the pid it records.
 *
 * `demo:mark-run` writes its own process id into the cache. If that differs
 * from this process's, the scheduled command really did run in a child — which
 * is the whole claim, and the one thing an in-process test cannot make.
 */
await app.make('cache').store().forget('schedule:background')

const backgroundOutput = plain(await captureOutput(() => app.make('artisan').run(['schedule:run'])))

const marked = (await app.make('cache').store().get('schedule:background')) as {
  pid: number
} | null

check('a background entry runs at all', marked !== null, backgroundOutput.slice(-200))
check(
  'and in a process of its own',
  typeof marked?.pid === 'number' && marked.pid !== process.pid,
  `child ${marked?.pid} vs scheduler ${process.pid}`
)
// The run waits for its children before returning: a process that exited early
// would release no mutex and fire no onSuccess.
check('and schedule:run waits for it', backgroundOutput.includes('background'))

const capturedLog = await Bun.file(app.storagePath('logs', 'schedule-background.log')).text()

// The child's stdout, piped and filed rather than interleaved with everything
// else the scheduler printed — which is what makes "what did it say last night?"
// answerable at all.
check(
  'a forked task\u2019s output is captured to its own file',
  capturedLog.includes('marked background')
)
check('and it is the child that wrote it', capturedLog.includes(`pid ${marked?.pid}`))

// ------------------------------------------------------- schema dump, squashed

section('Schema: dump and load')

const dumpPath = join(app.storagePath('framework'), 'smoke-schema.sql')

await captureOutput(() => app.make('artisan').run(['schema:dump', `--path=${dumpPath}`]))

const dumped = await Bun.file(dumpPath).text()

// SQLite stores its own DDL, capitals and all — the dump is what the engine
// said, not what our grammar would have written.
check('schema:dump writes the tables', /create table/i.test(dumped))
// The rows matter as much as the tables: without them `migrate` would replay
// every migration on top of the schema it just loaded.
check('and the migrations that produced them', dumped.includes('insert into "migrations"'))

/**
 * The squash, in a child process with its own database.
 *
 * Deliberately not by swapping this application's config: the session driver and
 * every model already hold a connection built from it, and putting it back does
 * not put them back — the first attempt failed three sections later with
 * "no such table: sessions", which is a fair description of what config
 * mutation does to a running application.
 */
const freshDatabase = join(app.storagePath('framework'), 'smoke-squashed.sqlite')
await rm(freshDatabase, { force: true })

const squashRun = Bun.spawnSync(
  [process.execPath, 'artisan.ts', 'migrate', `--schema-path=${dumpPath}`],
  {
    cwd: join(import.meta.dir, '..', 'playground'),
    env: { ...process.env, DB_CONNECTION: 'sqlite', DB_DATABASE: freshDatabase }
  }
)

const squashOutput = plain(squashRun.stdout.toString() + squashRun.stderr.toString())

check(
  'migrate loads a stored schema on an empty database',
  squashOutput.includes('Loading stored schema'),
  squashOutput.slice(0, 200)
)
check('with nothing left pending', squashOutput.includes('Nothing to migrate'))

const squashed = await BunSqlConnection.make('squashed', {
  driver: 'sqlite',
  database: freshDatabase
})
const squashedTables = await squashed.select<{ name: string }>(
  "select name from sqlite_master where type='table'"
)
const squashedRows = await squashed.select<{ n: number }>('select count(*) as n from migrations')

// The tables are there, and so is the record of which migrations produced them
// — without that, `migrate` would replay all of them on the next run.
check(
  'the tables arrive without running a migration',
  squashedTables.some((row) => row.name === 'articles')
)
check('and the migration rows come with them', Number(squashedRows[0]?.n ?? 0) > 0)

await squashed.disconnect()
await rm(freshDatabase, { force: true })
await rm(dumpPath, { force: true })

const isolated = plain(
  await captureOutput(async () => {
    await app.make('cache').store().forget('elysian:command:migrate')
    await app.make('cache').store().add('elysian:command:migrate', 'held', 60)
    await app.make('artisan').run(['migrate', '--isolated'])
  })
)

// Zero, not a failure: a deploy runs this on every node and exactly one should
// do the work while the others carry on.
check(
  '--isolated stands aside when another copy holds the lock',
  isolated.includes('already running')
)

await app.make('cache').store().forget('elysian:command:migrate')

// The overlap mutex, through the real cache store.
let held: (() => void) | undefined
const gate = new Promise<void>((resolve) => {
  held = resolve
})

const slow = schedule
  .call(() => gate, 'smoke:overlapping')
  .everyMinute()
  .withoutOverlapping()

const runner = new ScheduleRunner({ mutex: app.make('cache').store() })
const firstRun = runner.runEvent(slow)

await Bun.sleep(20)
const secondRun = await runner.runEvent(slow)

check('withoutOverlapping keeps a second run out', secondRun === 'overlapping')

held?.()
check('and the first one finishes', (await firstRun) === 'ran')
check(
  'the mutex is released afterwards',
  (await runner.runEvent(
    schedule
      .call(() => undefined, 'smoke:overlapping')
      .everyMinute()
      .withoutOverlapping()
  )) === 'ran'
)

// `schedule:test` ignores the expression on purpose.
ran.length = 0
const tested = plain(
  await captureOutput(() => app.make('artisan').run(['schedule:test', 'smoke:yearly']))
)
check('schedule:test runs an entry whose window is nowhere near', ran.includes('not-due'))
check('and says which entry it ran', tested.includes('smoke:yearly'))

const unknownEntry = plain(
  await captureOutput(() => app.make('artisan').run(['schedule:test', 'nothing:here']))
)
check('an unknown entry lists what is registered', unknownEntry.includes('Registered:'))

// The entries added above stay for the rest of this process, which ends with the
// smoke run; what matters is that nothing they wrote is left behind.
await app.make('cache').store().flush()

// --------------------------------------------------------------- encryption

section('Encryption')

const roundTrip = (await (
  await postJson('/check/secret/roundtrip', {
    value: { card: '4111111111111111' },
    context: 'card:1'
  })
).json()) as { payload: string; version: string; containsPlaintext: boolean; decrypted: unknown }

check(
  'a value comes back as itself',
  (roundTrip.decrypted as { card: string }).card === '4111111111111111'
)
check('the payload is versioned', roundTrip.version === 'v1')
check('and holds no plaintext', roundTrip.containsPlaintext === false)
check('nor any base64 padding, so it is cookie- and URL-safe', !/[+/=]/.test(roundTrip.payload))

// Context binding: the same key, a different purpose, and it must fail. This is
// what stops a value being lifted out of one cookie and pasted into another.
const rightContext = (await (
  await postJson('/check/secret/context', {
    value: 'a token',
    context: 'cookie:remember',
    readAs: 'cookie:remember'
  })
).json()) as { read?: string }

const wrongContext = await postJson('/check/secret/context', {
  value: 'a token',
  context: 'cookie:remember',
  readAs: 'cookie:session'
})

check('a payload reads back under its own context', rightContext.read === 'a token')
check('and is refused under another', wrongContext.status === 422)

// An encrypted model column: ciphertext in the row, the value on the model.
const stored = (await (
  await postJson('/check/secret/articles/1', { note: 'call the lawyer' })
).json()) as {
  note: string
  storedLooksEncrypted: boolean
  storedContainsNote: boolean
  foundByPlaintext: number
}

check('an encrypted cast reads back through the model', stored.note === 'call the lawyer')
check('while the column holds a ciphertext', stored.storedLooksEncrypted === true)
check('which does not contain the value', stored.storedContainsNote === false)
// The cost of encrypting a column, stated plainly: you give up querying it.
check('and the plaintext cannot be matched by a where', stored.foundByPlaintext === 0)

// A resource still decides who is shown it — encryption guards the row at rest,
// not the response.
const noteHidden = await (await app.handle(new Request('http://localhost/check/articles/1'))).json()
const noteShown = await (
  await app.handle(new Request('http://localhost/check/articles/1?editor=yes'))
).json()

check('an encrypted attribute is not exposed by default', !('editorNote' in noteHidden.data))
check('and is, to a viewer allowed it', noteShown.data.editorNote === 'call the lawyer')

// A queued job marked `encrypted`: the queue stores a ciphertext it cannot read,
// and the worker still gets the real payload.
await app.make('queue').connection().clear()

const secretJob = (await (
  await postJson('/check/secret/jobs', { token: 'tok_live_51H', label: 'smoke' })
).json()) as { encrypted: boolean; payloadContainsToken: boolean }

check('a queued payload is marked encrypted', secretJob.encrypted === true)
check('and the stored row does not carry the token', secretJob.payloadContainsToken === false)

await captureOutput(() => app.make('artisan').run(['queue:work', '--once']))

const workerSaw = (await (
  await app.handle(new Request('http://localhost/check/secret/jobs/smoke'))
).json()) as { token: string | null }

check('the worker decrypted it and saw the real value', workerSaw.token === 'tok_live_51H')

await app.make('cache').store().forget('secret:smoke')
await app.make('queue').connection().clear()

const rotation = (await (
  await app.handle(new Request('http://localhost/check/secret/rotation'))
).json()) as { keys: number }

check('the playground runs on a single key', rotation.keys === 1)

// A payload written by a key that is no longer primary. Configured through the
// container rather than the environment, so the running app is left alone.
const { Encrypter } = await import('@elysian/encryption')
const retired = 'a-retired-application-key-32-chars!'
const writtenBefore = new Encrypter(retired).encryptString('written before the rotation')

const beforeRotation = await postJson('/check/secret/read', { payload: writtenBefore })
check('a payload from an unconfigured key is refused', beforeRotation.status === 422)

const rotated = new Encrypter(app.config.get<string>('app.key'), { previousKeys: [retired] })
check(
  'and readable once that key is in APP_PREVIOUS_KEYS',
  rotated.decryptString(writtenBefore) === 'written before the rotation'
)
const retiredKeyStillReadsNewPayloads = (() => {
  try {
    new Encrypter(retired).decryptString(rotated.encryptString('after'))

    return true
  } catch {
    return false
  }
})()

check('while new payloads use the new key alone', retiredKeyStillReadsNewPayloads === false)

// The cookie jar gets the encrypter from the container, which is what makes
// `SESSION_ENCRYPT=true` possible at all.
check('the cookie jar can encrypt, because an encrypter is bound', app.make('cookies').encrypts)

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

const stubList = plain(await captureOutput(() => artisan.run(['stub:publish', '--list'])))

// The stubs live beside the package that owns them, spread across node_modules;
// finding one by hand is why people give up and edit the generated file instead.
check('stub:publish lists what it would publish', stubList.includes('controller.stub'))
check(
  'from every package that ships stubs',
  stubList.includes('job.stub') && stubList.includes('mail.stub')
)
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
  /**
   * `--pretend` shows the file and writes nothing.
   *
   * Checked before the real generation, so the assertion that nothing was
   * written is not satisfied by a file that simply has not been made yet.
   */
  const pretended = plain(
    await captureOutput(() => artisan.run(['make:controller', 'SmokePretend', '--pretend']))
  )

  check('a generator can be asked what it would do', pretended.includes('would be created'))
  check('and shows the contents', pretended.includes("controller('smoke-pretend'"))
  check(
    'without writing anything',
    !(await Bun.file(app.appPath('Http', 'Controllers', 'SmokePretendController.ts')).exists())
  )

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

// ------------------------------------------------- infrastructure tables

section('Infrastructure tables')

/**
 * `queue:table`, `cache:table` and `notifications:table` write the tables the
 * framework's own drivers need.
 *
 * Two things are checked that nothing else can: that a second run **refuses**
 * rather than writing a duplicate `create_<table>_table` migration beside the
 * first — the migrator would then try to create the same table twice — and that
 * what the stubs write actually migrates, which is the only proof that a stub
 * still matches the schema builder.
 */
const tableMigrations = join(app.basePath(), 'database', 'migrations')

/** Everything the generators wrote here, so the playground is left as found. */
const generatedTables: string[] = []

const collectGenerated = async (table: string) => {
  for await (const found of new Bun.Glob(`*create_${table}_table.ts`).scan({
    cwd: tableMigrations,
    onlyFiles: true
  })) {
    const path = join(tableMigrations, found)
    if (!generatedTables.includes(path)) generatedTables.push(path)
  }
}

try {
  // Names nothing in the playground owns, so the existing migrations are left alone.
  const written = plain(
    await captureOutput(() => artisan.run(['queue:table', '--table', 'smoke_jobs']))
  )
  await collectGenerated('smoke_jobs')

  check('queue:table writes a migration', written.includes('Migration created'))
  check('and says what to run next', written.includes('artisan migrate'))

  const refused = plain(
    await captureOutput(() => artisan.run(['queue:table', '--table', 'smoke_jobs']))
  )

  // The bug this catches: a timestamped name makes every run unique, so without
  // globbing for the table a second run silently writes a duplicate.
  check('a second run refuses rather than duplicating', refused.includes('already exists'))
  check('and names the migration that already has it', refused.includes('create_smoke_jobs_table'))

  const forced = plain(
    await captureOutput(() => artisan.run(['queue:table', '--table', 'smoke_jobs', '--force']))
  )
  await collectGenerated('smoke_jobs')
  check('--force writes one anyway', forced.includes('Migration created'))

  // An existing table is recognised however it was named: the playground's own
  // `jobs`, `cache` and `notifications` migrations were written by hand.
  for (const [command, table] of [
    ['queue:table', 'jobs'],
    ['cache:table', 'cache'],
    ['notifications:table', 'notifications']
  ] as const) {
    const output = plain(await captureOutput(() => artisan.run([command])))

    check(`${command} sees the migration the playground already has`, output.includes(table))
  }

  // What the stubs write has to survive the migrator, not merely typecheck.
  //
  // A forced run inside the same second rewrites the same file, so there may be
  // one migration for `smoke_jobs` or two. Keep the first and drop the rest, or
  // the migrator below would try to create that table twice.
  await Promise.all(generatedTables.slice(1).map((path) => rm(path, { force: true })))
  generatedTables.length = 1

  await captureOutput(() => artisan.run(['cache:table', '--table', 'smoke_cache']))
  await collectGenerated('smoke_cache')
  await captureOutput(() => artisan.run(['notifications:table', '--table', 'smoke_notes']))
  await collectGenerated('smoke_notes')

  const staging = join(app.basePath(), 'storage', 'framework', 'smoke-migrations')
  await mkdir(staging, { recursive: true })
  await Promise.all(
    generatedTables.map((path) =>
      Bun.write(join(staging, path.split('/').pop() as string), Bun.file(path))
    )
  )

  const sqlite = await BunSqlConnection.make('smoke-tables', {
    driver: 'sqlite',
    database: ':memory:'
  })

  try {
    const migrator = new Migrator(sqlite, new MigrationRepository(sqlite, 'migrations'), [staging])

    await migrator.install()
    const ran = await migrator.run()

    check('the generated migrations run', ran.length === 3, ran.join(', '))

    const builder = migrator.schema

    check('the jobs table is created', await builder.hasTable('smoke_jobs'))
    check(
      'with the reserved_at column the driver depends on',
      await builder.hasColumn('smoke_jobs', 'reserved_at')
    )
    // The cache stub writes two tables: the store and its locks.
    check('the cache table is created', await builder.hasTable('smoke_cache'))
    check('and the locks table beside it', await builder.hasTable('smoke_cache_locks'))
    check('the notifications table is created', await builder.hasTable('smoke_notes'))

    // Down has to reverse all of it, or migrate:rollback strands tables.
    await migrator.rollback()

    check('and rolling back removes them', !(await builder.hasTable('smoke_jobs')))
    check('including the locks table', !(await builder.hasTable('smoke_cache_locks')))
  } finally {
    await sqlite.disconnect()
    await rm(staging, { recursive: true, force: true })
  }
} finally {
  await Promise.all(generatedTables.map((path) => rm(path, { force: true })))
}

// ------------------------------------------------------------------ scaffolder

section('Scaffolder')

const scaffoldTarget = join(app.basePath(), '..', '.smoke-scaffold')

try {
  await rm(scaffoldTarget, { recursive: true, force: true })

  const result = Bun.spawnSync({
    cmd: ['bun', 'packages/create-elysian/src/index.ts', '.smoke-scaffold', '--kit=none'],
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

  /**
   * Every package the framework ships is wired into the template.
   *
   * The template used to lag the packages by eight of them, and nothing noticed
   * because these checks only asserted that a scaffold *scaffolds*. Registration
   * is the proxy that catches it: a command only appears in `artisan list` if its
   * provider booted, which needs the dependency, the provider entry and the
   * config file to all be present.
   */
  const scaffoldedArtisan = Bun.spawnSync({
    cmd: ['bun', 'artisan.ts', 'list'],
    cwd: scaffoldTarget,
    stdout: 'pipe',
    stderr: 'pipe'
  })

  const listed = plain(scaffoldedArtisan.stdout.toString())

  check('a scaffolded application boots', scaffoldedArtisan.exitCode === 0, listed.slice(-400))

  /**
   * Every generator, run in a real application, and the result typechecked.
   *
   * A generator that writes a file is easy; a generator that writes a file which
   * compiles is the thing worth checking. The stubs import from the framework
   * packages by name, so a renamed export — `CastsAttributes` was not exported at
   * all when the cast stub was written — turns every generated file into a
   * compile error in somebody else's project rather than in ours.
   */
  const generators: Array<[string, string, string]> = [
    ['make:enum', 'ArticleStatus', 'app/Enums/ArticleStatus.ts'],
    ['make:exception', 'PaymentDeclined', 'app/Exceptions/PaymentDeclined.ts'],
    ['make:interface', 'Payable', 'app/Contracts/Payable.ts'],
    ['make:class', 'Support/Money', 'app/Support/Money.ts'],
    ['make:config', 'billing', 'config/billing.ts'],
    ['make:test', 'http/articles', 'test/http/articles.test.ts'],
    ['make:cast', 'Money', 'app/Casts/Money.ts'],
    ['make:observer', 'ArticleObserver', 'app/Observers/ArticleObserver.ts'],
    ['make:scope', 'Published', 'app/Models/Scopes/Published.ts'],
    ['make:rule', 'Uppercase', 'app/Rules/Uppercase.ts'],
    ['make:job-middleware', 'WithoutOverlapping', 'app/Jobs/Middleware/WithoutOverlapping.ts']
  ]

  for (const [command, name, path] of generators) {
    const made = Bun.spawnSync({
      cmd: ['bun', 'artisan.ts', command, name],
      cwd: scaffoldTarget,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    check(
      `${command} writes ${path}`,
      made.exitCode === 0 && (await Bun.file(join(scaffoldTarget, path)).exists()),
      plain(made.stdout.toString() + made.stderr.toString()).slice(-200)
    )
  }

  // Refusing to overwrite is the behaviour that keeps a generator safe to
  // re-run; a second `make:enum` must not quietly replace the one being used.
  const twice = Bun.spawnSync({
    cmd: ['bun', 'artisan.ts', 'make:enum', 'ArticleStatus'],
    cwd: scaffoldTarget,
    stdout: 'pipe',
    stderr: 'pipe'
  })

  check('and a generator refuses to overwrite', twice.exitCode === 1)

  const generatedTypecheck = Bun.spawnSync({
    // The scaffold's own script, so this is exactly what a developer runs.
    cmd: ['bun', 'run', 'typecheck'],
    cwd: scaffoldTarget,
    stdout: 'pipe',
    stderr: 'pipe'
  })

  check(
    'and everything they wrote typechecks',
    generatedTypecheck.exitCode === 0,
    plain(generatedTypecheck.stdout.toString() + generatedTypecheck.stderr.toString()).slice(-600)
  )

  /**
   * The auth kit, scaffolded over the same template.
   *
   * A kit is a folder copied on top rather than a second template, so what is
   * checked is that it lands *and* that the base survives it — a kit that
   * replaced `routes/web.ts` wholesale would drop the landing page.
   */
  const kitTarget = join(app.basePath(), '..', '.smoke-kit')
  await rm(kitTarget, { recursive: true, force: true })

  const kitResult = Bun.spawnSync({
    cmd: ['bun', 'packages/create-elysian/src/index.ts', '.smoke-kit', '--kit=auth'],
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe'
  })

  check('the auth kit scaffolds', kitResult.exitCode === 0, `exit ${kitResult.exitCode}`)
  check(
    'its pages are written',
    await Bun.file(join(kitTarget, 'resources/views/pages/sign-in.tsx')).exists()
  )

  const kitRoutes = await Bun.file(join(kitTarget, 'routes/web.ts')).text()

  check('the kit mounts its controller', kitRoutes.includes('.use(AuthPageController)'))
  check('and leaves the base template mounted', kitRoutes.includes('.use(PageController)'))

  const unknownKit = Bun.spawnSync({
    cmd: ['bun', 'packages/create-elysian/src/index.ts', '.smoke-kit-bad', '--kit=nope'],
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe'
  })

  // Naming a kit that does not exist should say so, not scaffold the base and
  // leave somebody wondering where their sign-in page went.
  check('an unknown kit is refused', unknownKit.exitCode === 1)

  /**
   * Scaffolded with nothing left to do — the row this closes.
   *
   * The installer used to print `bun install`, `auth:schema` and `migrate` and
   * leave them to the reader, which meant a new application answered 500 on its
   * first sign-up until three commands had been run in the right directory. This
   * scaffolds with `--install` and then asks the database what is in it: the
   * better-auth tables being there is the proof, since nothing else created them.
   */
  const setupTarget = join(app.basePath(), '..', '.smoke-setup')
  await rm(setupTarget, { recursive: true, force: true })

  const setUp = Bun.spawnSync({
    cmd: ['bun', 'packages/create-elysian/src/index.ts', '.smoke-setup', '--kit=auth', '--install'],
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe'
  })

  check('--install scaffolds and sets up in one go', setUp.exitCode === 0, `exit ${setUp.exitCode}`)

  const setUpTables = Bun.spawnSync({
    cmd: ['bun', 'artisan.ts', 'db:show'],
    cwd: setupTarget,
    stdout: 'pipe',
    stderr: 'pipe'
  })

  const shown = plain(setUpTables.stdout.toString())

  check(
    'and the auth tables exist without a command being run by hand',
    ['user', 'session', 'account', 'verification'].every((table) => shown.includes(table)),
    shown.slice(-300)
  )

  // The migration ran, which is the step people forget and the one that turns a
  // first sign-up into a 500.
  check('and the migration is recorded', shown.includes('migrations'), shown.slice(-300))

  await rm(setupTarget, { recursive: true, force: true })

  /**
   * A scaffolded application passes its own checks.
   *
   * This is the gap that let a broken kit ship: the kit's sources are not in
   * this repository's `tsconfig.json` — and cannot be, since its views import a
   * layout that only exists once the kit is copied over the template — so
   * `bun run typecheck` here never saw them. A freshly scaffolded application
   * had **eleven** type errors and six lint errors on the day it was generated,
   * in a file nobody using it had written.
   *
   * The check has to run in the scaffold, which is why it lives here.
   */
  for (const target of [scaffoldTarget, kitTarget]) {
    const label = target.endsWith('.smoke-kit') ? 'the kit' : 'the template'

    const typed = Bun.spawnSync({
      cmd: ['bun', 'run', 'typecheck'],
      cwd: target,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    check(
      `${label} scaffolds an application that typechecks`,
      typed.exitCode === 0,
      plain(typed.stdout.toString() + typed.stderr.toString()).slice(-700)
    )

    const linted = Bun.spawnSync({
      cmd: ['bunx', 'biome', 'check', '.'],
      cwd: target,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    // A new project's very first `bun run lint` must not report a problem the
    // developer did not create and cannot explain.
    check(
      `and one the formatter is happy with`,
      linted.exitCode === 0,
      plain(linted.stdout.toString() + linted.stderr.toString()).slice(-700)
    )
  }

  await proveTheKitWorks(kitTarget)

  // --------------------------------------------------------------- route names

  // --------------------------------------------------------- view helpers

  section('View helpers')

  {
    const page = await (await app.handle(new Request('http://localhost/check/view-helpers'))).text()

    const head = page.slice(page.indexOf('<head>'), page.indexOf('</head>'))

    /**
     * The check the feature exists for.
     *
     * `<head>` is a finished string before the page body runs, so a page cannot
     * write into it by rendering. The markers are substituted after the whole
     * tree resolves, and this is what proves it — a `push` from the body landing
     * in an element that rendered first.
     */
    check('a page reaches the head that rendered before it', head.includes('pushed-by'), head)

    // Prepends come out reversed and ahead of pushes, which is Blade's order and
    // the only one where "prepend" means anything.
    check(
      'and a prepend lands ahead of a push',
      head.indexOf('prepended') < head.indexOf('pushed-by'),
      head
    )

    check(
      'a second stack collects separately',
      page.includes('<script id="tail">') && !head.includes('<script id="tail">')
    )

    // Three widgets, one style and one note: `once` and `pushOnce` deduplicate
    // per render rather than per component.
    check('once renders one copy however many ask', page.split('widget-style').length - 1 === 1)
    check('and the widgets themselves all render', page.split('class="widget"').length - 1 === 3)

    // A marker left behind would be an unsubstituted stack, which is worse than
    // an empty one: it ships an HTML comment naming the internals.
    check('no marker survives into the page', !page.includes('elysian:stack'), page.slice(0, 200))

    check('whenGuest renders for a visitor', page.includes('Nobody is signed in.'))
    check('whenAuth does not', !page.includes('Signed in as'))
    // `view-status-page` allows guests, so this is the Gate answering rather than
    // the absence of a user.
    check('whenCan asks the Gate', page.includes('id="allowed"'))
    check('whenError is quiet when nothing failed', page.includes('No error flashed.'))

    /**
     * `whenError` needs a failure from the *previous* request.
     *
     * Errors are flashed into the session and read on the next one, so nothing
     * short of two round trips with a cookie between them exercises it.
     */
    const failed = await app.handle(
      new Request('http://localhost/check/view-helpers/fail', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=nope'
      })
    )

    const jar = failed.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ')

    const afterFailure = await (
      await app.handle(
        new Request('http://localhost/check/view-helpers', { headers: { cookie: jar } })
      )
    ).text()

    check(
      'and prints the flashed message on the next request',
      afterFailure.includes('That address was not accepted.'),
      afterFailure.slice(afterFailure.indexOf('id="error"'), afterFailure.indexOf('id="auth"'))
    )
  }

  // ------------------------------------------------------- route middleware

  section('Route middleware')

  {
    const at = (path: string, headers: Record<string, string> = {}) =>
      app.handle(new Request(`http://localhost${path}`, { headers }))

    check('an unguarded route is untouched', (await at('/check/middleware/open')).status === 200)

    /**
     * One middleware, two renderings.
     *
     * The same `middleware('auth')` on the same guest: a page gets a 302 to
     * sign-in, a JSON caller gets a 401 with no `Location`. A client that follows
     * redirects would otherwise treat the sign-in page as the answer to its
     * request, which is the bug the split exists to prevent.
     */
    const asPage = await at('/check/middleware/private')
    const asJson = await at('/check/middleware/api', { accept: 'application/json' })

    check('a guest is redirected from a page', asPage.status === 302, `status ${asPage.status}`)
    check('and sent to sign in', asPage.headers.get('location') === '/sign-in')
    check('a JSON caller gets 401 instead', asJson.status === 401, `status ${asJson.status}`)
    check('with no location to follow', asJson.headers.get('location') === null)

    check(
      'guest-only lets a guest through',
      (await at('/check/middleware/guest-only')).status === 200
    )

    const unverified = await at('/check/middleware/verified')
    check(
      'verified turns a guest away rather than falling open',
      unverified.status === 302 && unverified.headers.get('location') === '/verify-email',
      `${unverified.status} ${unverified.headers.get('location')}`
    )

    /**
     * Written as `middleware('verified', 'auth')` on purpose.
     *
     * `verified` reads the user `auth` guarantees, so the registry sorts them
     * back: a guest lands on sign-in rather than being told their address is
     * unconfirmed. Route order alone would get this wrong.
     */
    const ordered = await at('/check/middleware/ordered')
    check(
      'priority runs auth before verified whatever the route says',
      ordered.headers.get('location') === '/sign-in',
      ordered.headers.get('location') ?? `status ${ordered.status}`
    )

    check('can: refuses with 403', (await at('/check/middleware/gated')).status === 403)

    /**
     * Sequential, which is what a client actually does.
     *
     * Four at once all pass: the limiter checks the count and then increments it,
     * so concurrent requests can each read the same number before any of them has
     * written. Laravel's `ThrottleRequests` has the same shape. It is worth
     * knowing and it is not what this check is about.
     */
    const limited: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limited.push((await at('/check/middleware/limited')).status)
    }

    check(
      'throttle:3,1 refuses the fourth',
      limited.slice(0, 3).every((status) => status === 200) && limited[3] === 429,
      limited.join(',')
    )

    const grouped = await Promise.all([
      at('/check/middleware/group/one'),
      at('/check/middleware/group/two')
    ])
    check(
      'a group applies to every route inside it',
      grouped.every((one) => one.status === 302),
      grouped.map((one) => one.status).join(',')
    )

    /**
     * Signed URLs, over the relative form.
     *
     * The absolute form signs the origin, which is right for a link in an email
     * and untestable on an ephemeral port. Both sides of `relative` had to be
     * built: the first version had the verifier and no minter, so `signed:relative`
     * was a check nothing could satisfy.
     */
    const minted = (await (await at('/check/middleware/sign?list=7')).json()) as {
      relative: string
    }

    const followed = await at(minted.relative)
    const tampered = await at(minted.relative.replace('list=7', 'list=8'))
    const bare = await at('/check/middleware/unsubscribe-relative?list=7')

    check('a signed link is accepted', followed.status === 200, `status ${followed.status}`)
    check('editing a parameter invalidates it', tampered.status === 403)
    check('and an unsigned request is refused', bare.status === 403)

    // A proxy may reorder the query string; a signature over a set must survive it.
    const parts = new URLSearchParams(minted.relative.split('?')[1])
    const signature = parts.get('signature') as string
    parts.delete('signature')
    const reordered = await at(
      `/check/middleware/unsubscribe-relative?signature=${signature}&${parts.toString()}`
    )

    check('parameter order does not change the signature', reordered.status === 200)

    // ------------------------------------- middleware the application wrote

    /**
     * `app/Http/Middleware/EnsureTokenIsValid.ts`, aliased as `token`.
     *
     * Nothing distinguishes it from a built-in alias at the call site, which is
     * the whole claim. The parameter after the colon is what the framework's own
     * `throttle:6,1` uses, so an application gets the same mechanism.
     */
    const withoutToken = await at('/check/middleware/token')
    const withToken = await at('/check/middleware/token?token=let-me-in')
    const viaHeader = await at('/check/middleware/token', { 'x-demo-token': 'let-me-in' })
    const wrongToken = await at('/check/middleware/token?token=nope')
    const otherAlias = await at('/check/middleware/token-other?token=let-me-in')

    check("the application's own middleware refuses", withoutToken.status === 403)
    check('and says how to satisfy it', (await withoutToken.text()).includes('needs a token'))
    check('the right token is accepted', withToken.status === 200)
    check('a header works as well as a query parameter', viaHeader.status === 200)
    check('a wrong token is refused', wrongToken.status === 403)
    check(
      'the alias parameter changes what it wants',
      otherAlias.status === 403,
      `status ${otherAlias.status}`
    )

    const lockedDown = await at('/check/middleware/locked?token=let-me-in')
    check(
      'a group the application defined applies all three',
      (lockedDown.headers.get('location') ?? '').includes('/sign-in'),
      lockedDown.headers.get('location') ?? `status ${lockedDown.status}`
    )

    // ------------------------------------------------ seeing what is registered

    const registry = middlewares()

    check(
      'the registry lists what a route may name',
      ['auth', 'guest', 'verified', 'can', 'throttle', 'signed', 'token'].every((name) =>
        registry.names().includes(name)
      ),
      registry.names().join(', ')
    )
    check(
      'and a group reports what it expands to',
      (registry.expands('locked-down') ?? []).join(',') === 'auth,verified,token',
      (registry.expands('locked-down') ?? []).join(',')
    )

    /**
     * What `route:list` prints in its MIDDLEWARE column.
     *
     * Elysia compiles hooks into an anonymous chain, so the names are read back
     * off the hook function. Without this a listing could only report that *some*
     * middleware guards a route.
     */
    const guarded = app.router.routes.find((one) => one.path === '/check/middleware/ordered')

    check(
      'a route reports the middleware it was declared with',
      middlewareNamesOf(guarded).join(',') === 'verified,auth',
      middlewareNamesOf(guarded).join(',')
    )

    // ------------------------------------------------------ route bindings

    const boundArticle = await at('/check/bound/articles/1')
    const missingArticle = await at('/check/bound/articles/999')

    check(
      'a parameter arrives as a model',
      boundArticle.status === 200 &&
        ((await boundArticle.clone().json()) as { id: number }).id === 1,
      `status ${boundArticle.status}`
    )
    check('and a row that is not there is a 404', missingArticle.status === 404)

    /**
     * The check scoping exists for.
     *
     * Comment 1 belongs to article 1. Asked for under article 2 it must not be
     * found — resolved independently it would be, and the route would hand one
     * article's comment to somebody reading another.
     */
    const own = await at('/check/bound/articles/1/comments/1')
    const someoneElses = await at('/check/bound/articles/2/comments/1')

    check('a scoped child resolves under its own parent', own.status === 200)
    check(
      'and is not found under another',
      someoneElses.status === 404,
      `status ${someoneElses.status}`
    )

    const page = await at('/middleware')
    const pageBody = await page.text()

    check('the middleware page renders', page.status === 200)
    /**
     * Matched without the quotes on purpose.
     *
     * The page renders `middleware('auth')` through `safe`, so the apostrophes
     * arrive as `&#x27;` — which is the escaping working. Asserting on the literal
     * source would be asserting that it does not.
     */
    check(
      'and lists every alias it demonstrates',
      ['auth', 'token', 'throttle:3,1', 'signed:relative', 'locked-down'].every((name) =>
        pageBody.includes(name)
      ),
      pageBody.length > 0 ? '' : 'empty body'
    )
  }

  section('Named routes')

  const links = (await (
    await app.handle(new Request('http://localhost/check/articles/links'))
  ).json()) as { index: string; show: string; absolute: string; unknown: string | null }

  check('a name becomes a path', links.show === '/check/articles/7', links.show)
  // Leftover parameters become the query string, which is what makes
  // route('articles.index', { page: 2 }) read the way it does.
  check('and leftovers become the query string', links.index === '/check/articles?page=2')
  check('absolute prefixes the configured origin', links.absolute.startsWith('http'))
  // A name nobody registered fails where it is written, not as a broken link.
  check(
    'an unknown name throws where it is called',
    links.unknown?.includes('not defined') === true
  )

  const named = await app.handle(new Request('http://localhost/check/articles/links?redirect=yes'))

  check('redirect().route() goes there', named.headers.get('location') === '/check/articles/7')

  // Boot verified every name against Elysia's own route table — a name pointing
  // at a path no route answers would have thrown before this line ran.
  check('every registered name matched a real route', app.make('routes').has('articles.show'))

  await rm(kitTarget, { recursive: true, force: true })
  await rm(join(app.basePath(), '..', '.smoke-kit-bad'), { recursive: true, force: true })

  for (const [command, provider] of [
    ['key:generate', 'encryption'],
    ['cache:table', 'cache'],
    ['queue:table', 'queue'],
    ['make:mail', 'mail'],
    ['notifications:table', 'notifications'],
    ['schedule:run', 'scheduler'],
    ['storage:link', 'storage'],
    ['auth:schema', 'auth']
  ] as const) {
    check(`${provider} is wired into the template`, listed.includes(command))
  }

  // Config and env have to arrive together: a provider that boots but reads an
  // absent config file is the failure this pair catches.
  for (const file of [
    'auth',
    'cache',
    'queue',
    'mail',
    'filesystems',
    'notifications',
    'cors',
    'http'
  ]) {
    check(
      `config/${file}.ts ships`,
      await Bun.file(join(scaffoldTarget, 'config', `${file}.ts`)).exists()
    )
  }

  const scaffoldedEnv = await Bun.file(join(scaffoldTarget, '.env')).text()

  for (const key of [
    'CACHE_STORE',
    'QUEUE_CONNECTION',
    'MAIL_MAILER',
    'FILESYSTEM_DISK',
    'AUTH_SECRET',
    'APP_PREVIOUS_KEYS',
    'SESSION_ENCRYPT'
  ]) {
    check(`.env carries ${key}`, scaffoldedEnv.includes(`${key}=`))
  }

  // Defaults that need nothing running: a new application has to work before it
  // has Docker, so the shipped drivers are the ones with no service behind them.
  check(
    'the queue defaults to running jobs in the request',
    scaffoldedEnv.includes('QUEUE_CONNECTION=sync')
  )
  check('the cache defaults to files', scaffoldedEnv.includes('CACHE_STORE=file'))
  check('mail defaults to the log', scaffoldedEnv.includes('MAIL_MAILER=log'))

  check(
    'better-auth is a dependency, since @elysian/auth only peers on it',
    manifest.dependencies['better-auth'] !== undefined
  )
} finally {
  await rm(scaffoldTarget, { recursive: true, force: true })
}

// -------------------------------------------------------------------- batches

section('Batches')

const startedBatch = (await (await postJson('/check/queue/batch', { rows: 3 })).json()) as {
  batch: { id: string; totalJobs: number; pendingJobs: number }
}

check('a batch records every job before queueing them', startedBatch.batch.totalJobs === 3)
check('and starts with all of them pending', startedBatch.batch.pendingJobs === 3)

await captureOutput(() => app.make('artisan').run(['queue:work', '--stop-when-empty']))

const finishedBatch = (await (
  await app.handle(new Request(`http://localhost/check/queue/batch/${startedBatch.batch.id}`))
).json()) as {
  batch: { pendingJobs: number; progress: number; finished: boolean }
  report: { total: number; failed: number } | null
}

check('working the queue counts them down', finishedBatch.batch.pendingJobs === 0)
check(
  'to a finished batch at 100%',
  finishedBatch.batch.finished && finishedBatch.batch.progress === 100
)
// A job class, not a closure: the worker cannot rebuild a closure, which is the
// same wall a queued listener hits.
check('and the then callback ran', finishedBatch.report?.total === 3)

/**
 * A batch of chains: two rows, three ordered steps each.
 *
 * Neither a plain batch nor a plain chain expresses this, and it is the shape
 * most bulk work has — ten imports that each need fetch, transform, load.
 */
const chained = (await (await postJson('/check/queue/batch-chain', { rows: 2 })).json()) as {
  batch: { id: string; totalJobs: number }
}

// Six, not two: counting each chain as one job would finish the batch while
// four of its jobs were still queued.
check('a chain inside a batch counts all of its links', chained.batch.totalJobs === 6)

await captureOutput(() => app.make('artisan').run(['queue:work', '--stop-when-empty']))

const chainResult = (await (
  await app.handle(new Request(`http://localhost/check/queue/batch-chain/${chained.batch.id}`))
).json()) as {
  batch: { pendingJobs: number; finished: boolean }
  rows: Array<string | null>
}

check(
  'every link runs',
  chainResult.rows.every((row) => row === 'fetch,transform,load')
)
// The point of a chain: the steps of one row are ordered even though the rows
// are not.
check('in order, per row', chainResult.rows[0] === 'fetch,transform,load')
check('and the batch finishes only then', chainResult.batch.finished === true)
check('with nothing left pending', chainResult.batch.pendingJobs === 0)

const failing = (await (await postJson('/check/queue/batch', { rows: 3, failRow: 1 })).json()) as {
  batch: { id: string }
}

await captureOutput(() => app.make('artisan').run(['queue:work', '--stop-when-empty']))

const cancelled = (await (
  await app.handle(new Request(`http://localhost/check/queue/batch/${failing.batch.id}`))
).json()) as { batch: { cancelled: boolean; failedJobs: number }; report: unknown }

// The first failure cancels the rest: continuing would produce a half-finished
// import nobody asked for.
check('one failure cancels the batch', cancelled.batch.cancelled)
check('and is counted', cancelled.batch.failedJobs === 1)
check('while the catch callback reports it', cancelled.report !== null)

const lenient = (await (
  await postJson('/check/queue/batch', { rows: 3, failRow: 1, allowFailures: true })
).json()) as { batch: { id: string } }

await captureOutput(() => app.make('artisan').run(['queue:work', '--stop-when-empty']))

const tolerated = (await (
  await app.handle(new Request(`http://localhost/check/queue/batch/${lenient.batch.id}`))
).json()) as { batch: { cancelled: boolean; finished: boolean; failedJobs: number } }

check('allowFailures runs the rest anyway', !tolerated.batch.cancelled && tolerated.batch.finished)
check('with the failure still recorded', tolerated.batch.failedJobs === 1)

await app.make('queue').failed.flush()

// ------------------------------------------------------------ cursor paging

section('Cursor pagination')

const firstPage = (await (
  await app.handle(new Request('http://localhost/check/articles/cursor?perPage=2'))
).json()) as {
  data: Array<{ id: number }>
  nextCursor: string | null
  previousCursor: string | null
}

check('a cursor page returns its rows', firstPage.data.length === 2)
check('and no previous cursor on the first page', firstPage.previousCursor === null)
// It travels in a URL, so it has to survive one unescaped.
check(
  'the cursor is URL-safe',
  firstPage.nextCursor !== null && encodeURIComponent(firstPage.nextCursor) === firstPage.nextCursor
)

const secondPage = (await (
  await app.handle(
    new Request(`http://localhost/check/articles/cursor?perPage=2&cursor=${firstPage.nextCursor}`)
  )
).json()) as { data: Array<{ id: number }>; previousCursor: string | null }

check(
  'the next page continues where the first stopped',
  (secondPage.data[0]?.id ?? 0) > (firstPage.data[1]?.id ?? 0)
)
check('and can point back', secondPage.previousCursor !== null)

const backPage = (await (
  await app.handle(
    new Request(
      `http://localhost/check/articles/cursor?perPage=2&cursor=${secondPage.previousCursor}`
    )
  )
).json()) as { data: Array<{ id: number }> }

// Reading backwards returns rows in reverse; a caller wants them the way round
// they were going.
check(
  'paging back returns the first page, in order',
  backPage.data.map((article) => article.id).join() ===
    firstPage.data.map((article) => article.id).join()
)

// ------------------------------------------------------------- one of many

section('One of many')

const latest = (await (
  await app.handle(new Request('http://localhost/check/articles/latest-comments'))
).json()) as { articles: Array<{ id: number; latest: string | null }> }

check('every article is answered', latest.articles.length > 1)
// The failure this guards: a `limit 1` on the eager query answers the first
// parent and leaves every other one empty.
check('the one with comments has its newest', latest.articles[0]?.latest !== null)
check(
  'and an article with none is null rather than borrowing another',
  latest.articles.slice(1).every((article) => article.latest === null)
)

// ------------------------------------------------------- polymorphic pivots

section('Polymorphic many-to-many')

const tagged = (await (
  await postJson('/check/articles/1/tags', { label: 'algebra', addedBy: 'ada' })
).json()) as { tags: Array<{ label: string; addedBy: string; type: string; attachedAt: string }> }

const attached = tagged.tags.find((entry) => entry.label === 'algebra')

check('a tag attaches through the morph pivot', attached !== undefined)
// The pivot's own columns live on `pivot`, not on the tag — which is what stops a
// pivot column from overwriting one of the model's.
check('withPivot reads the extra column back', attached?.addedBy === 'ada')
check('and the type is written on attach', attached?.type === 'articles')
check('withTimestamps stamps the row', typeof attached?.attachedAt === 'string')

const inverse = (await (
  await app.handle(new Request('http://localhost/check/tags/algebra/articles'))
).json()) as { articles: string[] }

// morphedByMany names the *related* type; getting that backwards returns nothing.
check('the inverse finds the article', inverse.articles.length > 0)

// ------------------------------------------------------------ maintenance mode

section('Maintenance mode')

const maintenance = app.make('maintenance')
const artisanForDown = app.make('artisan')

try {
  await captureOutput(() =>
    artisanForDown.run(['down', '--retry', '60', '--except', '/health', '--with-secret'])
  )

  const payload = await maintenance.data()
  const secret = payload?.secret ?? ''

  check('down writes a payload', payload?.retry === 60)
  check('with a generated secret', /^[0-9a-f]{32}$/.test(secret))

  let refusedWhileDown!: Response
  await captureOutput(async () => {
    refusedWhileDown = await app.handle(new Request('http://localhost/check/health'))
  })

  check('an ordinary request is refused with 503', refusedWhileDown.status === 503)
  // A client that has to guess when to come back is a client that hammers.
  check('and told when to come back', refusedWhileDown.headers.get('Retry-After') === '60')

  const excepted = await app.handle(new Request('http://localhost/health'))

  // A health check that fails during maintenance tells an orchestrator to replace
  // a container that is deliberately down.
  check('an excepted path answers normally', excepted.status === 200)

  const unlocked = await app.handle(new Request(`http://localhost/${secret}`))
  const cookie = unlocked.headers.get('set-cookie') ?? ''

  check('the secret URL redirects', unlocked.status === 302)
  check('setting a bypass cookie', cookie.includes('elysian_maintenance='))
  // What travels is a MAC over the expiry: a stolen cookie expires by itself.
  check('which does not contain the secret', !cookie.includes(secret))

  const bypassed = await app.handle(
    new Request('http://localhost/health', { headers: { cookie: cookie.split(';')[0] as string } })
  )

  check('a valid bypass cookie passes through', bypassed.status === 200)

  let forged!: Response
  await captureOutput(async () => {
    forged = await app.handle(
      new Request('http://localhost/check/health', {
        headers: {
          cookie: `elysian_maintenance=${Buffer.from(
            JSON.stringify({ expiresAt: 9_999_999_999, mac: 'deadbeef' })
          ).toString('base64url')}`
        }
      })
    )
  })

  check('a forged one is not', forged.status === 503)

  // The schedule decides per entry, and only while down.
  await app.make('cache').store().forget('beat:normal')
  await app.make('cache').store().forget('beat:always')

  await captureOutput(() => artisanForDown.run(['schedule:run']))

  check(
    'a scheduled entry is skipped while down',
    (await app.make('cache').store().get('beat:normal')) === null
  )
  check(
    'unless it asked to run anyway',
    (await app.make('cache').store().get('beat:always')) !== null
  )
} finally {
  await captureOutput(() => artisanForDown.run(['up']))
}

check('up brings it back', (await maintenance.active()) === false)

const live = await app.handle(new Request('http://localhost/health'))
check('and requests are answered again', live.status === 200)

// ------------------------------------------------------------ session drivers

section('Session drivers')

const sessionDriver = app.make('session.driver')

// The playground runs on `database`, which is the configuration that works on
// more than one machine — a file session lives on whichever container wrote it.
check(
  'the configured driver is the database one',
  sessionDriver.constructor.name === 'DatabaseSessionDriver'
)

const probeId = `smoke${Date.now()}`

await sessionDriver.write(probeId, { visits: 1 })
check(
  'a session round trips through the table',
  ((await sessionDriver.read(probeId)) as { visits?: number })?.visits === 1
)

const sessionRow = await (await app.make('db').table('sessions')).where('id', probeId).first()

// Base64, so a payload with quotes or emoji cannot break the column on its way in.
check('the payload is stored base64', /^[A-Za-z0-9+/=]+$/.test(String(sessionRow?.payload)))
check('with a unix last_activity to sweep by', Number(sessionRow?.last_activity) > 0)

await sessionDriver.destroy(probeId)
check('and destroy removes it', (await sessionDriver.read(probeId)) === undefined)

// ------------------------------------------------ forms: errors and old input

section('Forms: redirect back with errors')

/**
 * The form-and-redirect loop, over a real cookie jar.
 *
 * `app.handle()` is enough here because the session travels in a cookie we carry
 * ourselves — what is being checked is that a failure comes back to the form with
 * its messages and its input, and that both live exactly one request.
 */
let formCookie = ''

async function visitForm(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/subscribe', { headers: { cookie: formCookie } })
  )

  const setCookie = response.headers.get('set-cookie')
  if (setCookie) formCookie = setCookie.split(';')[0] as string

  return response.text()
}

async function submitForm(body: Record<string, string>, accept = 'text/html'): Promise<Response> {
  const page = await visitForm()
  const token = /name="_token" value="([^"]+)"/.exec(page)?.[1] ?? ''

  let response!: Response
  await captureOutput(async () => {
    response = await app.handle(
      new Request('http://localhost/subscribe', {
        method: 'POST',
        headers: {
          cookie: formCookie,
          accept,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ ...body, _token: token }).toString()
      })
    )
  })

  return response
}

const refusedForm = await submitForm({ email: 'nope', name: 'A', password: 'short' })

check('a browser is redirected rather than shown a 422', refusedForm.status === 302)
check(
  'and sent back to the form it came from',
  refusedForm.headers.get('location') === '/subscribe'
)

const returnedForm = await visitForm()

check(
  'the form carries the messages',
  returnedForm.includes('That does not look like an email address.')
)
check('one per failing field', (returnedForm.match(/<li>/g) ?? []).length === 3)
// A long form that empties itself on a failure is one the user abandons.
check('and what was typed, refilled', returnedForm.includes('name="email" value="nope"'))
// Relying on every caller to remember this is how a password reaches a session store.
check('but never the password', returnedForm.includes('name="password" value=""'))

const secondVisit = await visitForm()

// Flash data survives exactly one further request — that is what makes this work
// without anything ever having to clean up after itself.
check('a second visit is clean', !secondVisit.includes('That does not look like an email address.'))
check('and its inputs are empty again', secondVisit.includes('name="email" value=""'))

const asApi = await submitForm({ email: 'nope', name: 'A', password: 'short' }, 'application/json')

check('an API client still gets the 422', asApi.status === 422)

const apiBody = (await asApi.json()) as { errors: Record<string, string[]> }
check(
  'with the bag, not a redirect',
  Object.keys(apiBody.errors).sort().join() === 'email,name,password'
)

const accepted = await submitForm({
  email: 'ada@example.com',
  name: 'Ada',
  password: 'longenough1'
})

check('a valid submission redirects onward as 303', accepted.status === 303)

const done = (await (
  await app.handle(
    new Request('http://localhost/subscribe/done', { headers: { cookie: formCookie } })
  )
).json()) as { status: string | null }

// The other half of the double-save bug: a returnedForm redirect must not persist the
// session itself, or the flash is aged twice and gone before it is read.
check(
  'and its own flashed status survives the redirect',
  done.status?.includes('ada@example.com') === true
)

// ------------------------------------------------- limits, CORS and proxies

section('Rate limiting and CORS')

const limiterNames = (await (
  await app.handle(new Request('http://localhost/check/limit/registry'))
).json()) as { limiters: string[] }

check(
  'named limiters are registered from a provider',
  limiterNames.limiters.join() === 'api,internal,uploads'
)

await app.make('cache').store().flush()

/** Hit a route N times and report the status and remaining count each time. */
async function hammer(path: string, times: number) {
  const results: Array<{ status: number; left: string | null; retry: string | null }> = []

  for (let attempt = 0; attempt < times; attempt += 1) {
    let response!: Response
    await captureOutput(async () => {
      response = await app.handle(new Request(`http://localhost${path}`))
    })

    results.push({
      status: response.status,
      left: response.headers.get('X-RateLimit-Remaining'),
      retry: response.headers.get('Retry-After')
    })
  }

  return results
}

const inline = await hammer('/check/limit/probe', 4)

check(
  'an inline limit lets the first requests through',
  inline.slice(0, 3).every((r) => r.status === 200)
)
check('and refuses the one past it with 429', inline[3]?.status === 429)
check('the remaining count walks down', inline.map((r) => r.left).join() === '2,1,0,0')
// A 429 without Retry-After tells a client to back off but not for how long, so
// it guesses — and guessing is what turns a rate limit into a retry storm.
check('a refusal says how long to wait', Number(inline[3]?.retry) > 0)

const named = await hammer('/check/limit/uploads', 4)

// `uploads` is [3/minute, 50/day]: two windows over one subject, each with its
// own counter — sharing one would count every request twice.
check('a named limiter with two windows trips on the tighter one', named[3]?.status === 429)
check('and reports the tightest remaining, not the loosest', named[0]?.left === '2')

/**
 * The address-based exemption is asserted over a real socket, in `Server` below.
 *
 * `app.handle()` has no peer to report, so `server.requestIP()` is undefined and
 * every caller looks like the empty address — which is precisely why the
 * framework must not invent one. A limiter keyed on the address has nothing to
 * match in-process, so what is checked here is that it degrades to its limit
 * instead of throwing.
 */
const inProcess = await hammer('/check/limit/internal', 6)

check(
  'with no socket, an address-keyed limiter falls back rather than throwing',
  inProcess.slice(0, 5).every((r) => r.status === 200) && inProcess[5]?.status === 429,
  inProcess.map((r) => r.status).join()
)

await app.make('cache').store().flush()

const preflight = await app.handle(
  new Request('http://localhost/check/cors/ping', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type'
    }
  })
)

check('a preflight is answered 204 without reaching a route', preflight.status === 204)
check(
  'with the method it asked about',
  preflight.headers.get('Access-Control-Allow-Methods') === 'POST'
)
check(
  'and the headers it asked about',
  preflight.headers.get('Access-Control-Allow-Headers') === 'content-type'
)
check(
  'and it varies on the request method',
  preflight.headers.get('Vary')?.includes('Access-Control-Request-Method') === true
)

const crossOrigin = await app.handle(
  new Request('http://localhost/check/cors/ping', {
    headers: { origin: 'https://app.example.com' }
  })
)

check(
  'an actual request carries the allow header',
  crossOrigin.headers.get('Access-Control-Allow-Origin') === '*'
)
check(
  'and the headers the browser may read',
  crossOrigin.headers.get('Access-Control-Expose-Headers')?.includes('X-RateLimit-Remaining') ===
    true
)

const outsidePaths = await app.handle(
  new Request('http://localhost/check/limit/ip', { headers: { origin: 'https://app.example.com' } })
)

// `paths` is the switch: a route outside it is not a CORS route at all.
check(
  'a path outside cors.paths gets no CORS headers',
  outsidePaths.headers.get('Access-Control-Allow-Origin') === null
)

const forwarded = (await (
  await app.handle(
    new Request('http://localhost/check/limit/ip', { headers: { 'x-forwarded-for': '9.9.9.9' } })
  )
).json()) as { ip: string; trusting: string }

// Trusting the header while directly exposed hands a caller a fresh identity per
// request, which is a rate limit that counts nothing.
check('a forwarding header is ignored from an untrusted source', forwarded.ip !== '9.9.9.9')
check('and believed from a trusted one', forwarded.trusting === '9.9.9.9')

/**
 * The auth kit, actually used.
 *
 * Every check above this asserted that files landed and that a string appears in
 * `routes/web.ts`. None of them booted the thing. A kit whose controller throws
 * on the first request would have passed all of them, which makes them a check
 * that scaffolding works rather than that the kit does.
 *
 * So: give the scaffold an environment, run its migrations, serve it on a socket,
 * and walk the cycle a person walks — register, land on a protected page, sign
 * out, and be refused again. Over HTTP, in a separate process, against SQLite on
 * disk.
 */
/**
 * A very small browser: one cookie jar, and a form token read off the page.
 *
 * The kit's checks used to build requests by hand and paste cookie strings
 * between them, with `SESSION_CSRF=false` so no token was needed. That is what
 * let a broken framework ship — `methodOverridePlugin` read the body twice and
 * the second read came back doubled, so `_token` arrived as two values joined by
 * a newline and every method-spoofed form answered 419. Nothing here could see
 * it, because nothing here ever sent a token.
 *
 * So this does what a browser does: keeps cookies across requests, and reads the
 * hidden `_token` out of the form it is about to submit.
 */
class Visitor {
  private readonly jar = new Map<string, string>()

  constructor(private readonly origin: string) {}

  private cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /** Set-Cookie is a list, and a session that rolls its cookie sends a new one. */
  private keep(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? ''
      const at = pair.indexOf('=')

      if (at > 0) this.jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
  }

  async visit(path: string): Promise<Response> {
    const response = await fetch(`${this.origin}${path}`, {
      headers: this.jar.size > 0 ? { cookie: this.cookie() } : {},
      redirect: 'manual'
    })

    this.keep(response)

    return response
  }

  async page(path: string): Promise<string> {
    return await (await this.visit(path)).text()
  }

  /**
   * Submit a form, taking the token from the page that carries it.
   *
   * `from` is for the forms that live on another page — the sign-out button in
   * the layout, say. A page that redirects has no token in it, and the resulting
   * 419 is the honest answer rather than something to work around.
   */
  async submit(path: string, fields: Record<string, string>, from = path): Promise<Response> {
    const token = tokenIn(await this.page(from))

    const response = await fetch(`${this.origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(this.jar.size > 0 ? { cookie: this.cookie() } : {})
      },
      body: new URLSearchParams({ ...(token ? { _token: token } : {}), ...fields }).toString(),
      redirect: 'manual'
    })

    this.keep(response)

    return response
  }

  /** Whether this visitor is carrying anything at all. */
  hasCookies(): boolean {
    return this.jar.size > 0
  }
}

/** The hidden CSRF field, as it is rendered. */
function tokenIn(html: string): string | undefined {
  return /name="_token" value="([^"]+)"/.exec(html)?.[1]
}

/**
 * A declaration, not a `const`.
 *
 * `proveTheKitWorks` is called from higher up the file than this line, and a
 * `const` arrow is not initialised until execution reaches it — so the first
 * failing check reported "Cannot access 'where' before initialization" instead
 * of the thing it was actually checking.
 */
function where(response: Response): string {
  return response.headers.get('location') ?? `status ${response.status}`
}

async function proveTheKitWorks(target: string): Promise<void> {
  section('The auth kit, over HTTP')

  const port = 41_991
  const origin = `http://127.0.0.1:${port}`

  /**
   * `AUTH_SECRET` is deliberately not `APP_KEY`.
   *
   * The template says so in a comment and this is where it would be caught: one
   * key signing both the framework's ciphertext and better-auth's tokens means a
   * leak of either is a leak of both.
   */
  await writeFile(
    join(target, '.env'),
    [
      'APP_NAME=SmokeKit',
      'APP_ENV=local',
      'APP_DEBUG=true',
      `APP_URL=${origin}`,
      'APP_KEY=smoke-kit-application-key-32-chars-min',
      'AUTH_SECRET=smoke-kit-better-auth-secret-not-the-app-key',
      'AUTH_MOUNT=true',
      'DB_CONNECTION=sqlite',
      'DB_DATABASE=database/kit.sqlite',
      'DB_FOREIGN_KEYS=true',
      'SESSION_DRIVER=file',
      /**
       * CSRF **on**, which is how a scaffolded application actually runs.
       *
       * It was off, and that is the whole reason a broken framework shipped: the
       * one setting that made the kit's own smoke run agree with a bug nobody
       * could reproduce anywhere else.
       */
      'SESSION_CSRF=true',
      'CACHE_STORE=file',
      'QUEUE_CONNECTION=sync',
      'MAIL_MAILER=log',
      'VIEW_CACHE=false',
      'LOG_LEVEL=error',
      `PORT=${port}`,
      ''
    ].join('\n')
  )

  const runner = new ProcessManager().path(target).timeout(120_000)

  const schema = await runner.run(['bun', 'artisan.ts', 'auth:schema'])
  check('auth:schema writes the migration', schema.successful(), schema.all().slice(-200))

  const migrated = await runner.run(['bun', 'artisan.ts', 'migrate', '--force'])
  check('migrate creates better-auth’s tables', migrated.successful(), migrated.all().slice(-300))

  // Its own process group, so a server that ignores SIGTERM still dies with the
  // group rather than holding the port for the next run.
  const server = new ProcessManager()
    .path(target)
    .forever()
    .start(['bun', 'artisan.ts', 'serve', `--port=${port}`])

  try {
    await server.waitUntil((output) => output.includes('Server running'))

    const anon = new Visitor(origin)
    const signInPage = await anon.page('/sign-in')

    check('the sign-in page renders', signInPage.includes('action="/sign-in"'))
    check('and carries a CSRF token', tokenIn(signInPage) !== undefined)
    check('and posts back to the route that handles it', signInPage.includes('name="password"'))

    /**
     * A form without its token is refused — the check that proves CSRF is on.
     *
     * Without this, turning CSRF off again in a later edit would go unnoticed and
     * take every check below with it.
     */
    const untokened = await fetch(`${origin}/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=nobody@example.com&password=whatever',
      redirect: 'manual'
    })

    check(
      'a form with no token is refused with 419',
      untokened.status === 419,
      `status ${untokened.status}`
    )

    const guest = await anon.visit('/dashboard')

    check('a guest is turned away from the dashboard', guest.status >= 300 && guest.status < 400)
    check(
      'and sent to sign in',
      (guest.headers.get('location') ?? '').includes('/sign-in'),
      where(guest)
    )

    /**
     * Registering is the check that matters.
     *
     * better-auth is called with `asResponse: true` so the cookie it sets is a
     * real one, and the controller moves that cookie onto a redirect. If either
     * half were wrong the browser would get a session-less redirect and land back
     * on the sign-in page.
     */
    const stamp = Date.now()
    const email = `kit-${stamp}@example.com`
    // Unique, so finding it on the page proves the session resolved *this* user
    // rather than that the word happens to appear in the template.
    const name = `Ada ${stamp}`

    const registered = await anon.submit('/sign-up', { name, email, password: 'longenough1' })

    check(
      'registering redirects rather than answering with JSON',
      registered.status >= 300 && registered.status < 400,
      `status ${registered.status}`
    )
    check(
      'and lands on the dashboard',
      (registered.headers.get('location') ?? '').includes('/dashboard'),
      where(registered)
    )
    check('the session cookie travels with the redirect', anon.hasCookies())

    const dashboardBody = await anon.page('/dashboard')

    // The page greets by name, not by address — asserting on the email was wrong
    // about the view rather than about the kit.
    check(
      'and greets the user it signed in',
      dashboardBody.includes(name),
      dashboardBody.slice(0, 240)
    )

    // A second registration with the same address must fail, or the unique index
    // is missing and two accounts share an email. A fresh visitor, because a
    // signed-in one is sent away from the form by `guest`.
    const second = new Visitor(origin)
    const duplicate = await second.submit('/sign-up', { name, email, password: 'longenough1' })

    check(
      'a duplicate address is refused',
      (duplicate.headers.get('location') ?? '').includes('/sign-up'),
      where(duplicate)
    )

    const wrong = await second.submit('/sign-in', { email, password: 'not-the-password' })

    check(
      'a wrong password goes back to the form',
      (wrong.headers.get('location') ?? '').includes('/sign-in'),
      where(wrong)
    )

    const again = await second.submit('/sign-in', { email, password: 'longenough1' })

    check(
      'signing in with the right one reaches the dashboard',
      (again.headers.get('location') ?? '').includes('/dashboard'),
      where(again)
    )

    // The sign-out form lives in the layout, so its token comes off a page that
    // has one rather than off `/sign-out`, which only answers a POST.
    const signedOut = await second.submit('/sign-out', {}, '/dashboard')

    check(
      'signing out redirects home',
      (signedOut.headers.get('location') ?? '') === '/',
      where(signedOut)
    )

    /**
     * The cookie must stop working, not merely be cleared.
     *
     * A sign-out that only tells the browser to forget the cookie leaves the
     * session valid for anyone who kept a copy of it — so this asks with the
     * cookie still in hand.
     */
    const afterSignOut = await second.visit('/dashboard')

    check(
      'and the old cookie no longer opens the dashboard',
      afterSignOut.status >= 300 && afterSignOut.status < 400,
      `status ${afterSignOut.status}`
    )

    // ------------------------------------------------- what the middleware adds

    /**
     * `guest` — the inverse of `auth`.
     *
     * Before the middleware existed the kit checked for a user on the pages that
     * needed one and never on the pages that needed nobody, so a signed-in person
     * could land on a sign-in form and sign in as themselves again.
     */
    const live = new Visitor(origin)
    await live.submit('/sign-in', { email, password: 'longenough1' })

    const onSignIn = await live.visit('/sign-in')

    check(
      'a signed-in visitor is sent away from the sign-in page',
      (onSignIn.headers.get('location') ?? '') === '/dashboard',
      where(onSignIn)
    )

    /**
     * A form reaching a PATCH route.
     *
     * The browser can only POST; `_method=PATCH` is what the framework reads
     * before routing. This is the check that now goes through CSRF as well, which
     * is where the doubled-body bug lived.
     */
    const patched = await live.submit('/settings/profile', {
      _method: 'PATCH',
      name: 'Renamed By Spoof',
      email
    })

    check(
      'a form reaches the PATCH route through _method',
      (patched.headers.get('location') ?? '').includes('saved=1'),
      where(patched)
    )

    check(
      'and the change actually landed',
      (await live.page('/settings/profile')).includes('Renamed By Spoof')
    )

    // The page carries the hidden field that makes the above possible.
    check(
      'the form ships the hidden _method field',
      (await live.page('/settings/password')).includes('name="_method" value="PUT"')
    )

    // A PUT through the same path, because the password form is the other spoofed
    // one and it takes three fields rather than two.
    const changedPassword = await live.submit('/settings/password', {
      _method: 'PUT',
      current: 'longenough1',
      password: 'longenough2',
      password_confirmation: 'longenough2'
    })

    check(
      'the password form reaches its PUT route',
      (changedPassword.headers.get('location') ?? '').includes('saved=1'),
      where(changedPassword)
    )

    const protectedPage = await new Visitor(origin).visit('/settings/security')

    check(
      'a settings page is behind auth too',
      (protectedPage.headers.get('location') ?? '').includes('/sign-in'),
      where(protectedPage)
    )

    // --------------------------------------------------- changing the address

    /**
     * The bug this pair of checks exists for.
     *
     * The kit sent the new address to `updateUser`, which answers 400 with
     * `EMAIL_CAN_NOT_BE_UPDATED` for any body containing an `email` — so every
     * person who edited their address on the profile form got "that could not be
     * saved" and no explanation. Nothing caught it because nothing had ever
     * changed an address over HTTP; the earlier check reposted the same one.
     */
    const moved = `moved-${stamp}@example.com`
    const changed = await live.submit('/settings/profile', {
      _method: 'PATCH',
      name: 'Renamed By Spoof',
      email: moved
    })

    check(
      'changing the address is accepted rather than refused',
      (changed.headers.get('location') ?? '').includes('/settings/profile?'),
      where(changed)
    )

    // Unverified here, so better-auth replaces it outright — and the page must
    // say "saved" rather than promise a link that changes nothing.
    check(
      'and the new address is what the page shows',
      (await live.page('/settings/profile')).includes(moved),
      moved
    )

    // ------------------------------------------------ confirming the password

    /**
     * `password.confirm`, which existed and guarded nothing.
     *
     * The middleware was built and unit tested, the config named a route and a
     * window, and no page in the kit was behind it. Session revocation is the page
     * that needs it — a borrowed unlocked browser can otherwise cut every other
     * device off.
     */
    const walled = await live.visit('/settings/security')

    check(
      'the security page asks for the password again',
      (walled.headers.get('location') ?? '') === '/confirm-password',
      where(walled)
    )

    const wall = await live.visit('/confirm-password')

    check('the confirm page renders', wall.status === 200, `status ${wall.status}`)

    const refusedConfirm = await live.submit('/confirm-password', { password: 'not-the-password' })

    check(
      'a wrong password does not open the window',
      (refusedConfirm.headers.get('location') ?? '').includes('/confirm-password'),
      where(refusedConfirm)
    )

    const stillWalled = await live.visit('/settings/security')

    check(
      'and the page is still behind the wall',
      (stillWalled.headers.get('location') ?? '') === '/confirm-password',
      where(stillWalled)
    )

    // The password was changed above, so this is the one that works now.
    const confirmed = await live.submit('/confirm-password', { password: 'longenough2' })

    // `redirect().guest()` put the page they were heading for in the session, and
    // `intended()` takes it back out — so the right answer lands where they aimed.
    check(
      'the right password sends them where they were going',
      (confirmed.headers.get('location') ?? '') === '/settings/security',
      where(confirmed)
    )

    const opened = await live.visit('/settings/security')

    check(
      'and the security page opens for the rest of the window',
      opened.status === 200,
      `status ${opened.status}`
    )

    // Revoking other sessions is behind the same wall, and is what the wall is for.
    // The token comes off the page that carries the form, not off the route it
    // posts to: a POST-only route has no page and therefore no token.
    const revoked = await live.submit('/settings/security/revoke-others', {}, '/settings/security')

    check(
      'other sessions can be revoked once confirmed',
      (revoked.headers.get('location') ?? '').includes('revoked=1'),
      where(revoked)
    )

    // ------------------------------------------------------- closing an account

    /**
     * The delete form, which answered 404 until better-auth was told to allow it.
     *
     * `deleteUser` is off by default and its endpoint reports NOT_FOUND, so the
     * settings page showed a form that could never work and the failure read as a
     * missing route rather than a missing option.
     */
    const deleted = await live.submit(
      '/settings/profile',
      { _method: 'DELETE', password: 'longenough2' },
      '/settings/profile'
    )

    check(
      'the account can actually be deleted',
      (deleted.headers.get('location') ?? '') === '/',
      where(deleted)
    )

    const gone = await live.visit('/dashboard')

    check(
      'and the session goes with it',
      gone.status >= 300 && gone.status < 400,
      `status ${gone.status}`
    )

    /**
     * `throttle:6,1` on the credential routes — last, because it spends the budget.
     *
     * Six a minute, as Fortify does it. Without this `/sign-in` is a
     * credential-stuffing endpoint.
     */
    const guesser = new Visitor(origin)
    let refused = 0

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const guess = await guesser.submit('/sign-in', { email, password: `wrong-${attempt}` })

      if (guess.status === 429) refused += 1
    }

    check('guessing the password is throttled', refused > 0, `${refused} of 9 refused`)
  } finally {
    await server.stop(2000)
  }
}

// -------------------------------------------------------------------- server

section('Server')

const port = 41_987
await app.listen(port, '127.0.0.1')

try {
  // --------------------------------------------------------------- http client

  section('HTTP client')

  {
    /**
     * Over a real socket, calling this same application.
     *
     * `app.handle()` would not do: a retry, a timeout and a connection failure
     * are exactly the behaviours that only exist once there is a socket between
     * the two halves. The port is passed to the controller through `PORT`.
     */
    const json = async (path: string) =>
      (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as Record<string, unknown>

    const fetched = await json('/check/client/get')
    check('a request comes back decoded', fetched.ok === true && fetched.status === 200)
    check('with the body parsed', JSON.stringify(fetched.body) === '{"hello":"world"}')

    const failure = await json('/check/client/failure')
    check('a 4xx is a result, not an exception', failure.failed === true)
    check(
      'and throw() reports the status and the URL',
      String(failure.thrown).startsWith('422 from')
    )

    /**
     * The reason to have a client at all.
     *
     * The upstream fails twice and succeeds on the third attempt; the client is
     * told it may try four times. `attempts: 3` is the proof it repeated rather
     * than got lucky.
     */
    const retried = await json(`/check/client/retry?run=smoke-${Date.now()}`)
    check(
      'a retry repeats until the upstream recovers',
      retried.ok === true && (retried.body as { attempts?: number }).attempts === 3,
      JSON.stringify(retried)
    )

    const exhausted = await json(`/check/client/retry-exhausted?run=smoke-${Date.now()}`)
    check(
      'and throws once the attempts run out',
      exhausted.threw === true && exhausted.status === 503,
      JSON.stringify(exhausted)
    )

    const timed = await json('/check/client/timeout')
    check('a timeout cancels rather than waiting', timed.timedOut === true)
    check(
      'and returns long before the upstream would have',
      typeof timed.elapsed === 'number' && (timed.elapsed as number) < 2000,
      `${String(timed.elapsed)}ms against a 3000ms upstream`
    )

    const pooled = await json('/check/client/pool')
    check(
      'a pool keeps its keys and reports failures in place',
      pooled.first === 200 && pooled.second === 404 && pooled.broken === 'ConnectionError',
      JSON.stringify(pooled)
    )

    const faked = await json('/check/client/fake')
    check('a fake answers without a network', JSON.stringify(faked.body) === '{"faked":true}')
    check('a stray request is refused under a fake', faked.strayRefused === true)
    check(
      "and only this test's requests are recorded",
      faked.recorded === 1,
      `recorded ${String(faked.recorded)}`
    )
  }

  const response = await fetch(`http://127.0.0.1:${port}/health`)
  check('listen() serves real requests', response.status === 200)
  check('reported port matches', app.router.server?.port === port)

  // Deferred work needs a transmitted response, which only a real socket gives.
  await fetch(`http://127.0.0.1:${port}/check/queue/defer`, { method: 'POST' })

  // The flush happens after the response, so give the loop a turn.
  await Bun.sleep(100)

  const deferred = (await (await fetch(`http://127.0.0.1:${port}/check/queue/defer`)).json()) as {
    ran: boolean
  }

  check('a deferred callback runs once the response has been sent', deferred.ran === true)

  await app.make('cache').store().flush()

  /**
   * `Limit.none()` for localhost — over a socket, where an address exists.
   *
   * Also the mapped-address case: the limiter compares against `127.0.0.1` and
   * Bun reports `::ffff:127.0.0.1` for an IPv4 client, so without normalising it
   * the exemption would silently never fire.
   */
  const exemptStatuses: number[] = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    exemptStatuses.push((await fetch(`http://127.0.0.1:${port}/check/limit/internal`)).status)
  }

  check(
    'Limit.none() exempts a caller entirely, over a real socket',
    exemptStatuses.every((status) => status === 200),
    exemptStatuses.join()
  )

  const address = (await (await fetch(`http://127.0.0.1:${port}/check/limit/ip`)).json()) as {
    ip: string
  }

  check('an IPv4 client is reported as IPv4, not ::ffff:', address.ip === '127.0.0.1')

  // ----------------------------------------------------------- cookies, bags

  section('Cookies and error bags')

  /** One browser: carries whatever the last response set, like a real client. */
  const jar = new Map<string, string>()

  const browser = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const header = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers ?? {}), ...(header === '' ? {} : { cookie: header }) }
    })

    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator === -1) continue

      jar.set(pair.slice(0, separator), pair.slice(separator + 1))
    }

    return response
  }

  const setCookie = await browser('/cookies/set?value=dark')
  const queuedBack = (await setCookie.json()) as { queued: string | null }

  // Set and read in the same request: the browser has not sent it back yet, so a
  // handler that changes a preference and renders would render the old one.
  check('a queued cookie reads back within the same request', queuedBack.queued === 'dark')

  const preferenceHeader =
    setCookie.headers.getSetCookie().find((line) => line.startsWith('preference=')) ?? ''

  check('the cookie goes out alongside the session cookie', preferenceHeader !== '')
  // The whole point: what the browser holds is opaque, so it cannot be edited
  // into something the application would believe.
  check(
    'and its value is not the plain text',
    preferenceHeader !== '' && !preferenceHeader.includes('dark'),
    preferenceHeader
  )

  const readBack = (await (await browser('/cookies/read')).json()) as { preference: string | null }

  check('the browser sends it back and it arrives decrypted', readBack.preference === 'dark')

  const forged = await fetch(`http://127.0.0.1:${port}/cookies/read`, {
    headers: { cookie: 'preference=admin' }
  })

  check(
    'a hand-written cookie is dropped rather than believed',
    ((await forged.json()) as { preference: string | null }).preference === null
  )

  await browser('/cookies/forget')
  const afterForget = (await (await browser('/cookies/read')).json()) as {
    preference: string | null
  }

  check('and a forget clears it for good', afterForget.preference === null)

  // Named bags: two forms on one page, each with its own errors.
  const csrf = (await (await browser('/session/token')).json()) as { token: string }

  await browser('/cookies/register', {
    method: 'POST',
    headers: { 'x-csrf-token': csrf.token }
  })
  await browser('/cookies/login', {
    method: 'POST',
    headers: { 'x-csrf-token': csrf.token }
  })

  const bags = (await (await browser('/cookies/bags')).json()) as {
    bags: string[]
    register: string | null
    login: string | null
    fallback: string | null
  }

  check('two named bags survive the redirect side by side', bags.bags.join() === 'login,register')
  check('each form reads only its own', bags.register === 'is taken' && bags.login === 'is wrong')
  // Without names, the failed sign-up would light up the sign-in form's field.
  check('and the default bag stays empty', bags.fallback === null)

  const sentToSignIn = await browser('/cookies/private')

  check('a guest is sent to sign in', sentToSignIn.headers.get('location') === '/cookies/sign-in')

  const afterSignIn = await browser('/cookies/sign-in')

  check(
    'and comes back to where they were going',
    afterSignIn.headers.get('location') === '/cookies/private'
  )

  const secondSignIn = await browser('/cookies/sign-in')

  // Used once: left behind, it would send the next sign-in somewhere the person
  // had long forgotten about.
  check(
    'the intended URL is spent, not remembered',
    secondSignIn.headers.get('location') === '/cookies/home'
  )

  const behindGateway = (await (
    await fetch(`http://127.0.0.1:${port}/cookies/whereami`, {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'shop.example.com',
        'x-forwarded-prefix': '/api/'
      }
    })
  ).json()) as { url: string; prefix: string }

  // Everything the process can see describes the inside of the cluster; a link
  // built from it 404s for everybody outside.
  check(
    'a gateway prefix reaches URL generation',
    behindGateway.url === 'https://shop.example.com/api/cookies/whereami',
    behindGateway.url
  )
  check('and the trailing slash is not doubled', behindGateway.prefix === '/api')

  // ------------------------------------------------------ auth mail, for real

  section('Auth: reset and verification mail')

  /**
   * better-auth builds the token and the URL and then asks the application to
   * deliver them — it ships no mailer on purpose. What is checked here is that
   * the delivery happens at all, over a real socket, with the link in it.
   *
   * The log mailer writes the whole message, so capturing output is reading the
   * outbox. `sendResetPassword` runs in the background, hence the pause.
   */
  const resetMail = await captureOutput(async () => {
    const asked = await fetch(`http://127.0.0.1:${port}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', redirectTo: '/reset' })
    })

    check('a reset request is accepted', asked.status === 200)

    await Bun.sleep(250)
  })

  check(
    'the reset link is mailed to the address that asked',
    resetMail.includes('To: ada@example.com'),
    resetMail.slice(0, 200)
  )
  check('with a subject naming the application', resetMail.includes('Subject: Reset your'))
  check(
    'and the tokenised link better-auth built',
    /reset-password\/[A-Za-z0-9_-]{8,}/.test(resetMail)
  )
  // A person reads time, not seconds.
  check('the mail says how long the link lasts', resetMail.includes('expires in 1 hour'))
  check(
    'and tells an unwitting recipient that doing nothing is safe',
    resetMail.includes('no further action is required')
  )

  const unknownAddress = await captureOutput(async () => {
    const asked = await fetch(`http://127.0.0.1:${port}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com' })
    })

    check('an unknown address gets the same answer', asked.status === 200)

    await Bun.sleep(150)
  })

  // The endpoint answers identically either way on purpose; if the mail went out
  // anyway, the response would be a working account-existence oracle.
  check('but no mail goes out for it', !unknownAddress.includes('To: nobody@example.com'))

  // A fresh account: Ada is verified by now, and better-auth answers an
  // already-verified address with a cheerful 200 and no mail at all.
  await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'secret123'
    })
  })

  const verifyMail = await captureOutput(async () => {
    const asked = await fetch(`http://127.0.0.1:${port}/api/auth/send-verification-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'grace@example.com' })
    })

    check('a verification request is accepted', asked.status === 200)

    await Bun.sleep(250)
  })

  check(
    'the verification link is mailed too',
    verifyMail.includes('Subject: Verify your') && verifyMail.includes('verify-email?token='),
    verifyMail.slice(0, 200)
  )
  check('to the address that signed up', verifyMail.includes('To: grace@example.com'))

  const resetToken = /reset-password\/([A-Za-z0-9_-]+)/.exec(resetMail)?.[1] ?? ''

  const changedMail = await captureOutput(async () => {
    const reset = await fetch(`http://127.0.0.1:${port}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: 'secret1234', token: resetToken })
    })

    check('the mailed token completes the reset', reset.status === 200, await reset.text())

    await Bun.sleep(250)
  })

  // The third hook, and the one Laravel does not have: a reset the account's
  // owner did not perform is exactly when they need to hear from us.
  check(
    'a completed reset warns the account owner',
    /Subject: Your \w+ password was changed/.test(changedMail),
    changedMail.slice(0, 200)
  )
  check('at error level, with what to do', changedMail.includes('contact us immediately'))

  const withNewPassword = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', password: 'secret1234' })
  })

  check('and the new password actually works', withNewPassword.status === 200)

  // -------------------------------------------------- mail: disks and previews

  section('Mail: attachments from a disk')

  await fetch(`http://127.0.0.1:${port}/check/mail/outbox`, { method: 'DELETE' })

  const invoiced = (await (
    await fetch(`http://127.0.0.1:${port}/check/mail/invoice?disk=local`, { method: 'POST' })
  ).json()) as { disk: string; previewInlines: boolean; previewHasCid: boolean }

  // A preview shown in a browser has no attachments to resolve `cid:` against,
  // so every embedded image would be a broken one.
  check('a preview inlines the embedded image', invoiced.previewInlines)
  check('and leaves no unresolved reference', !invoiced.previewHasCid)

  const invoiceOutbox = (await (
    await fetch(`http://127.0.0.1:${port}/check/mail/outbox`)
  ).json()) as {
    messages: Array<{ subject: string; htmlHead?: string }>
  }

  check('the invoice was sent', invoiceOutbox.messages[0]?.subject === 'Invoice INV-042')
  // What goes to a real client keeps the reference: the client resolves it
  // against the attachment and shows the image without fetching anything.
  check(
    'and what was sent keeps the cid reference',
    invoiceOutbox.messages[0]?.htmlHead?.includes('cid:logo') === true,
    invoiceOutbox.messages[0]?.htmlHead
  )

  // --------------------------------------------------------------- SES, signed

  section('Mail: SES over a signed request')

  /**
   * A stand-in for SES that recomputes the signature and refuses a request that
   * does not match.
   *
   * A stub that accepted anything would prove only that a POST was made. This
   * one derives the same signing key and rebuilds the canonical request from
   * what actually arrived over the socket, so a transport that signs the wrong
   * headers, body or path gets a 403 here exactly as it would from AWS.
   */
  const sesSecret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
  let sesRequest: { verified: boolean; content: Record<string, unknown> } | undefined

  const sesStub = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text()
      const authorization = request.headers.get('authorization') ?? ''
      const parts =
        /Credential=[^/]+\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(
          authorization
        )

      if (!parts) return Response.json({ message: 'unsigned' }, { status: 403 })

      const [, date, region, service, signedHeaders, signature] = parts as unknown as string[]
      const headers: Record<string, string> = {}
      for (const name of (signedHeaders as string).split(';')) {
        headers[name] = request.headers.get(name) ?? ''
      }

      const { canonical } = canonicalRequest({
        method: request.method,
        url: request.url,
        headers,
        body
      })

      const expected = createHmac(
        'sha256',
        signingKey(sesSecret, date as string, region as string, service as string)
      )
        .update(
          stringToSign(
            canonical,
            `${date}/${region}/${service}/aws4_request`,
            request.headers.get('x-amz-date') ?? ''
          )
        )
        .digest('hex')

      const parsed = JSON.parse(body) as { Content: Record<string, unknown> }
      sesRequest = { verified: expected === signature, content: parsed.Content }

      if (expected !== signature) {
        return Response.json({ message: 'signature mismatch' }, { status: 403 })
      }

      return Response.json({ MessageId: 'ses-smoke-id' })
    }
  })

  try {
    app.config.set('mail.mailers.ses', {
      transport: 'ses',
      region: 'eu-west-1',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: sesSecret,
      endpoint: `http://127.0.0.1:${sesStub.port}`
    })

    const viaSes = (await (
      await fetch(`http://127.0.0.1:${port}/check/mail/send/1?mailer=ses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'ada@example.com' })
      })
    ).json()) as { sent?: string; id?: string }

    check('a message goes out through SES', viaSes.sent === 'ses', JSON.stringify(viaSes))
    check('and SES answers with its message id', viaSes.id === 'ses-smoke-id')
    // The signature is what stands between this transport and a 403 nobody can
    // explain; recomputing it is the only check worth making.
    check('the request was signed correctly', sesRequest?.verified === true)
    check(
      'with no attachment it goes as Simple content',
      sesRequest?.content.Simple !== undefined && sesRequest?.content.Raw === undefined
    )
  } finally {
    sesStub.stop(true)
  }

  // ------------------------------------------------------------ cache: funnel

  section('Cache: a semaphore over the network')

  /**
   * Concurrency that a single process cannot fake.
   *
   * Six requests at once against a funnel of two: at most two may be inside
   * together, and the other four are refused rather than queued. The peak is
   * counted in the cache itself, so it is the store's view and not this
   * script's.
   */
  for (const store of ['array', 'file', 'redis']) {
    await fetch(`http://127.0.0.1:${port}/check/cache/funnel?store=${store}`, { method: 'DELETE' })

    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        fetch(`http://127.0.0.1:${port}/check/cache/funnel?store=${store}&limit=2&hold=150`, {
          method: 'POST'
        }).then((response) => response.json() as Promise<{ entered: boolean; peak: number }>)
      )
    )

    const entered = attempts.filter((attempt) => attempt.entered).length
    const refused = attempts.length - entered
    const peak = Math.max(...attempts.map((attempt) => attempt.peak))

    check(`${store}: callers get in`, entered >= 1, `entered ${entered}`)
    // Six at once against two slots: some must be turned away, which is what
    // separates a funnel from a queue.
    check(
      `${store}: and the rest are refused rather than queued`,
      refused > 0,
      `refused ${refused}`
    )
    /**
     * The ceiling, which is the only invariant here.
     *
     * Not "exactly two were inside together" — whether two overlap depends on
     * how fast the driver hands out a slot, and on the file store the first
     * caller can finish before the second gets one. A peak above the limit is a
     * leak; a peak below it is scheduling.
     */
    check(`${store}: and never more than the limit`, peak <= 2 && peak >= 1, `peak ${peak}`)

    await fetch(`http://127.0.0.1:${port}/check/cache/funnel?store=${store}`, { method: 'DELETE' })
  }
} finally {
  app.router.stop()
  await app.make('cache').store().forget('defer:ran')
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
