import { ServiceProvider } from '@elysian/core'
import { EncryptionRotateCommand } from './console/encryption-rotate.ts'
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
      this.app.make('artisan').register(KeyGenerateCommand, EncryptionRotateCommand)
    }

    await this.enableEncryptedCasts()
  }

  /**
   * Hand the encrypter to the model casts.
   *
   * Imported lazily so this package does not depend on the database one: an
   * application that encrypts cookies but has no database still works, and one
   * with a database gets `encrypted` casts without asking.
   */
  private async enableEncryptedCasts(): Promise<void> {
    if (!this.app.bound('db')) return

    const { setAttributeEncrypter } = await import('@elysian/database')

    setAttributeEncrypter(this.app.make('encrypter'))
  }
}
