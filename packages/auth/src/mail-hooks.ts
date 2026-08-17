import {
  ChangeEmailNotification,
  PasswordChangedNotification,
  ResetPasswordNotification,
  VerifyEmailNotification
} from './notifications.ts'

/** The user better-auth hands its mail callbacks. */
type AuthUser = { email: string; name?: string | null }

/** What better-auth passes to `sendResetPassword` / `sendVerificationEmail`. */
type MailHookArgs = { user: AuthUser; url: string; token: string }

/** The slice of the notification manager these hooks use. */
export type Notifier = {
  route(channel: string, destination: unknown): unknown
  send(notifiable: unknown, notification: unknown): Promise<void>
}

export type MailHookOptions = {
  notifier: Notifier
  /** Shown in every subject line. `config('app.name')`. */
  appName?: string | undefined
  /** better-auth's `resetPasswordTokenExpiresIn`, so the mail can say so. */
  resetExpiresIn?: number | undefined
}

/**
 * The three mail callbacks better-auth asks for, as notifications.
 *
 * better-auth builds the tokens and the URLs and then asks the application to
 * deliver them; it deliberately ships no mailer. This is that delivery, routed
 * through `@elyvel/notifications` so an application can queue it, log it, fake
 * it in a test, or replace any of the three by setting its own callback in
 * `config/auth.ts` — the provider only fills in what is not already there.
 *
 * The recipient is an anonymous notifiable rather than a model. At this point
 * there may be no model: a reset is requested by email address, and better-auth
 * owns the user row.
 */
export function authMailHooks(options: MailHookOptions) {
  const { notifier, appName, resetExpiresIn } = options

  const to = (user: AuthUser) => notifier.route('mail', user.email)

  const data = (user: AuthUser, url: string, token: string) => ({
    url,
    token,
    name: user.name ?? undefined,
    appName
  })

  return {
    async sendResetPassword({ user, url, token }: MailHookArgs): Promise<void> {
      await notifier.send(
        to(user),
        new ResetPasswordNotification({ ...data(user, url, token), expiresIn: resetExpiresIn })
      )
    },

    async sendVerificationEmail({ user, url, token }: MailHookArgs): Promise<void> {
      await notifier.send(to(user), new VerifyEmailNotification(data(user, url, token)))
    },

    /**
     * The confirmation for a change of address, delivered to the old one.
     *
     * `user` here is the account as it stands and `newEmail` is where it is being
     * asked to go — the two must not be swapped, or the mail that guards the change
     * goes to whoever is trying to make it.
     */
    async sendChangeEmailConfirmation({
      user,
      newEmail,
      url,
      token
    }: MailHookArgs & { newEmail: string }): Promise<void> {
      await notifier.send(
        to(user),
        new ChangeEmailNotification({ ...data(user, url, token), newEmail })
      )
    },

    /**
     * After a reset succeeds — not part of the flow, and the point of it.
     *
     * A reset the account's owner did not perform is exactly when they need to
     * hear from us, and the address that was just used is the only channel left.
     */
    async onPasswordReset({ user }: { user: AuthUser }): Promise<void> {
      await notifier.send(
        to(user),
        new PasswordChangedNotification({ name: user.name ?? undefined, appName })
      )
    }
  }
}

/** Config shapes the provider merges into. */
type EmailAndPassword = Record<string, unknown> & { resetPasswordTokenExpiresIn?: number }
type EmailVerification = Record<string, unknown>

/**
 * Fill in the mail callbacks the application did not write itself.
 *
 * Merged rather than assigned, and only where the key is absent: an application
 * that wrote its own `sendResetPassword` has said what it wants, and quietly
 * replacing it would send two different emails or none.
 */
export function withAuthMail(
  options: Record<string, unknown>,
  hooks: ReturnType<typeof authMailHooks>
): Record<string, unknown> {
  const emailAndPassword = { ...((options.emailAndPassword as EmailAndPassword) ?? {}) }
  const emailVerification = { ...((options.emailVerification as EmailVerification) ?? {}) }

  /**
   * Only when credentials are actually enabled.
   *
   * With `emailAndPassword.enabled` off there is no password to reset, and adding
   * the callback would advertise a flow whose endpoints answer 400.
   */
  if (emailAndPassword.enabled === true) {
    emailAndPassword.sendResetPassword ??= hooks.sendResetPassword
    emailAndPassword.onPasswordReset ??= hooks.onPasswordReset
  }

  emailVerification.sendVerificationEmail ??= hooks.sendVerificationEmail

  const merged: Record<string, unknown> = { ...options, emailVerification }

  /**
   * Only when the application turned changing an address on.
   *
   * better-auth reads `user.changeEmail.enabled` to decide whether `/change-email`
   * exists at all; writing the callback into an absent block would leave a mailer
   * attached to an endpoint that answers 404.
   */
  const user = { ...((options.user as Record<string, unknown>) ?? {}) }
  const changeEmail = { ...((user.changeEmail as Record<string, unknown>) ?? {}) }

  if (changeEmail.enabled === true) {
    changeEmail.sendChangeEmailConfirmation ??= hooks.sendChangeEmailConfirmation
    user.changeEmail = changeEmail
    merged.user = user
  }

  // An empty `emailAndPassword` is left off entirely rather than added as `{}`:
  // better-auth reads the key's presence in places, and an application that never
  // asked for credentials should look exactly as it did.
  if (Object.keys(emailAndPassword).length > 0) merged.emailAndPassword = emailAndPassword

  return merged
}
