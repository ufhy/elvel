import { describe, expect, test } from 'bun:test'
import { formatUsage, InputParseError, parseInput, parseSignature } from '../src/signature.ts'

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
