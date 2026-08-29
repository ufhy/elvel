import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ServiceProvider } from '@elvel/core'
import { Elysia } from 'elysia'
import { MailThemeCommand } from './console/mail-theme.ts'
import { MakeMailCommand } from './console/make-mail.ts'
import type { MailableClass } from './mailable.ts'
import { MailManager } from './manager.ts'
import { handlePreview } from './preview.ts'
import { SendQueuedMail } from './queued.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    mail: MailManager
  }
}

/**
 * Binds the mail manager and makes queued mail work.
 *
 * Two registrations matter for the queue: the job that sends a mailable from a
 * worker, and the mailables themselves — a worker is a different process, so the
 * payload carries a name and the name has to resolve.
 */
export class MailServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('mail', (app) => new MailManager(app))
  }

  override async boot(): Promise<void> {
    if (this.app.bound('elvel')) {
      this.app.make('elvel').register(MakeMailCommand)
      this.app.make('elvel').register(MailThemeCommand)
    }

    const manager = this.app.make('mail')

    manager.mailables.register(...(await this.discoverMailables()))

    this.mountPreview(manager)

    if (!this.app.bound('queue')) return

    // The job is constructed by the worker, so it reaches the manager through a
    // static rather than a constructor argument.
    SendQueuedMail.resolver = {
      mailer: (name?: string) => manager.mailer(name),
      mailables: manager.mailables
    }

    this.app.make('queue').jobs.register(SendQueuedMail)
  }

  /**
   * The preview page, when the application asks for one.
   *
   * `mail.preview` is a path — `'/_mail'` in a scaffolded application — and unset in
   * production, because a page that renders every mail your application can send is
   * a page that describes your customers to anybody who finds it. It is a path
   * rather than a boolean so an application can move it, and `false` turns it off
   * where the environment alone is not the answer.
   *
   * An `onRequest` hook rather than a route, for the reason `@elvel/vite`'s build
   * guard is one: providers boot before the routes file loads, so a route registered
   * here loses to a wildcard the application registers afterwards — and a
   * client-routed application has one.
   */
  private mountPreview(manager: MailManager): void {
    const configured = this.config<string | false>('mail.preview', false)

    if (configured === false || configured === '' || this.app.isProduction()) return

    const base = configured.startsWith('/') ? configured : `/${configured}`

    this.use(
      new Elysia({ name: 'elvel:mail-preview' }).onRequest(async ({ request }) => {
        const answer = await handlePreview(manager, request, base)

        if (answer !== undefined) return answer
      })
    )
  }

  /** Every exported class in `app/Mail` that looks like a mailable. */
  private async discoverMailables(): Promise<MailableClass[]> {
    const directory = this.app.appPath('Mail')

    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return []
    }

    const mailables: MailableClass[] = []

    for (const entry of entries.sort()) {
      if (!/\.(ts|js|mts|mjs)$/.test(entry) || entry.endsWith('.d.ts')) continue

      const module = (await import(join(directory, entry))) as Record<string, unknown>

      for (const exported of Object.values(module)) {
        if (!MailServiceProvider.looksLikeMailable(exported)) continue

        mailables.push(exported as MailableClass)
      }
    }

    return mailables
  }

  private static looksLikeMailable(value: unknown): boolean {
    const prototype = (value as { prototype?: { envelope?: unknown; content?: unknown } }).prototype

    return (
      typeof value === 'function' &&
      typeof prototype?.envelope === 'function' &&
      typeof prototype?.content === 'function'
    )
  }
}
