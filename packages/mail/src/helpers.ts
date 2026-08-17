import { app } from '@elyvel/core'
import type { Address } from './mailable.ts'
import type { Mailer, PendingMail } from './mailer.ts'
import type { MailManager } from './manager.ts'

/** The mail manager. */
export function mail(): MailManager {
  return app('mail')
}

/** A named mailer, or the default one. */
export function mailer(name?: string): Mailer {
  return mail().mailer(name)
}

/**
 * Start addressing a message.
 *
 * ```ts
 * await mailTo(user.email).send(new ArticlePublished({ title }))
 * await mailTo(user.email).queue(new ArticlePublished({ title }))
 * ```
 */
export function mailTo(recipients: Address | Address[]): PendingMail {
  return mail().to(recipients)
}
