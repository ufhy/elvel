import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ServiceProvider } from '@elyvel/core'
import { MakeMailCommand } from './console/make-mail.ts'
import type { MailableClass } from './mailable.ts'
import { MailManager } from './manager.ts'
import { SendQueuedMail } from './queued.ts'

declare module '@elyvel/contracts' {
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
    if (this.app.bound('artisan')) {
      this.app.make('artisan').register(MakeMailCommand)
    }

    const manager = this.app.make('mail')

    manager.mailables.register(...(await this.discoverMailables()))

    if (!this.app.bound('queue')) return

    // The job is constructed by the worker, so it reaches the manager through a
    // static rather than a constructor argument.
    SendQueuedMail.resolver = {
      mailer: (name?: string) => manager.mailer(name),
      mailables: manager.mailables
    }

    this.app.make('queue').jobs.register(SendQueuedMail)
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
