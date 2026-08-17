import { randomBytes } from 'node:crypto'
import { Command } from '@elvel/console'

/**
 * `auth:secret`
 *
 * Writes a fresh `AUTH_SECRET` into `.env`, or prints one with `--show`.
 *
 * Laravel has no equivalent because Fortify signs with `APP_KEY`. better-auth
 * wants its own, and that is the better arrangement — one key signing both the
 * framework's ciphertext and the session tokens means a leak of either is a leak
 * of both — but it does mean there is a second secret to forget, and forgetting
 * it is silent: better-auth signs with an empty string and nothing complains.
 *
 * Replacing it invalidates every session, which is why an existing value is not
 * overwritten without `--force`. That is a smaller loss than rotating `APP_KEY`:
 * people sign in again, rather than losing what was encrypted.
 */
export class AuthSecretCommand extends Command {
  static override signature =
    'auth:secret {--show : Print the secret instead of writing it} {--force : Replace an existing secret without confirming}'

  static override description = 'Set the secret better-auth signs its tokens with'

  async handle(): Promise<number> {
    // 32 bytes, hex — the length better-auth's own documentation asks for.
    const secret = randomBytes(32).toString('hex')

    if (this.flag('show')) {
      this.line(secret)

      return 0
    }

    const path = this.app.basePath('.env')
    const file = Bun.file(path)

    if (!(await file.exists())) {
      this.error(`No .env at ${path}. Copy .env.example first.`)

      return 1
    }

    const contents = await file.text()
    const current = /^AUTH_SECRET=(.*)$/m.exec(contents)?.[1]?.trim() ?? ''

    if (current !== '' && !this.flag('force')) {
      this.error('AUTH_SECRET is already set. Pass --force to replace it.')
      this.comment('Replacing it signs everybody out; sessions are verified against it.')

      return 1
    }

    await Bun.write(
      path,
      /^AUTH_SECRET=.*$/m.test(contents)
        ? contents.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`)
        : `${contents.trimEnd()}\nAUTH_SECRET=${secret}\n`
    )

    this.output.tag('INFO', 'Auth secret set.')

    if (current !== '') this.comment('Existing sessions are no longer valid.')

    return 0
  }
}
