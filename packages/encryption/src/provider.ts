import { ServiceProvider } from '@elysian/core'
import { EncryptionRotateCommand } from './console/encryption-rotate.ts'
import { EnvironmentDecryptCommand, EnvironmentEncryptCommand } from './console/env-encrypt.ts'
import { KeyGenerateCommand } from './console/key-generate.ts'
import { Encrypter } from './encrypter.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    encrypter: Encrypter
  }
}

/**
 * Binds the encrypter.
 *
 * Built lazily, so an application that never encrypts anything is not required to
 * have a usable `APP_KEY` — and one that does gets told exactly what is wrong the
 * first time it tries.
 */
export class EncryptionServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('encrypter', (app) => {
      const key = app.config.get<string>('app.key', '')

      if (key === '') {
        throw new Error(
          'APP_KEY is not set, so nothing can be encrypted. Run: artisan key:generate'
        )
      }

      return new Encrypter(key, {
        // Comma-separated, so a rotation is one environment variable.
        previousKeys: app.config
          .get<string>('app.previousKeys', '')
          .split(',')
          .map((previous) => previous.trim())
          .filter(Boolean)
      })
    })
  }

  override async boot(): Promise<void> {
    if (this.app.bound('artisan')) {
      this.app
        .make('artisan')
        .register(
          KeyGenerateCommand,
          EncryptionRotateCommand,
          EnvironmentEncryptCommand,
          EnvironmentDecryptCommand
        )
    }

    await this.enableEncryptedCasts()
  }

  /**
   * Hand the encrypter to the model casts.
   *
   * Imported lazily so this package does not depend on the database one: an
   * application that encrypts cookies but has no database still works, and one
   * with a database gets `encrypted` casts without asking.
   *
   * What is handed over is a **deferred** encrypter, not a resolved one. The
   * binding above throws when `APP_KEY` is empty, and resolving it here meant the
   * whole application refused to boot — including `artisan key:generate`, the one
   * command that fixes an empty key. The chicken-and-egg was hidden for as long
   * as the template shipped a placeholder key that counted as set.
   *
   * The casts need a synchronous encrypter, so this forwards each call rather
   * than awaiting anything: the key is checked the first time something actually
   * encrypts, which is what the comment on the binding always claimed.
   */
  private async enableEncryptedCasts(): Promise<void> {
    if (!this.app.bound('db')) return

    const { setAttributeEncrypter } = await import('@elysian/database')
    const resolve = () => this.app.make('encrypter')

    setAttributeEncrypter({
      encryptString: (value, context) => resolve().encryptString(value, context),
      decryptString: (payload, context) => resolve().decryptString(payload, context),
      blindIndex: (value, context) => resolve().blindIndex(value, context)
    })
  }
}
