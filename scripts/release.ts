#!/usr/bin/env bun
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Pack every package for npm, and check each tarball before anybody publishes it.
 *
 * Written because the last release was wrong in a way nothing could have caught.
 * That release went out under the old name: `@elyvel/core@0.1.0-alpha.6` declared
 * `dayjs` and `@sinclair/typebox` and not `@elyvel/contracts`, which its own
 * source imported — and `@elyvel/contracts` was never published at all, so the
 * package could not resolve itself. Eleven of the twenty-six were missing from
 * npm entirely while fifteen depended on them.
 *
 * That scope is gone now: after a deletion request npm took ownership of the
 * `@elyvel` names — `npm owner ls @elyvel/core` answers `npm-support` — and the
 * organisation with it, which is why this is `@elvel`.
 *
 * None of that shows up here. A workspace resolves every `@elvel/*` through the
 * root regardless of what a manifest says, so the tests pass, the playground
 * runs, and the tarball is the first place the mistake exists. So this looks at
 * the tarball.
 *
 * Packing happens inside each package directory rather than in a staging copy,
 * because that is what makes `bun pm pack` rewrite `workspace:*` into the real
 * version. Away from the workspace it would leave the protocol in place and
 * publish a manifest no installer can read.
 *
 *     bun scripts/release.ts              pack and check, publish nothing
 *     bun scripts/release.ts --publish    the same, then npm publish each tarball
 *
 * Publishing needs npm credentials, which is why it is a flag and not the
 * default. Nothing is uploaded until every check below has passed.
 */

const ROOT = resolve(import.meta.dir, '..')
const OUT = join(ROOT, 'dist-release')

const publish = Bun.argv.includes('--publish')

/**
 * Publish built packages instead of source — off by default, because measured it
 * is slower.
 *
 * `scripts/build-packages.ts` collapses each package to one file, which ought to
 * cut the cost of Bun re-transpiling a thousand small modules on every boot.
 * Compared in real consumer installs with identical package sets, three runs
 * each, importing eight of them:
 *
 *     source, 26 packages from npm      231, 234, 249 ms
 *     built, dependencies external      319, 324, 334 ms
 *     built, dependencies inlined       327, 333, 334 ms
 *
 * So the flag stays and the default does not use it. The build itself works and
 * its output is correct — the declarations resolve, the bundles run — and it is
 * kept for the next attempt, which should start by explaining these numbers
 * rather than by trusting the earlier ones.
 */
const built = Bun.argv.includes('--built')

/**
 * A one-time password, when the account requires one to publish.
 *
 * npm refuses with `EOTP` on an account set to "auth and writes", and one code
 * has to cover all twenty-seven uploads — they run back to back inside its
 * validity window, so this is passed to each of them rather than asked for again.
 *
 * An automation token avoids the whole question and is what CI would use: npm
 * exempts those from 2FA, and then `NPM_CONFIG_TOKEN` is all this needs.
 */
const otp = Bun.argv.find((one) => one.startsWith('--otp='))?.slice('--otp='.length)
/**
 * `latest`, deliberately, even though every version so far is a prerelease.
 *
 * npm's `latest` tag is what a bare `bun add @elvel/core` installs, and it
 * currently points at `0.1.0-alpha.6` — the release whose manifest is missing its
 * own dependencies. Publishing under `--tag=alpha` would leave it pointing
 * there, so the broken version would stay the one everybody gets. Moving
 * `latest` forward is the whole point of this release.
 *
 * A second pointer can be added afterwards, which needs no republish:
 * `npm dist-tag add @elvel/core@1.0.0-alpha.1 alpha`.
 */
const tag = Bun.argv.find((one) => one.startsWith('--tag='))?.slice('--tag='.length) ?? 'latest'

type Manifest = {
  name: string
  version: string
  description: string
  files?: string[]
  dependencies?: Record<string, string>
}

/**
 * A README for the npm page, written at pack time rather than committed.
 *
 * Twenty-six near-identical files in the repository would be noise, and a
 * package page with nothing on it is worse than a short one. This is the middle:
 * the description, how to install it, and where the real documentation is.
 */
