import pc from 'picocolors'
import { Command } from '../command.ts'

/**
 * `config:show` — what one config file or key actually resolved to.
 *
 * Reading `config/queue.ts` tells you what the file says; this tells you what
 * the application is running with, which is different the moment an `env()` call
 * is involved. The two disagreeing is the most common configuration bug there
 * is, and reading the file is exactly how it stays hidden.
 */
export class ConfigShowCommand extends Command {
  static override signature =
    'config:show {key : A config file, e.g. queue, or a dotted key} {--json : Output as JSON}'

  static override description = 'Show the resolved values of a config file or key'

  async handle(): Promise<number> {
    const key = this.argument('key')
    const value = this.app.config.get<unknown>(key)

    if (value === undefined) {
      this.error(`No configuration at [${key}].`)

      const roots = [...new Set(Object.keys(this.app.config.all()).map((one) => one.split('.')[0]))]
      this.comment(`Files: ${roots.join(', ')}`)

      return 1
    }

    if (this.flag('json')) {
      this.line(JSON.stringify(value, replacer, 2))

      return 0
    }

    this.line()
    this.output.pairs([['Key', key]])
    this.line()

    for (const [path, shown] of flatten(key, value)) {
      this.line(`  ${pc.dim(path)} ${shown}`)
    }

    this.line()

    return 0
  }
}

/**
 * Flattened to one line per leaf, rather than pretty-printed.
 *
 * A nested dump has to be read to find the one value in question; a flat list of
 * `queue.connections.redis.retryAfter` can be scanned, and is what somebody
 * comparing two environments actually wants.
 */
function flatten(prefix: string, value: unknown, into: Array<[string, string]> = []) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) flatten(`${prefix}.${key}`, nested, into)

    return into
  }

  into.push([prefix, show(value)])

  return into
}

function show(value: unknown): string {
  if (typeof value === 'function') return pc.yellow(`[function ${value.name || 'anonymous'}]`)
  if (value === undefined) return pc.dim('undefined')
  if (value === null) return pc.dim('null')
  if (typeof value === 'string') return value === '' ? pc.dim('""') : value

  return String(JSON.stringify(value))
}

/** Functions and classes have no JSON form; naming them beats writing `null`. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'function' ? `[function ${value.name || 'anonymous'}]` : value
}
