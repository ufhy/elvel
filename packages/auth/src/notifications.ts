import { MailMessage, Notification } from '@elysian/notifications'

/** What better-auth hands its mail callbacks, and all these notifications need. */
export type AuthMailData = {
  /** The link, already signed and tokenised by better-auth. */
  url: string
  token: string
  /** For the greeting. better-auth's user may have no name. */
  name?: string | undefined
  /** How long the link lasts, in seconds, so the mail can say so. */
  expiresIn?: number | undefined
  appName?: string | undefined
}

/** "in 1 hour", "in 15 minutes" — a person reads time, not seconds. */
function readableExpiry(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600

    return hours === 1 ? '1 hour' : `${hours} hours`
  }

  const minutes = Math.max(1, Math.round(seconds / 60))

  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

function greet(name: string | undefined): string {
  return name === undefined || name === '' ? 'Hello!' : `Hello ${name}!`
}

/**
 * The password-reset link — Laravel's `ResetPassword` notification.
 *
 * Sent from better-auth's `sendResetPassword` hook, which fires for a *request*
 * to reset rather than a reset. That is why the closing line matters: the person
 * receiving this may not have asked for it, and telling them plainly that doing
 * nothing is safe is what stops a stream of "someone is attacking my account"
 * support tickets over what is usually a mistyped email address.
 */
export class ResetPasswordNotification extends Notification<AuthMailData> {
  via(): string[] {
    return ['mail']
  }

  override toMail(): MailMessage {
    const message = new MailMessage()
      .subject(`Reset your ${this.data.appName ?? 'account'} password`)
      .greeting(greet(this.data.name))
      .line('You are receiving this email because we received a password reset request.')
      .action('Reset password', this.data.url)

    if (this.data.expiresIn !== undefined) {
      message.line(`This link expires in ${readableExpiry(this.data.expiresIn)}.`)
    }

    return message.line(
      'If you did not request a password reset, no further action is required — your password has not changed.'
    )
  }

  override toArray(): Record<string, unknown> {
    // Deliberately without the token: a notification can be stored or logged, and
    // a reset token in a log file is a working key to the account.
    return { url: '[redacted]', kind: 'password-reset' }
  }
}

/**
 * The address-confirmation link — Laravel's `VerifyEmail` notification.
 *
 * Verification is what stops somebody signing up with an address they do not own
 * and then receiving that person's mail from the application forever after.
 */
export class VerifyEmailNotification extends Notification<AuthMailData> {
  via(): string[] {
    return ['mail']
  }

  override toMail(): MailMessage {
    return new MailMessage()
      .subject(`Verify your ${this.data.appName ?? 'account'} email address`)
      .greeting(greet(this.data.name))
      .line('Please confirm this is your email address.')
      .action('Verify email address', this.data.url)
      .line('If you did not create an account, you can safely ignore this email.')
  }

  override toArray(): Record<string, unknown> {
    return { url: '[redacted]', kind: 'verify-email' }
  }
}

/**
 * "Your password was changed" — sent after a reset succeeds.
 *
 * Laravel has no notification for this and it is the one worth adding: a reset
 * that the account's owner did not perform is the moment they need to know, and
 * the only channel still reachable is the address that was just used.
 */
export class PasswordChangedNotification extends Notification<{
  name?: string | undefined
  appName?: string | undefined
}> {
  via(): string[] {
    return ['mail']
  }

  override toMail(): MailMessage {
    return new MailMessage()
      .subject(`Your ${this.data.appName ?? 'account'} password was changed`)
      .greeting(greet(this.data.name))
      .line('Your password has just been changed.')
      .line('If this was not you, contact us immediately — your account may be compromised.')
      .error()
  }

  override toArray(): Record<string, unknown> {
    return { kind: 'password-changed' }
  }
}
