import { describe, expect, test } from 'bun:test'
import {
  formatUsage,
  InputParseError,
  missingArguments,
  parseInput,
  parseSignature
} from '../src/signature.ts'

describe('parseSignature', () => {
  test('extracts the command name', () => {
    expect(parseSignature('make:controller {name}').name).toBe('make:controller')
    expect(parseSignature('serve').name).toBe('serve')
  })

  test('parses argument modifiers', () => {
    const definition = parseSignature(
      'thing {required} {optional?} {withDefault=fallback} {many*} {described : What it is}'
    )

    expect(definition.arguments).toEqual([
      { name: 'required', required: true, isArray: false, default: undefined, description: '' },
      { name: 'optional', required: false, isArray: false, default: undefined, description: '' },
      {
        name: 'withDefault',
        required: false,
        isArray: false,
        default: 'fallback',
        description: ''
      },
      { name: 'many', required: true, isArray: true, default: undefined, description: '' },
      {
        name: 'described',
        required: true,
        isArray: false,
        default: undefined,
        description: 'What it is'
      }
    ])
  })

  test('parses option modifiers', () => {
    const definition = parseSignature(
      'thing {--force} {--path=} {--driver=redis} {--r|resource : Resource routes} {--tag*}'
    )

    expect(
      definition.options.map((option) => [option.name, option.acceptsValue, option.default])
    ).toEqual([
      ['force', false, false],
      ['path', true, undefined],
      ['driver', true, 'redis'],
      ['resource', false, false],
      ['tag', true, undefined]
    ])

    expect(definition.options[3]?.shortcut).toBe('r')
    expect(definition.options[3]?.description).toBe('Resource routes')
  })
})

describe('parseInput', () => {
  const definition = parseSignature(
    'make:controller {name} {extra?} {--f|force} {--path=app} {--tag*}'
  )

  test('binds positional arguments', () => {
    const input = parseInput(['Post'], definition)

    expect(input.arguments.name).toBe('Post')
    expect(input.arguments.extra).toBeUndefined()
  })

  test('boolean flags, long and short', () => {
    expect(parseInput(['Post', '--force'], definition).options.force).toBe(true)
    expect(parseInput(['Post', '-f'], definition).options.force).toBe(true)
    expect(parseInput(['Post'], definition).options.force).toBe(false)
  })

  test('value options, inline and separated', () => {
    expect(parseInput(['Post', '--path=src'], definition).options.path).toBe('src')
    expect(parseInput(['Post', '--path', 'src'], definition).options.path).toBe('src')
    expect(parseInput(['Post'], definition).options.path).toBe('app')
  })

  test('repeatable options collect', () => {
    expect(parseInput(['Post', '--tag', 'a', '--tag=b'], definition).options.tag).toEqual([
      'a',
      'b'
    ])
  })

  test('a value option does not swallow the next flag', () => {
    expect(() => parseInput(['Post', '--path', '--force'], definition)).toThrow(InputParseError)
  })

  test('everything after -- is positional', () => {
    const input = parseInput(['Post', '--', '--force'], definition)

    expect(input.arguments.extra).toBe('--force')
    expect(input.options.force).toBe(false)
  })

  test('missing required argument fails', () => {
    expect(() => parseInput([], definition)).toThrow(/missing: "name"/)
  })

  test('unknown option fails', () => {
    expect(() => parseInput(['Post', '--nope'], definition)).toThrow(/does not exist/)
  })

  test('array arguments take the remaining positionals', () => {
    const actions = parseSignature('make:controller {name} {actions*}')
    const input = parseInput(['Post', 'index', 'show'], actions)

    expect(input.arguments.actions).toEqual(['index', 'show'])
  })
})

describe('formatUsage', () => {
  test('renders required, optional and variadic parts', () => {
    const definition = parseSignature('make:controller {name} {extra?} {rest*} {--force}')

    expect(formatUsage(definition)).toBe('make:controller <name> [extra] <rest...> [options]')
  })
})

describe('what an invocation left out', () => {
  const definition = parseSignature(
    'make:model {name : The model name} {extra?} {--force} {--table= : Table name}'
  )

  test('a required argument that was not given is reported', () => {
    expect<string[]>(missingArguments(definition, []).map((argument) => argument.name)).toEqual([
      'name'
    ])
  })

  test('nothing is missing once it is there', () => {
    expect<number>(missingArguments(definition, ['Widget']).length).toBe(0)
  })

  test('an option and its value are not mistaken for the argument', () => {
    // `--table widgets` looks like two positional tokens to a naive scan, and
    // the second would then be read as the name.
    expect<string[]>(
      missingArguments(definition, ['--table', 'widgets']).map((argument) => argument.name)
    ).toEqual(['name'])

    expect<number>(missingArguments(definition, ['--table', 'widgets', 'Widget']).length).toBe(0)
  })

  test('a flag with no value does not consume the next token', () => {
    expect<number>(missingArguments(definition, ['--force', 'Widget']).length).toBe(0)
  })

  test('an optional argument is never asked about', () => {
    expect<number>(missingArguments(definition, ['Widget']).length).toBe(0)
  })
})

/**
 * `{--id=*}` is Laravel's spelling for a repeatable option, and it was being read
 * as a default value of `"*"`.
 *
 * One command used it, and it was broken outright: `model:prune` filtered its
 * models against `only = ['*']`, matched none, and reported
 * `No model defines prunable()` against an application whose model defined one.
 * `{--tag*}` — the star before the equals — worked, and is kept.
 */
describe('a repeatable option', () => {
  const definition = parseSignature('mail:send {--id=* : Ids} {--tag* : Tags} {--path=x : A path}')

  test('=* means an array, not a default of "*"', () => {
    const id = definition.options.find((option) => option.name === 'id')

    expect(id?.isArray).toBe(true)
    expect(id?.default).toBeUndefined()
    expect(id?.acceptsValue).toBe(true)
  })

  test('the older spelling still works, and a real default is untouched', () => {
    expect(definition.options.find((option) => option.name === 'tag')?.isArray).toBe(true)
    expect(definition.options.find((option) => option.name === 'path')?.default).toBe('x')
  })

  test('absent is an empty array; repeated collects', () => {
    expect(parseInput([], definition).options.id).toEqual([])
    expect(parseInput(['--id=1', '--id=2'], definition).options.id).toEqual(['1', '2'])
  })
})
