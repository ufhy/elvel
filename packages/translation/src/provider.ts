import { ServiceProvider } from '@elysian/core'
import { Translator } from './translator.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    translator: Translator
  }
}

/**
 * Binds the translator and reads `lang/`.
 *
 * Loaded at boot rather than per request: message files are small, they do not
 * change while the process runs, and reading them per request would put a
 * filesystem call inside every view render.
 */
export class TranslationServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(
      'translator',
      () =>
        new Translator(
          this.config<string>('app.locale', 'en'),
          this.config<string>('app.fallbackLocale', 'en')
        )
    )
  }

  override async boot(): Promise<void> {
    await this.app.make('translator').load(this.app.basePath('lang'))
  }
}
