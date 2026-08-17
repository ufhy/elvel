import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Application } from '@elvel/core'
import { Command } from '../src/command.ts'
import { Kernel } from '../src/kernel.ts'

let app: Application
let kernel: Kernel
let root: string

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-kernel-'))
  app = new Application(root)
  kernel = new Kernel(app)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Run the kernel, capturing terminal output with colours stripped. */
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

class Greet extends Command {
  static override signature =
    'app:greet {name=world : Who to greet} {--loud : Shout} {--repeat=1 : Times}'
  static override description = 'Greet somebody'

  handle(): number {
    const message = `hello ${this.argument('name')}`
    const times = Number(this.stringOption('repeat', '1'))

    for (let index = 0; index < times; index += 1) {
      this.line(this.flag('loud') ? message.toUpperCase() : message)
    }

    return 0
  }
}

class Fails extends Command {
  static override signature = 'app:fail'
  static override description = 'Always throws'

  handle(): number {
    throw new Error('deliberate failure')
  }
}

class Nested extends Command {
  static override signature = 'app:nested'
  static override description = 'Calls another command'

  async handle(): Promise<number> {
    return this.call('app:greet', ['from-nested'])
  }
}

describe('registration', () => {
  test('registers by the name parsed from the signature', () => {
    kernel.register(Greet)

    expect(kernel.all()).toHaveLength(1)
    expect(kernel.all()[0]).toBe(Greet)
  })

  test('registering the same name twice replaces rather than duplicates', () => {
    kernel.register(Greet, Greet)

    expect(kernel.all()).toHaveLength(1)
  })

  test('an empty signature is rejected loudly', () => {
    class Anonymous extends Command {
      static override signature = ''
      static override description = ''
      handle(): number {
        return 0
      }
    }

    expect(() => kernel.register(Anonymous)).toThrow(/empty signature/)
  })
})

describe('dispatch', () => {
  beforeEach(() => {
    kernel.register(Greet, Fails, Nested)
  })

  test('binds arguments and options', async () => {
    const { status, output } = await run(['app:greet', 'elvel', '--repeat', '2'])

    expect(status).toBe(0)
    expect(output.split('hello elvel').length - 1).toBe(2)
  })

  test('applies argument defaults', async () => {
    expect((await run(['app:greet'])).output).toContain('hello world')
  })

  test('boolean flags bind', async () => {
    expect((await run(['app:greet', 'x', '--loud'])).output).toContain('HELLO X')
  })

  test('an unknown command exits 1 and says so', async () => {
    const { status, output } = await run(['app:nope'])

    expect(status).toBe(1)
    expect(output).toContain('is not defined')
  })

  test('a bad option prints the reason and the help', async () => {
    const { status, output } = await run(['app:greet', '--unknown'])

    expect(status).toBe(1)
    expect(output).toContain('does not exist')
    expect(output).toContain('Usage:')
  })

  test('a throwing command reports the message and exits 1', async () => {
    const { status, output } = await run(['app:fail'])

    expect(status).toBe(1)
    expect(output).toContain('deliberate failure')
  })

  test('a stack trace only appears with debug enabled', async () => {
    expect((await run(['app:fail'])).output).not.toContain('at ')

    app.config.set('app.debug', true)
    expect((await run(['app:fail'])).output).toContain('at ')
  })

  test('commands can call other commands', async () => {
    const { status, output } = await run(['app:nested'])

    expect(status).toBe(0)
    expect(output).toContain('hello from-nested')
  })
})

describe('help output', () => {
  beforeEach(() => {
    kernel.register(Greet)
  })

  test('no arguments lists commands grouped by prefix', async () => {
    const { status, output } = await run([])

    expect(status).toBe(0)
    expect(output).toContain('Usage:')
    expect(output).toContain('app')
    expect(output).toContain('app:greet')
    expect(output).toContain('Greet somebody')
  })

  test('list, --help and -h all show the list', async () => {
    for (const argv of [['list'], ['--help'], ['-h']]) {
      expect((await run(argv)).output).toContain('app:greet')
    }
  })

  test('--help on a command documents arguments, defaults and options', async () => {
    const { output } = await run(['app:greet', '--help'])

    expect(output).toContain('Greet somebody')
    expect(output).toContain('app:greet [name] [options]')
    expect(output).toContain('Who to greet')
    expect(output).toContain('[default: world]')
    expect(output).toContain('--loud')
    expect(output).toContain('--repeat=VALUE')
  })

  test('--version reads the configured version', async () => {
    app.config.set('app.version', '9.9.9')

    expect((await run(['--version'])).output).toContain('9.9.9')
  })

  test('a near miss suggests candidates', async () => {
    const { output } = await run(['app:gree'])

    expect(output).toContain('Did you mean')
    expect(output).toContain('app:greet')
  })
})

describe('discovery', () => {
  test('loads command classes from a directory', async () => {
    await Bun.write(
      join(root, 'app/Console/Commands/Probe.ts'),
      // A `file://` URL, because a Windows path written into a quoted string
      // turns `\s` and `\c` into escape sequences and loses every separator.
      `import { Command } from '${pathToFileURL(join(import.meta.dir, '..', 'src', 'command.ts')).href}'
       export class Probe extends Command {
         static override signature = 'probe:me'
         static override description = 'Discovered'
         handle() { return 0 }
       }
       export const NOT_A_COMMAND = { signature: 'nope' }
      `
    )

    await kernel.loadFrom(join(root, 'app/Console/Commands'))

    expect(kernel.all().map((command) => command.signature)).toEqual(['probe:me'])
  })

  test('a missing directory is not an error', async () => {
    await kernel.loadFrom(join(root, 'does/not/exist'))

    expect(kernel.all()).toHaveLength(0)
  })

  test('ignores non-module files', async () => {
    await Bun.write(join(root, 'app/Console/Commands/notes.md'), '# not a command')
    await kernel.loadFrom(join(root, 'app/Console/Commands'))

    expect(kernel.all()).toHaveLength(0)
  })
})
