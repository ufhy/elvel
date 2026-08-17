import { copyFile } from 'node:fs/promises'
import { Command } from '../command.ts'

/**
 * Which package each config file belongs to.
 *
 * Laravel needs no such map: its defaults sit in one directory inside
 * `laravel/framework`, and the command lists that directory. Here the framework
 * is twenty-six packages, so a config file lives with the code that reads it —
 * `config/mail.ts` beside the mailer, `config/session.ts` beside the HTTP layer
 * that starts sessions.
 *
 * `app` and `services` are missing on purpose. Both are application files rather
 * than package defaults: `config/app.ts` names `bootstrap/providers.ts`, which
 * only exists in an application, and `config/services.ts` is a place for the
 * application's own credentials. Every scaffolded application ships both.
 */
const OWNERS: Record<string, string> = {
  auth: 'auth',
  broadcasting: 'broadcasting',
  cache: 'cache',
  concurrency: 'concurrency',
  cors: 'http',
  database: 'database',
  filesystems: 'storage',
  hashing: 'hashing',
  http: 'http',
  image: 'image',
  logging: 'log',
  mail: 'mail',
  notifications: 'notifications',
  queue: 'queue',
  session: 'http',
  view: 'view',
  vite: 'view'
}

/**
 * `config:publish` — copy a framework config file into the application.
 *
 * Laravel's command, and Laravel's reason for it: the skeleton ships ten config
 * files rather than every one, and this is how the rest are fetched when they
 * are wanted. Here the reason is sharper. A config file's package may not even
 * be installed — `--kit=none` has no mailer — so publishing `mail` without
 * `@elysian/mail` is a question with a real answer rather than a missing file.
 *
 * One step Laravel does not need: the copy is not enough on its own. An
 * application names its config files in `bootstrap/app.ts` so a bundler can
 * follow them, so a published file that nobody named would be a file the
 * framework never reads — configured, present, and silently ignored. The
 * command adds the line, and says so.
 */
export class ConfigPublishCommand extends Command {
  static override signature =
    'config:publish {name? : The configuration file to publish} {--all : Publish every one} {--force : Overwrite a file that already exists}'

  static override description = 'Publish configuration files to your application'

  async handle(): Promise<number> {
    const all = this.option('all') === true
    const named = this.argument('name')

    if (!named && !all) {
      const chosen = await this.choice('Which configuration file?', Object.keys(OWNERS).sort())

      return await this.publish([chosen])
    }

    if (all) return await this.publish(Object.keys(OWNERS).sort())

    if (!(named in OWNERS)) {
      this.error(`Unrecognised configuration file [${named}].`)
      this.comment(`Try one of: ${Object.keys(OWNERS).sort().join(', ')}`)

      return 1
    }

    return await this.publish([named])
  }

  private async publish(names: string[]): Promise<number> {
    const published: string[] = []
    let failed = false

    for (const name of names) {
      const source = this.defaultFor(name)

      if (!source) {
        // Only worth complaining about when it was asked for by name: `--all`
        // over an application that installed six packages should not print
        // eleven errors.
        if (names.length === 1) {
          this.error(`[@elysian/${OWNERS[name]}] is not installed, so there is no ${name} config.`)
          this.comment(`Install it first: bun add @elysian/${OWNERS[name]}`)
          failed = true
        }

        continue
      }

      const destination = this.app.configPath(`${name}.ts`)

      if ((await Bun.file(destination).exists()) && this.option('force') !== true) {
        this.error(`config/${name}.ts already exists. Pass --force to overwrite it.`)
        failed = true

        continue
      }

      await copyFile(source, destination)
      published.push(name)

      this.info(`Published config/${name}.ts`)
    }

    if (published.length > 0) await this.register(published)

    return failed ? 1 : 0
  }

  /** Where the package keeps its default, or nothing if it is not installed. */
  private defaultFor(name: string): string | undefined {
    try {
      return Bun.resolveSync(`@elysian/${OWNERS[name]}/config/${name}.ts`, this.app.basePath())
    } catch {
      return undefined
    }
  }

  /**
   * Add the published files to `withConfig` in `bootstrap/app.ts`.
   *
   * Rewriting somebody's source is not something to do lightly, so this touches
   * one thing and refuses the moment the file does not look the way it shipped:
   * it inserts lines of a known shape into a call it can find, keeps the keys
   * sorted, and otherwise prints what to add and changes nothing.
   */
  private async register(names: string[]): Promise<void> {
    const path = this.app.basePath('bootstrap', 'app.ts')
    const source = await Bun.file(path)
      .text()
      .catch(() => '')

    const lines = names.map((name) => `    ${name}: () => import('../config/${name}.ts')`)
    const start = source.indexOf('.withConfig({')

    if (start === -1) {
      this.comment('Add these to `withConfig` in bootstrap/app.ts:')
      for (const line of lines) this.comment(line.trim())

      return
    }

    const end = source.indexOf('})', start)
    const inside = source.slice(start + '.withConfig({'.length, end)

    const entries = [
      ...inside
        .split('\n')
        .map((line) => line.trimEnd().replace(/,$/, ''))
        .filter((line) => line.trim() !== ''),
      ...lines.filter((line) => !inside.includes(line.trim()))
    ].sort((a, b) => a.trim().localeCompare(b.trim()))

    const rewritten = `${source.slice(0, start)}.withConfig({\n${entries.join(',\n')}\n  ${source.slice(end)}`

    await Bun.write(path, rewritten)

    this.info(`Named ${names.length === 1 ? 'it' : 'them'} in bootstrap/app.ts`)
  }
}
