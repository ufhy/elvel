/**
 * Signature parser — Artisan's declarative command definition.
 *
 *   'make:controller {name} {--force} {--resource : Include CRUD routes}'
 *
 * Arguments:  {name}  {name?}  {name=default}  {name*}  {name : description}
 * Options:    {--force}  {--path=}  {--path=default}  {--P|path=}  {--tag*}
 */

export type ArgumentDefinition = {
  name: string
  required: boolean
  isArray: boolean
  default?: string
  description: string
}

export type OptionDefinition = {
  name: string
  shortcut?: string
  acceptsValue: boolean
  isArray: boolean
  default?: string | boolean
  description: string
}

export type CommandDefinition = {
  name: string
  arguments: ArgumentDefinition[]
  options: OptionDefinition[]
}

export type ParsedInput = {
  arguments: Record<string, string | string[] | undefined>
  options: Record<string, string | string[] | boolean | undefined>
}

// `[^{}]*` rather than `\s*(.*?)\s*`: a token holds no braces, and spelling that
// out leaves the engine nothing to backtrack over. The trim moved into the code.
const TOKEN_PATTERN = /\{([^{}]*)\}/g

export function parseSignature(signature: string): CommandDefinition {
  const name = signature.replace(TOKEN_PATTERN, '').trim().split(/\s+/)[0] ?? ''

  const definition: CommandDefinition = { name, arguments: [], options: [] }

  for (const match of signature.matchAll(TOKEN_PATTERN)) {
    const token = (match[1] ?? '').trim()
    if (token === '') continue

    const [body, ...descriptionParts] = token.split(' : ')
    const description = descriptionParts.join(' : ').trim()
    const expression = (body ?? '').trim()

    if (expression.startsWith('--')) {
      definition.options.push(parseOption(expression.slice(2), description))
    } else {
      definition.arguments.push(parseArgument(expression, description))
    }
  }

  return definition
}

function parseArgument(expression: string, description: string): ArgumentDefinition {
  let name = expression
  let required = true
  let isArray = false
  let defaultValue: string | undefined

  const equals = name.indexOf('=')
  if (equals !== -1) {
    defaultValue = name.slice(equals + 1)
    name = name.slice(0, equals)
    required = false
  }

  if (name.endsWith('*')) {
    name = name.slice(0, -1)
    isArray = true
  }

  if (name.endsWith('?')) {
    name = name.slice(0, -1)
    required = false
  }

  return { name, required, isArray, default: defaultValue, description }
}

function parseOption(expression: string, description: string): OptionDefinition {
  let name = expression
  let shortcut: string | undefined
  let acceptsValue = false
  let isArray = false
  let defaultValue: string | boolean | undefined = false

  const pipe = name.indexOf('|')
  if (pipe !== -1) {
    shortcut = name.slice(0, pipe)
    name = name.slice(pipe + 1)
  }

  const equals = name.indexOf('=')
  if (equals !== -1) {
    acceptsValue = true
    const raw = name.slice(equals + 1)

    /**
     * `{--id=*}` is a **repeatable** option, not a default of `"*"`.
     *
     * That is Laravel's spelling — `mail:send {--id=*}`, invoked as
     * `--id=1 --id=2` — and reading the star as a default broke the one command
     * that used it. `model:prune` filtered its models against `only = ['*']`,
     * matched none, and reported `No model defines prunable()` against an
     * application whose model defined one. The command was right; its signature
     * was being misread.
     *
     * `{--tag*}` is still accepted below, since it was here first.
     */
    if (raw === '*') {
      isArray = true
      defaultValue = undefined
    } else {
      defaultValue = raw === '' ? undefined : raw
    }

    name = name.slice(0, equals)
  }

  if (name.endsWith('*')) {
    name = name.slice(0, -1)
    isArray = true
    acceptsValue = true
    defaultValue = undefined
  }

  return { name, shortcut, acceptsValue, isArray, default: defaultValue, description }
}

export class InputParseError extends Error {}

/**
 * Bind raw argv (already stripped of the command name) to a definition.
 */
