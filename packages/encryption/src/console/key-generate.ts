import { Command } from '@elysian/console'
import { generateKey } from '../keys.ts'

/**
 * `key:generate`
 *
 * Writes a fresh `APP_KEY` into `.env`, or prints one with `--show`.
 *
 * Replacing a key makes every existing encrypted payload unreadable — cookies,
 * encrypted columns, encrypted queue payloads — so the old value is printed with
 * instructions for keeping it readable through the rotation rather than being
 * silently discarded.
 */
export class KeyGenerateCommand extends Command {
  static override signature =
    'key:generate {--show : Print the key instead of writing it} {--force : Replace an existing key without confirming}'

  static override description = 'Set the application key'

  async handle(): Promise<number> {
    const key = generateKey()

    if (this.flag('show')) {
      this.line(key)

      return 0
    }

    const path = this.app.basePath('.env')
    const file = Bun.file(path)

    if (!(await file.exists())) {
      this.error(`No .env at ${path}. Copy .env.example first.`)

      return 1
    }

    const contents = await file.text()
    const current = /^APP_KEY=(.*)$/m.exec(contents)?.[1]?.trim() ?? ''

    if (current !== '' && !this.flag('force')) {
      this.error('APP_KEY is already set. Pass --force to replace it.')
      this.comment('Everything already encrypted with it becomes unreadable unless you keep it:')
      this.comment(`  APP_PREVIOUS_KEYS=${current}`)

      return 1
    }

    await Bun.write(
      path,
      /^APP_KEY=.*$/m.test(contents)
        ? contents.replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`)
        : `${contents.trimEnd()}\nAPP_KEY=${key}\n`
    )

    this.output.tag('INFO', 'Application key set.')

    if (current !== '') {
      this.comment('Keep the old key readable during the rotation by setting:')
      this.comment(`  APP_PREVIOUS_KEYS=${current}`)
    }

    return 0
  }
}
