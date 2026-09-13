import { ServiceProvider } from '@elvel/core'
import { preferredLocale } from './negotiate.ts'
import { Translator } from './translator.ts'

declare module '@elvel/contracts' {
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
    const translator = this.app.make('translator')

    await translator.load(this.app.basePath('lang'))

    if (this.config<boolean>('app.negotiateLocale', false) !== true) return

    /**
     * Off unless asked for, because it changes what every page answers with.
     *
     * A synchronous hook: the locale is a request slot, and a slot written from
     * an async one is already in the wrong frame by the time a handler runs.
     */
    const available = translator.locales()

    this.app.router.onRequest(({ request }) => {
      const wanted = preferredLocale(request.headers.get('accept-language'), available)

      if (wanted !== undefined) translator.usingLocale(wanted)
    })
  }
}
