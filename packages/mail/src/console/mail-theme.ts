import { Command } from '@elvel/console'
import { DEFAULT_THEME_CSS } from '../theme.ts'

/**
 * Write a copy of the default mail stylesheet into the application.
 *
 * Laravel's `vendor:publish --tag=laravel-mail`, narrowed to the one file anybody
 * actually publishes. A theme is CSS, and CSS is edited with the file open — asking
 * somebody to paste a stylesheet into a config module would be the same mistake as
 * making them write `style` attributes by hand.
 *
 * It does not touch `config/mail.ts`: naming the file is one line, and a command
 * that rewrites a config as a side effect of writing a stylesheet is a command
 * nobody can predict. It prints the line to add instead.
 */
export class MailThemeCommand extends Command {
  static override signature =
    'mail:theme {--path=resources/mail/theme.css : Where to write it} {--force : Overwrite a file that already exists}'

  static override description = 'Publish the mail theme stylesheet'

  async handle(): Promise<number> {
    const path = String(this.option('path') ?? 'resources/mail/theme.css')
    const target = this.app.basePath(path)

    if ((await Bun.file(target).exists()) && this.option('force') !== true) {
      this.error(`${path} already exists. Pass --force to overwrite it.`)

      return 1
    }

    await Bun.write(target, DEFAULT_THEME_CSS.trimStart())

    this.info(`Published ${path}`)
    this.line(`Name it in config/mail.ts:  theme: '${path}'`)

    return 0
  }
}