/**
 * Where each package's own documentation lives.
 *
 * Only the pages that exist: linking a package to a page that was never written
 * sends somebody to a 404 from the one place they were sure to look. Everything
 * else lands on the site's front page, which says plainly which packages are
 * documented and which are not.
 */
const PAGES: Record<string, string> = {
  'create-elvel': 'getting-started/installation',
  '@elvel/core': 'architecture/packages',
  '@elvel/http': 'basics/routing',
  '@elvel/view': 'basics/views',
  '@elvel/validation': 'basics/validation',
  '@elvel/events': 'basics/events-and-logging',
  '@elvel/log': 'basics/events-and-logging',
  '@elvel/database': 'database/getting-started',
  '@elvel/encryption': 'security/encryption',
  '@elvel/queue': 'digging-deeper/queues',
  '@elvel/cache': 'digging-deeper/cache',
  '@elvel/testing': 'testing/getting-started',
  '@elvel/console': 'digging-deeper/console',
  '@elvel/mail': 'digging-deeper/mail',
  '@elvel/storage': 'digging-deeper/storage',
  '@elvel/scheduler': 'digging-deeper/scheduling',
  '@elvel/notifications': 'digging-deeper/notifications',
  '@elvel/broadcasting': 'digging-deeper/broadcasting',
  '@elvel/concurrency': 'digging-deeper/concurrency',
  '@elvel/http-client': 'digging-deeper/http-client',
  '@elvel/image': 'digging-deeper/images',
  '@elvel/process': 'digging-deeper/processes',
  '@elvel/hashing': 'digging-deeper/hashing',
  '@elvel/translation': 'digging-deeper/localization',
  '@elvel/support': 'digging-deeper/collections',
  '@elvel/contracts': 'architecture/packages'
}

function readme(manifest: Manifest): string {
  const page = PAGES[manifest.name]
  const docs = page ? `https://ufhy.github.io/elvel/${page}` : 'https://ufhy.github.io/elvel/'

  return `# ${manifest.name}

${manifest.description}

Part of [Elvel](https://github.com/ufhy/elvel) — a Laravel-shaped framework for
Bun, built on Elysia. This package is published from the monorepo and versioned
in lockstep with the rest of it.

## Install

\`\`\`bash
bun add ${manifest.name}
\`\`\`

Most applications get it through the scaffolder instead, which installs only the
packages the chosen starter kit uses:

\`\`\`bash
bun create elvel my-app
\`\`\`

## Documentation

**${docs}**

${
  page
    ? 'The site is built from the same commit as this package, so it describes this\nversion rather than a later one.'
    : 'This package does not have its own page yet — the site says which do. Its\nbehaviour is covered by tests in the repository, and `BEHAVIOURS.md` there\nrecords the decisions the code cannot state on its own.'
}

## Licence

MIT
`
}

/** Everything a tarball has to be true about, checked after it is written. */
async function verify(tarball: string, manifest: Manifest): Promise<string[]> {
  const listing = Bun.spawnSync({ cmd: ['tar', '-tzf', tarball], stdout: 'pipe' })
  const entries = new TextDecoder().decode(listing.stdout).trim().split('\n')

  const problems: string[] = []

  for (const required of ['package/package.json', 'package/LICENSE', 'package/README.md']) {
    if (!entries.includes(required)) problems.push(`missing ${required}`)
  }

  const wants = manifest.name !== 'create-elvel' && built ? 'package/dist/' : 'package/src/'

  if (!entries.some((entry) => entry.startsWith(wants))) problems.push(`nothing under ${wants}`)

  // A built package shipping source as well would double its size and leave two
  // answers to the same import.
  if (wants === 'package/dist/' && entries.some((entry) => entry.startsWith('package/src/'))) {
    problems.push('ships src/ as well as dist/')
  }

  if (wants === 'package/dist/' && !entries.includes('package/dist/index.d.ts')) {
    problems.push('no dist/index.d.ts')
  }
  if (entries.some((entry) => entry.startsWith('package/test/'))) problems.push('ships test/')
  if (entries.some((entry) => entry.startsWith('package/node_modules/'))) {
    problems.push('ships node_modules/')
  }

  const packed = Bun.spawnSync({
    cmd: ['tar', '-xzOf', tarball, 'package/package.json'],
    stdout: 'pipe'
  })

  const inside = JSON.parse(new TextDecoder().decode(packed.stdout)) as Manifest

  if (inside.version !== manifest.version) {
    problems.push(`version is ${inside.version}, expected ${manifest.version}`)
  }

  /**
   * The one that would have made alpha.6 impossible.
   *
   * `workspace:*` means nothing outside this repository: `bun add` on a package
   * declaring it fails to resolve, and npm's own client reports it as an invalid
   * version range.
   */
  for (const [name, range] of Object.entries(inside.dependencies ?? {})) {
    if (range.startsWith('workspace:')) problems.push(`${name} still ${range}`)
  }

  return problems
}

