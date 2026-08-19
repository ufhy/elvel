import { generateSecret, type MaintenancePayload } from '@elvel/core'
import { Command } from '../command.ts'

/**
 * `elvel down` — refuse requests while you deploy.
 *
 * Everything the middleware needs goes into one file, including a pre-rendered
 * page when `--render` names a view. Rendering **now** rather than per request is
 * the point of that option: the reason to be in maintenance mode is often that the
 * application cannot serve a page, and asking it to render one then is asking the
 * broken thing to explain itself.
 */
export class DownCommand extends Command {
  static override signature =
    'down {--retry= : Seconds for the Retry-After header} {--refresh= : Seconds for the Refresh header, so a browser reloads itself} {--secret= : A phrase that bypasses maintenance mode} {--with-secret : Generate the phrase instead of naming it} {--redirect= : Send visitors here instead of refusing them} {--status=503 : Status code to answer with} {--except= : Comma-separated paths that answer normally} {--render= : A view to pre-render as the page, e.g. errors.503}'

  static override description = 'Put the application into maintenance mode'

  async handle(): Promise<number> {
    const maintenance = this.app.make('maintenance')
    const wasDown = await maintenance.active()

    const secret = this.flag('with-secret')
      ? generateSecret()
      : this.stringOption('secret') || undefined

    const payload: MaintenancePayload = {
      since: Math.floor(Date.now() / 1000),
      status: Number(this.stringOption('status', '503')),
      ...(secret ? { secret } : {}),
      ...this.optionalNumber('retry'),
      ...this.optionalNumber('refresh'),
      ...this.optionalRedirect(),
      ...this.optionalExcept(),
      ...(await this.optionalTemplate())
    }

    await maintenance.activate(payload)

    if (this.app.bound('events')) {
      await this.app.make('events').dispatch('maintenance.enabled', payload)
    }

    this.output.tag(
      'INFO',
      wasDown ? 'Maintenance mode options updated.' : 'Application is now in maintenance mode.'
    )

    if (secret) {
      const url = this.app.config.get<string>('app.url', '')

      this.comment(`Bypass it by visiting: ${url}/${secret}`)
      this.comment('That sets a cookie valid for 12 hours; the phrase itself is never stored.')
    }

    return 0
  }

  private optionalNumber(key: 'retry' | 'refresh'): Partial<MaintenancePayload> {
    const value = this.stringOption(key)

    return value === '' ? {} : { [key]: Number(value) }
  }

  private optionalRedirect(): Partial<MaintenancePayload> {
    const redirect = this.stringOption('redirect')
    if (redirect === '') return {}

    return { redirect: redirect === '/' ? '/' : `/${redirect.replace(/^\/+|\/+$/g, '')}` }
  }

  private optionalExcept(): Partial<MaintenancePayload> {
    const except = this.stringOption('except')
      .split(',')
      .map((path) => path.trim())
      .filter((path) => path !== '')

    return except.length > 0 ? { except } : {}
  }

  /**
   * Pre-render a view, so the page survives an application that cannot boot.
   *
   * `errors.maintenance` is `resources/views/errors/maintenance.tsx`, and the
   * module's first exported function is the component. A dotted *name* rather than
   * an import because this crosses a process boundary: the command runs now, the
   * page is served later by a request that may not be able to import anything.
   */
  private async optionalTemplate(): Promise<Partial<MaintenancePayload>> {
    const name = this.stringOption('render')
    if (name === '') return {}

    if (!this.app.bound('view')) {
      this.error('--render needs ViewServiceProvider. Writing no template.')

      return {}
    }

    const file = this.app.resourcePath(
      'views',
      ...`${name}.tsx`.split('.').slice(0, -1).join('/').split('/')
    )
    const path = `${file}.tsx`

    if (!(await Bun.file(path).exists())) {
      this.error(`No view at ${path}. Writing no template.`)

      return {}
    }

    const module = (await import(path)) as Record<string, unknown>
    const component = Object.values(module).find((value) => typeof value === 'function')

    if (!component) {
      this.error(`${path} exports no component. Writing no template.`)

      return {}
    }

    const retry = Number(this.stringOption('retry', '0'))

    return {
      template: await this.app.make('view').render(
        component as never,
        {
          retryAfter: retry > 0 ? retry : undefined
        } as never
      )
    }
  }
}
