import { Command } from '@elysian/console'
import { Encrypter } from '../encrypter.ts'
import { generateKey } from '../keys.ts'

const encrypted = (file: string) => `${file}.encrypted`

/**
 * `env:encrypt` — put the environment file in the repository safely.
 *
 * The key is **not** APP_KEY and cannot be: APP_KEY lives inside the file being
 * encrypted, so a file encrypted with it could only be read by somebody who
 * already had it. A fresh key is generated, printed once, and never written
 * anywhere — losing it means losing the file, which is the property that makes
 * the encrypted file safe to commit.
 */
export class EnvironmentEncryptCommand extends Command {
  static override signature =
    'env:encrypt {--key= : Use this key instead of generating one} {--env= : Encrypt .env.<name> instead of .env} {--force : Overwrite an existing encrypted file}'

  static override description = 'Encrypt an environment file'

  async handle(): Promise<number> {
    const name = this.stringOption('env')
    const source = this.app.basePath(name === '' ? '.env' : `.env.${name}`)
    const target = encrypted(source)

    const plain = Bun.file(source)

    if (!(await plain.exists())) {
      this.error(`No environment file at ${this.relative(source)}.`)

      return 1
    }

    if ((await Bun.file(target).exists()) && !this.flag('force')) {
      this.error(`${this.relative(target)} already exists.`)
      this.comment('Pass --force to overwrite it.')

      return 1
    }

    const key = this.stringOption('key') || generateKey()
    const cipher = new Encrypter(key).encryptString(await plain.text())

    await Bun.write(target, cipher)

    this.output.tag('INFO', `Encrypted to ${this.relative(target)}.`)
    this.line()
    this.output.pairs([['Key', key]])
    this.line()
    // Said plainly, because this is the only time the key is ever shown.
    this.warn('Store this key somewhere safe. It is not written to disk and cannot be recovered.')

    return 0
  }

  private relative(path: string): string {
    return path.replace(`${this.app.basePath()}/`, '')
  }
}

/**
 * `env:decrypt` — the other half, on the machine that has the key.
 *
 * Refuses to overwrite an existing `.env` without `--force`: the file it would
 * replace is usually the one with somebody's local database in it.
 */
export class EnvironmentDecryptCommand extends Command {
  static override signature =
    'env:decrypt {--key= : The key it was encrypted with} {--env= : Decrypt .env.<name>.encrypted} {--force : Overwrite an existing plain file}'

  static override description = 'Decrypt an environment file'

  async handle(): Promise<number> {
    const name = this.stringOption('env')
    const target = this.app.basePath(name === '' ? '.env' : `.env.${name}`)
    const source = encrypted(target)

    const key = this.stringOption('key') || String(process.env.ELYSIAN_ENV_KEY ?? '')

    if (key === '') {
      this.error('A key is required: pass --key, or set ELYSIAN_ENV_KEY.')

      return 1
    }

    const cipher = Bun.file(source)

    if (!(await cipher.exists())) {
      this.error(`No encrypted file at ${this.relative(source)}.`)

      return 1
    }

    if ((await Bun.file(target).exists()) && !this.flag('force')) {
      this.error(`${this.relative(target)} already exists.`)
      this.comment('Pass --force to overwrite it.')

      return 1
    }

    let plain: string

    try {
      plain = new Encrypter(key).decryptString((await cipher.text()).trim())
    } catch {
      // The payload is authenticated, so a wrong key is a failed tag check
      // rather than plausible-looking rubbish. Saying so beats writing garbage.
      this.error('That key does not decrypt this file.')

      return 1
    }

    await Bun.write(target, plain)

    this.output.tag('INFO', `Decrypted to ${this.relative(target)}.`)

    return 0
  }

  private relative(path: string): string {
    return path.replace(`${this.app.basePath()}/`, '')
  }
}
