import { MailMessage, Notification } from '@elvel/notifications'

/**
 * The callback an application sets to write its own version of one of these.
 *
 * Laravel's shape, and for its reason: changing one sentence of the reset mail
 * should not mean taking over delivery. Before this, the only way in was to define
 * `sendResetPassword` in `config/auth.ts` yourself — the framework leaves an
 * application's own hook alone — which meant writing the notifier call, the
 * recipient and the expiry read to change a greeting.
 *
 * Laravel pairs this with `createUrlUsing`, and there is deliberately no counterpart
 * here. Laravel builds the link itself, with `route('password.reset')` and
 * `URL::temporarySignedRoute`, so overriding it is a real need. better-auth builds
 * ours and hands it over already signed; there is nothing left to override.
 *
 * Static, so it is set once at boot — `AppServiceProvider`, as Laravel sets it in
 * a provider — rather than per instance, which the hook constructing these does not
 * offer a way to reach.
 */
export type AuthMailCallback<TData> = (data: TData) => MailMessage

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
  /** Set with ResetPasswordNotification.toMailUsing(), and used instead of `toMail` below. */
  static mailUsing: AuthMailCallback<AuthMailData> | undefined

  /** Write this mail yourself, without taking over how it is sent. */
  static toMailUsing(callback: AuthMailCallback<AuthMailData>): void {
    ResetPasswordNotification.mailUsing = callback
  }

  via(): string[] {
    return ['mail']
  }

  override toMail(): MailMessage {
    const own = ResetPasswordNotification.mailUsing

    if (own) return own(this.data)

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
  /** Set with VerifyEmailNotification.toMailUsing(), and used instead of `toMail` below. */
  static mailUsing: AuthMailCallback<AuthMailData> | undefined

  /** Write this mail yourself, without taking over how it is sent. */
  static toMailUsing(callback: AuthMailCallback<AuthMailData>): void {
    VerifyEmailNotification.mailUsing = callback
  }

  via(): string[] {
    return ['mail']
  }

  override toMail(): MailMessage {
    const own = VerifyEmailNotification.mailUsing

    if (own) return own(this.data)

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
  /** Set with PasswordChangedNotification.toMailUsing(), and used instead of `toMail` below. */
  static mailUsing:
    | AuthMailCallback<{
        name?: string | undefined
        appName?: string | undefined
      }>
    | undefined

  /** Write this mail yourself, without taking over how it is sent. */
  static toMailUsing(
    callback: AuthMailCallback<{
      name?: string | undefined
      appName?: string | undefined
    }>
  ): void {
    PasswordChangedNotification.mailUsing = callback
  }

  via(): string[] {
    return ['mail']
  }

  override toMail(): MailMessage {
    const own = PasswordChangedNotification.mailUsing

    if (own) return own(this.data)

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

/**
 * "Confirm your new email address" — sent to the address on file, not the new one.
 *
 * The direction is the whole security property. A stolen session that changes the
 * address would otherwise lock the owner out silently; sending the confirmation to
 * the address already on record means the change needs the old inbox too, and the
 * owner hears about an attempt they did not make.
 *
 * better-auth only asks for this when the current address is already verified. An
 * unverified one is replaced outright, because there is nothing yet to protect.
 */
export class ChangeEmailNotification extends Notification<AuthMailData & { newEmail: string }> {
  /** Set with ChangeEmailNotification.toMailUsing(), and used instead of `toMail` below. */
  static mailUsing: AuthMailCallback<AuthMailData & { newEmail: string }> | undefined

  /** Write this mail yourself, without taking over how it is sent. */
  static toMailUsing(callback: AuthMailCallback<AuthMailData & { newEmail: string }>): void {
    ChangeEmailNotification.mailUsing = callback
  }

  via(): string[] {
    return ['mail']
  }

  override toMail(): MailMessage {
    const own = ChangeEmailNotification.mailUsing

    if (own) return own(this.data)

    return new MailMessage()
      .subject(`Confirm your new ${this.data.appName ?? 'account'} email address`)
      .greeting(greet(this.data.name))
      .line(`Somebody asked to move this account to ${this.data.newEmail}.`)
      .action('Confirm the change', this.data.url)
      .line('Until you confirm, this address stays in place.')
      .line('If this was not you, ignore this email and change your password.')
  }

  override toArray(): Record<string, unknown> {
    // The new address is kept: it is what makes a stored copy worth reading back.
    return { url: '[redacted]', newEmail: this.data.newEmail, kind: 'change-email' }
  }
}
