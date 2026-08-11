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