const directories = (await readdir(join(ROOT, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

await rm(OUT, { recursive: true, force: true })

if (built) {
  const built = Bun.spawnSync({
    cmd: ['bun', join(ROOT, 'scripts', 'build-packages.ts')],
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit'
  })

  if (built.exitCode !== 0) {
    console.log('\nThe build failed, so nothing was packed.')

    process.exit(1)
  }

  console.log('')
}

const licence = await Bun.file(join(ROOT, 'LICENSE')).text()
const packed: Array<{ manifest: Manifest; tarball: string; size: number }> = []
const failures: string[] = []

for (const directory of directories) {
  const dir = join(ROOT, 'packages', directory)
  const manifest = (await Bun.file(join(dir, 'package.json')).json()) as Manifest

  // Written into the package for the duration of the pack, and removed after —
  // `bun pm pack` only takes what is beside the manifest, and neither file is
  // worth twenty-six copies in git.
  await writeFile(join(dir, 'LICENSE'), licence)
  await writeFile(join(dir, 'README.md'), readme(manifest))

  /**
   * The manifest is pointed at `dist/` for the length of the pack, and put back.
   *
   * `publishConfig.exports` would be the declared way to do this and `bun pm
   * pack` ignores it — the tarball comes out with `exports` still naming
   * `./src/index.ts` and `publishConfig` sitting unused in the manifest. So the
   * swap happens here, on disk, for as long as it takes to write one tarball.
   *
   * Development keeps running from source: nothing outside this loop ever sees
   * the rewritten manifest, and `create-elvel` has no `dist` to point at.
   */
  const manifestPath = join(dir, 'package.json')
  const original = await Bun.file(manifestPath).text()
  const rewire = directory !== 'create-elvel' && built

  if (rewire) {
    const pointed = JSON.parse(original) as Record<string, unknown>

    pointed.main = './dist/index.js'
    pointed.types = './dist/index.d.ts'
    pointed.exports = {
      ...(pointed.exports as Record<string, unknown>),
      '.': { types: './dist/index.d.ts', default: './dist/index.js' }
    }
    pointed.files = ['dist', ...(pointed.files as string[]).filter((one) => one !== 'src')]

    await writeFile(manifestPath, `${JSON.stringify(pointed, null, 2)}\n`)
  }

  try {
    const run = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--destination', OUT],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    if (run.exitCode !== 0) {
      failures.push(
        `${manifest.name}: pack failed — ${new TextDecoder().decode(run.stderr).trim()}`
      )
      continue
    }

    const slug = manifest.name.replace('@', '').replace('/', '-')
    const tarball = join(OUT, `${slug}-${manifest.version}.tgz`)

    if (!(await Bun.file(tarball).exists())) {
      failures.push(`${manifest.name}: expected ${tarball}`)
      continue
    }

    const problems = await verify(tarball, manifest)

    if (problems.length > 0) {
      failures.push(`${manifest.name}: ${problems.join('; ')}`)
      continue
    }

    packed.push({ manifest, tarball, size: Bun.file(tarball).size })
  } finally {
    await rm(join(dir, 'LICENSE'), { force: true })
    await rm(join(dir, 'README.md'), { force: true })

    if (rewire) await writeFile(manifestPath, original)
  }
}

for (const { manifest, size } of packed) {
  console.log(`  ${manifest.name.padEnd(24)} ${(size / 1024).toFixed(1).padStart(7)} KB`)
}

console.log(`\n${packed.length} of ${directories.length} packed into dist-release/`)

if (failures.length > 0) {
  console.log('\nRefusing to go further:')
  for (const failure of failures) console.log(`  ${failure}`)

  process.exit(1)
}

const versions = new Set(packed.map((one) => one.manifest.version))

if (versions.size !== 1) {
  console.log(`\nRefusing to publish ${versions.size} different versions: ${[...versions]}`)

  process.exit(1)
}

if (!publish) {
  console.log(`\nNothing was published. To publish all of it as \`${tag}\`:`)
  console.log(`  bun scripts/release.ts --publish --tag=${tag}`)
  console.log('\nOr one at a time, which is what --publish does in this order:')
  for (const { tarball } of packed.slice(0, 3)) {
    console.log(`  npm publish ${tarball.replace(`${ROOT}/`, '')} --access public --tag ${tag}`)
  }
  console.log(`  … and ${packed.length - 3} more`)

  process.exit(0)
}

/**
 * Ordered so a dependency is on npm before anything that needs it.
 *
 * Not strictly required — npm accepts a manifest naming a version that does not
 * exist yet — but an install attempted between the first publish and the last
 * would fail, and a publish that dies halfway leaves the registry in exactly
 * that state. Contracts and support first, then the rest alphabetically.
 */
const first = ['@elvel/contracts', '@elvel/support', '@elvel/core']
const order = [
  ...first.map((name) => packed.find((one) => one.manifest.name === name)),
  ...packed.filter((one) => !first.includes(one.manifest.name))
].filter(Boolean) as typeof packed

/**
 * The path npm will actually be able to open.
 *
 * `npm` on a developer machine may be the Windows binary reached through WSL
 * interop, and it reads a POSIX path as a Windows one: `/mnt/e/…/x.tgz` became
 * `E:\mnt\e\…\x.tgz` and the publish died with ENOENT before uploading
 * anything. `wslpath -w` gives the form that binary understands.
 *
 * Everywhere else there is no `wslpath` and the path is already right — but
 * asking for it has to be wrapped, not merely checked for a non-zero exit.
 * `Bun.spawnSync` *throws* when the executable is missing, which took a release
 * down on a Linux runner at the first tarball, after every check had passed.
 */
function forNpm(path: string): string {
  try {
    const converted = Bun.spawnSync({
      cmd: ['wslpath', '-w', path],
      stdout: 'pipe',
      stderr: 'pipe'
    })

    if (converted.exitCode !== 0) return path

    return new TextDecoder().decode(converted.stdout).trim() || path
  } catch {
    return path
  }
}

/**
 * Is this exact version already on npm?
 *
 * Asked before every upload so a run can be repeated. One OTP covers a handful
 * of publishes and then expires, which used to mean a half-finished release and
 * a second attempt that died on `EPUBLISHCONFLICT` at the first package that had
 * made it — the very packages that succeeded were what blocked the retry. Now a
 * repeat run picks up exactly where the last one stopped.
 */
async function alreadyPublished(name: string, version: string): Promise<boolean> {
  const encoded = encodeURIComponent(name)

  const answer = await fetch(`https://registry.npmjs.org/${encoded}/${version}`, {
    headers: { accept: 'application/json' }
  }).catch(() => undefined)

  return answer?.ok === true
}

let skipped = 0

for (const { manifest, tarball } of order) {
  if (await alreadyPublished(manifest.name, manifest.version)) {
    console.log(`already published ${manifest.name}@${manifest.version}`)
    skipped += 1

    continue
  }

  const run = Bun.spawnSync({
    cmd: [
      'npm',
      'publish',
      forNpm(tarball),
      '--access',
      'public',
      '--tag',
      tag,
      ...(otp ? [`--otp=${otp}`] : [])
    ],
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit'
  })

  if (run.exitCode !== 0) {
    console.log(`\n${manifest.name} failed to publish. Stopping — the rest are still local.`)

    process.exit(1)
  }

  console.log(`published ${manifest.name}@${manifest.version}`)
}

console.log(
  skipped > 0
    ? `\n${order.length - skipped} published as \`${tag}\`, ${skipped} were already there.`
    : `\nAll ${order.length} published as \`${tag}\`.`
)