export function parseInput(argv: string[], definition: CommandDefinition): ParsedInput {
  const args: Record<string, string | string[] | undefined> = {}
  const opts: Record<string, string | string[] | boolean | undefined> = {}

  for (const option of definition.options) {
    opts[option.name] = option.isArray ? [] : option.default
  }

  const positional: string[] = []
  let onlyPositional = false
  let index = 0

  while (index < argv.length) {
    const token = argv[index] as string
    index += 1

    if (onlyPositional) {
      positional.push(token)
      continue
    }

    if (token === '--') {
      onlyPositional = true
      continue
    }

    if (token.startsWith('--')) {
      const body = token.slice(2)
      const equals = body.indexOf('=')
      const key = equals === -1 ? body : body.slice(0, equals)
      const inlineValue = equals === -1 ? undefined : body.slice(equals + 1)

      const option = definition.options.find((candidate) => candidate.name === key)
      if (!option) throw new InputParseError(`The "--${key}" option does not exist.`)

      index += applyOption(opts, option, inlineValue, argv[index])
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      for (const character of token.slice(1)) {
        const option = definition.options.find((candidate) => candidate.shortcut === character)
        if (!option) throw new InputParseError(`The "-${character}" option does not exist.`)

        index += applyOption(opts, option, undefined, argv[index])
      }
      continue
    }

    positional.push(token)
  }

  let cursor = 0
  for (const argument of definition.arguments) {
    if (argument.isArray) {
      const rest = positional.slice(cursor)
      cursor = positional.length
      if (rest.length === 0 && argument.required) {
        throw new InputParseError(`Not enough arguments (missing: "${argument.name}").`)
      }
      args[argument.name] = rest
      continue
    }

    const value = positional[cursor]
    cursor += 1

    if (value === undefined) {
      if (argument.required) {
        throw new InputParseError(`Not enough arguments (missing: "${argument.name}").`)
      }
      args[argument.name] = argument.default
      continue
    }

    args[argument.name] = value
  }

  return { arguments: args, options: opts }
}

/**
 * Store one option value. Returns how many extra argv tokens were consumed
 * (1 when the value came from the following token, 0 otherwise).
 */
function applyOption(
  opts: Record<string, string | string[] | boolean | undefined>,
  option: OptionDefinition,
  inlineValue: string | undefined,
  nextToken: string | undefined
): number {
  if (!option.acceptsValue) {
    opts[option.name] = true
    return 0
  }

  let value = inlineValue
  let consumed = 0

  if (value === undefined) {
    if (nextToken === undefined || nextToken.startsWith('-')) {
      throw new InputParseError(`The "--${option.name}" option requires a value.`)
    }
    value = nextToken
    consumed = 1
  }

  if (option.isArray) {
    const current = opts[option.name]
    opts[option.name] = [...(Array.isArray(current) ? current : []), value]
    return consumed
  }

  opts[option.name] = value
  return consumed
}

/** Render `command:name {args}` for help output. */
export function formatUsage(definition: CommandDefinition): string {
  const parts = [definition.name]

  for (const argument of definition.arguments) {
    const suffix = argument.isArray ? '...' : ''
    parts.push(argument.required ? `<${argument.name}${suffix}>` : `[${argument.name}${suffix}]`)
  }

  if (definition.options.length > 0) parts.push('[options]')

  return parts.join(' ')
}

/**
 * The required arguments an invocation does not supply.
 *
 * Parsing leniently rather than catching the error `parseInput` throws: the
 * kernel needs the *list* to ask about, and "which one" is not recoverable from
 * a message. Options are not included — an option that is required is a
 * contradiction, and Laravel's prompting covers arguments only.
 */
export function missingArguments(
  definition: CommandDefinition,
  argv: string[]
): ArgumentDefinition[] {
  const positional: string[] = []
  let literal = false
  let index = 0

  while (index < argv.length) {
    const token = argv[index] as string
    index += 1

    if (token === '--') {
      literal = true

      continue
    }

    if (!literal && token.startsWith('-') && token !== '-') {
      const name = token.replace(/^--?/, '').split('=')[0] ?? ''
      const option = definition.options.find(
        (candidate) => candidate.name === name || candidate.shortcut === name
      )

      // `--table widgets` is one option and its value; without skipping the
      // value, `widgets` would be read as the first positional argument and the
      // command would look complete when it is not.
      if (option?.acceptsValue && !token.includes('=')) index += 1

      continue
    }

    positional.push(token)
  }

  return definition.arguments
    .filter((argument, position) =>
      argument.isArray ? positional.length <= position : positional[position] === undefined
    )
    .filter((argument) => argument.required)
}
