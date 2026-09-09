import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '@elvel/console'
import { Application } from '@elvel/core'
import { LensInstallCommand } from '../src/console/lens-install.ts'

let app: Application
let kernel: Kernel
let root: string

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-lens-install-'))
  await mkdir(join(root, 'config'), { recursive: true })

  app = new Application(root)
  kernel = new Kernel(app)
  kernel.register(LensInstallCommand)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function run(argv: string[]): Promise<{ status: number; output: string }> {
  const originalLog = console.log
  const originalError = console.error
  const lines: string[] = []
  const collect = (...args: unknown[]) => lines.push(args.map(String).join(' '))

  console.log = collect
  console.error = collect

  try {
    const status = await kernel.run(argv)

    return { status, output: lines.join('\n').replace(ANSI, '') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

/**
 * Lens publishes its own config, which is the whole reason it is absent from
 * `config:publish`. So the thing worth holding is that its own command actually
 * produces the file the catalogue would have.
 */
describe('lens:install', () => {
  test('writes the package default into the application', async () => {
    const { status, output } = await run(['lens:install'])

    expect(status).toBe(0)
    expect(output).toContain('Published config/lens.ts')

    const published = await Bun.file(join(root, 'config', 'lens.ts')).text()
    const shipped = await Bun.file(join(import.meta.dir, '..', 'config', 'lens.ts')).text()

    expect(published).toBe(shipped)
  })

  /**
   * A config file alone leaves the recorder inert — off by default and with no
   * tables — so the command has to say so rather than report success and stop.
   */
  test('prints the steps it deliberately does not take', async () => {
    const { output } = await run(['lens:install'])

    expect(output).toContain('lens:table')
    expect(output).toContain('migrate')
    expect(output).toContain('bootstrap/app.ts')
    expect(output).toContain('LENS_ENABLED')
  })

  test('refuses to overwrite without --force', async () => {
    await Bun.write(join(root, 'config', 'lens.ts'), '// mine\n')

    const { status, output } = await run(['lens:install'])

    expect(status).toBe(1)
    expect(output).toContain('already exists')
    expect(await Bun.file(join(root, 'config', 'lens.ts')).text()).toBe('// mine\n')
  })

  test('--force overwrites it', async () => {
    await Bun.write(join(root, 'config', 'lens.ts'), '// mine\n')

    const { status } = await run(['lens:install', '--force'])

    expect(status).toBe(0)
    expect(await Bun.file(join(root, 'config', 'lens.ts')).text()).not.toBe('// mine\n')
  })
})
