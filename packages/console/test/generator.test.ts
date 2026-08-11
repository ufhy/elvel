import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '@elysian/core'
import type { Command } from '../src/command.ts'
import { MakeCommandCommand } from '../src/commands/make-command.ts'
import { MakeComponentCommand } from '../src/commands/make-component.ts'
import { MakeControllerCommand } from '../src/commands/make-controller.ts'
import { MakeProviderCommand } from '../src/commands/make-provider.ts'
import { MakeViewCommand } from '../src/commands/make-view.ts'

let app: Application
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elysian-generator-'))
  app = new Application(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Run a generator, swallowing its terminal output, and return its exit code. */
async function run(command: Command, argv: string[]): Promise<{ status: number; output: string }> {
  const originalLog = console.log
  const originalError = console.error
  const lines: string[] = []
  const collect = (...args: unknown[]) => lines.push(args.map(String).join(' '))

  console.log = collect
  console.error = collect

  try {
    const status = await command.bind(app, argv, async () => 0).handle()
    return { status: typeof status === 'number' ? status : 0, output: lines.join('\n') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

function read(...segments: string[]): Promise<string> {
  return Bun.file(join(root, ...segments)).text()
}

function exists(...segments: string[]): Promise<boolean> {
  return Bun.file(join(root, ...segments)).exists()
}

describe('make:view', () => {
  test('dots become directories and the last segment names the component', async () => {
    const { status } = await run(new MakeViewCommand(), ['pages.about'])
    const source = await read('resources/views/pages/about.tsx')

    expect(status).toBe(0)
    expect(source).toContain('export function About(')
    expect(source).toContain('export type AboutProps')
  })

  test('slashes work too', async () => {
    await run(new MakeViewCommand(), ['pages/contact'])

    expect(await exists('resources/views/pages/contact.tsx')).toBe(true)
  })

  test('a trailing .tsx is not doubled', async () => {
    await run(new MakeViewCommand(), ['pages/faq.tsx'])

    expect(await exists('resources/views/pages/faq.tsx')).toBe(true)
    expect(await exists('resources/views/pages/faq.tsx.tsx')).toBe(false)
  })

  test('the layout import hops out to resources/views/components', async () => {
    await run(new MakeViewCommand(), ['top'])
    await run(new MakeViewCommand(), ['pages.about'])
    await run(new MakeViewCommand(), ['pages.admin.stats'])

    expect(await read('resources/views/top.tsx')).toContain("from './components/layout.tsx'")
    expect(await read('resources/views/pages/about.tsx')).toContain(
      "from '../components/layout.tsx'"
    )
    expect(await read('resources/views/pages/admin/stats.tsx')).toContain(
      "from '../../components/layout.tsx'"
    )
  })

  test('an existing file is refused, and --force overwrites it', async () => {
    await run(new MakeViewCommand(), ['pages.about'])
    await Bun.write(join(root, 'resources/views/pages/about.tsx'), 'edited by hand')

    const refused = await run(new MakeViewCommand(), ['pages.about'])
    expect(refused.status).toBe(1)
    expect(refused.output).toContain('already exists')
    expect(await read('resources/views/pages/about.tsx')).toBe('edited by hand')

    const forced = await run(new MakeViewCommand(), ['pages.about', '--force'])
    expect(forced.status).toBe(0)
    expect(await read('resources/views/pages/about.tsx')).toContain('export function About(')
  })

  test('a missing name fails at binding time, before touching the disk', () => {
    expect(() => new MakeViewCommand().bind(app, [], async () => 0)).toThrow(/missing: "name"/)
  })
})

describe('make:component', () => {
  test('lands under resources/views/components', async () => {
    await run(new MakeComponentCommand(), ['Alert'])

    expect(await read('resources/views/components/Alert.tsx')).toContain('export function Alert(')
  })

  test('keeps nesting and studly-cases the class', async () => {
    await run(new MakeComponentCommand(), ['forms/text_input'])
    const source = await read('resources/views/components/forms/TextInput.tsx')

    expect(source).toContain('export function TextInput(')
    expect(source).toContain('class="text-input"')
  })
})

describe('make:controller', () => {
  test('suffixes the class name without doubling it', async () => {
    await run(new MakeControllerCommand(), ['Post'])
    await run(new MakeControllerCommand(), ['ReportController'])

    expect(await exists('app/Http/Controllers/PostController.ts')).toBe(true)
    expect(await exists('app/Http/Controllers/ReportController.ts')).toBe(true)
    expect(await exists('app/Http/Controllers/ReportControllerController.ts')).toBe(false)
  })

  test('nested names create subdirectories', async () => {
    await run(new MakeControllerCommand(), ['admin/Report'])

    expect(await exists('app/Http/Controllers/admin/ReportController.ts')).toBe(true)
  })

  test('the plain stub names the instance from the base name', async () => {
    await run(new MakeControllerCommand(), ['BlogPost'])
    const source = await read('app/Http/Controllers/BlogPostController.ts')

    expect(source).toContain("controller('blog-post')")
    expect(source).toContain("'/blog-posts'")
  })

  test('--resource selects the resource stub and pluralises the prefix', async () => {
    await run(new MakeControllerCommand(), ['Category', '--resource'])
    const source = await read('app/Http/Controllers/CategoryController.ts')

    expect(source).toContain("controller('category', '/categories')")
    expect(source).toContain('.post(')
    expect(source).toContain('.delete(')
  })

  test('-r is the same as --resource', async () => {
    await run(new MakeControllerCommand(), ['Tag', '-r'])

    expect(await read('app/Http/Controllers/TagController.ts')).toContain("'/tags'")
  })
})

describe('make:provider', () => {
  test('suffixes ServiceProvider once', async () => {
    await run(new MakeProviderCommand(), ['Route'])
    await run(new MakeProviderCommand(), ['EventServiceProvider'])

    expect(await read('app/Providers/RouteServiceProvider.ts')).toContain(
      'class RouteServiceProvider'
    )
    expect(await exists('app/Providers/EventServiceProvider.ts')).toBe(true)
    expect(await exists('app/Providers/EventServiceProviderServiceProvider.ts')).toBe(false)
  })
})

describe('make:command', () => {
  test('derives a colon-separated signature from the class name', async () => {
    await run(new MakeCommandCommand(), ['SendReports'])
    const source = await read('app/Console/Commands/SendReports.ts')

    expect(source).toContain('class SendReports extends Command')
    expect(source).toContain("signature = 'send:reports")
  })

  test('a single-word name still produces a usable signature', async () => {
    await run(new MakeCommandCommand(), ['Ping'])

    expect(await read('app/Console/Commands/Ping.ts')).toContain("signature = 'ping")
  })
})

describe('stub resolution', () => {
  test('a published stub in the project overrides the shipped one', async () => {
    await Bun.write(join(root, 'stubs', 'view.stub'), 'CUSTOM {{ class }} STUB')
    await run(new MakeViewCommand(), ['pages.about'])

    expect(await read('resources/views/pages/about.tsx')).toBe('CUSTOM About STUB')
  })

  test('unknown placeholders in a stub are left untouched', async () => {
    await Bun.write(join(root, 'stubs', 'view.stub'), '{{ class }} / {{ nothingKnowsThis }}')
    await run(new MakeViewCommand(), ['pages.about'])

    expect(await read('resources/views/pages/about.tsx')).toBe('About / {{ nothingKnowsThis }}')
  })
})
