import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { MailMessage } from '@elvel/notifications'
import { authMailHooks, withAuthMail } from '../src/mail-hooks.ts'
import {
  PasswordChangedNotification,
  ResetPasswordNotification,
  VerifyEmailNotification
} from '../src/notifications.ts'

type Sent = { to: unknown; notification: { constructor: { name: string } } }

const notifier = () => {
  const sent: Sent[] = []

  return {
    sent,
    route: (channel: string, destination: unknown) => ({ channel, destination }),
    send: async (to: unknown, notification: unknown) => {
      sent.push({ to, notification: notification as Sent['notification'] })
    }
  }
}

const ada = { email: 'ada@example.com', name: 'Ada' }

describe('the notifications themselves', () => {
  test('the reset mail carries the link and how long it lasts', () => {
    const message = new ResetPasswordNotification({
      url: 'https://app.test/reset?token=abc',
      token: 'abc',
      name: 'Ada',
      expiresIn: 3600,
      appName: 'Playground'
    }).toMail()

    const text = message.toText('Playground')

    expect<string>(message.subjectOr('')).toBe('Reset your Playground password')
    expect<boolean>(text.includes('Hello Ada!')).toBe(true)
    expect<boolean>(text.includes('https://app.test/reset?token=abc')).toBe(true)
    expect<boolean>(text.includes('expires in 1 hour')).toBe(true)
    // The person receiving this may not have asked for it, and saying so is what
    // keeps a mistyped address from becoming a support ticket.
    expect<boolean>(text.includes('no further action is required')).toBe(true)
  })

  test('an odd expiry is read in minutes', () => {
    const message = new ResetPasswordNotification({
      url: 'https://app.test/reset',
      token: 'abc',
      expiresIn: 900
    }).toMail()

    expect<boolean>(message.toText('App').includes('expires in 15 minutes')).toBe(true)
  })

  test('a user with no name still gets a greeting', () => {
    const message = new VerifyEmailNotification({ url: 'https://app.test/verify', token: 'x' })

    expect<boolean>(message.toMail().toText('App').includes('Hello!')).toBe(true)
  })

  test('the stored form never carries the token', () => {
    // A notification can be logged or written to the notifications table, and a
    // live reset token in either is a working key to the account.
    const stored = new ResetPasswordNotification({
      url: 'https://app.test/reset?token=abc',
      token: 'abc'
    }).toArray()

    expect<boolean>(JSON.stringify(stored).includes('abc')).toBe(false)
  })

  test('the password-changed warning is an error-level mail', () => {
    const message = new PasswordChangedNotification({ name: 'Ada' }).toMail()

    expect<string>(message.level).toBe('error')
    expect<boolean>(message.toText('App').includes('contact us immediately')).toBe(true)
  })
})

describe('the hooks better-auth is given', () => {
  test('a reset request mails the address that asked', async () => {
    const mail = notifier()
    const hooks = authMailHooks({ notifier: mail, appName: 'Playground' })

    await hooks.sendResetPassword({ user: ada, url: 'https://app.test/r', token: 't' })

    expect<number>(mail.sent.length).toBe(1)
    expect<unknown>(mail.sent[0]?.to).toEqual({ channel: 'mail', destination: 'ada@example.com' })
    expect<string | undefined>(mail.sent[0]?.notification.constructor.name).toBe(
      'ResetPasswordNotification'
    )
  })

  test('a completed reset warns the account owner', async () => {
    const mail = notifier()

    await authMailHooks({ notifier: mail }).onPasswordReset({ user: ada })

    expect<string | undefined>(mail.sent[0]?.notification.constructor.name).toBe(
      'PasswordChangedNotification'
    )
  })
  /**
   * The direction is the security property, so it is what the test asserts.
   *
   * The confirmation goes to the address already on file, not to the one being
   * asked for. Swapped, the mail that guards the change would go to whoever is
   * trying to make it — and the check would still pass on "a mail was sent".
   */
  test('a change of address is confirmed at the old one', async () => {
    const mail = notifier()

    await authMailHooks({ notifier: mail }).sendChangeEmailConfirmation({
      user: ada,
      newEmail: 'somebody-else@example.com',
      url: 'https://example.test/confirm',
      token: 'tok'
    })

    expect<string | undefined>(mail.sent[0]?.notification.constructor.name).toBe(
      'ChangeEmailNotification'
    )
    expect<unknown>((mail.sent[0] as Sent).to).toEqual({
      channel: 'mail',
      destination: ada.email
    })
  })
})

describe('merging into better-auth options', () => {
  const hooks = authMailHooks({ notifier: notifier() })

  test('the callbacks are filled in where credentials are enabled', () => {
    const merged = withAuthMail({ emailAndPassword: { enabled: true } }, hooks) as {
      emailAndPassword: Record<string, unknown>
      emailVerification: Record<string, unknown>
    }

    expect<string>(typeof merged.emailAndPassword.sendResetPassword).toBe('function')
    expect<string>(typeof merged.emailAndPassword.onPasswordReset).toBe('function')
    expect<string>(typeof merged.emailVerification.sendVerificationEmail).toBe('function')
  })

  test('the change-of-address mailer is filled in when that flow is on', () => {
    const merged = withAuthMail({ user: { changeEmail: { enabled: true } } }, hooks) as {
      user: { changeEmail: Record<string, unknown> }
    }

    expect<string>(typeof merged.user.changeEmail.sendChangeEmailConfirmation).toBe('function')
  })

  test('and left off when it is not', () => {
    // `/change-email` does not exist with `enabled` off; a mailer on it would be
    // attached to a 404.
    expect<unknown>((withAuthMail({}, hooks) as { user?: unknown }).user).toBeUndefined()
    expect<unknown>(
      (
        withAuthMail({ user: { changeEmail: { enabled: false } } }, hooks) as {
          user: { changeEmail: Record<string, unknown> }
        }
      ).user.changeEmail.sendChangeEmailConfirmation
    ).toBeUndefined()
  })

  test("an application's own callback is left alone", () => {
    // It has said what it wants; replacing it would send two different emails.
    const own = () => Promise.resolve()
    const merged = withAuthMail(
      { emailAndPassword: { enabled: true, sendResetPassword: own } },
      hooks
    ) as {
      emailAndPassword: Record<string, unknown>
    }

    expect<unknown>(merged.emailAndPassword.sendResetPassword).toBe(own)
  })

  test('with credentials off there is no password to reset', () => {
    const merged = withAuthMail({ emailAndPassword: { enabled: false } }, hooks) as {
      emailAndPassword: Record<string, unknown>
    }

    // Adding it would advertise a flow whose endpoint answers 400.
    expect<unknown>(merged.emailAndPassword.sendResetPassword).toBeUndefined()
  })

  test('an app that never asked for credentials keeps no empty key', () => {
    const merged = withAuthMail({ secret: 'x' }, hooks)

    expect<boolean>('emailAndPassword' in merged).toBe(false)
    expect<string>(typeof merged.secret).toBe('string')
  })

  /**
   * Writing the mail without taking over how it is sent — Laravel's `toMailUsing`.
   *
   * The only way in before this was to define `sendResetPassword` yourself in
   * `config/auth.ts`, which the framework leaves alone. That works and it is a lot:
   * the notifier call, the recipient, the expiry read — all rewritten to change a
   * greeting.
   *
   * Static, so it is set once in a provider at boot. The hook constructs these
   * notifications itself and hands them no options, so there is nowhere per-instance
   * for this to live.
   */
  test('an application can write the reset mail itself', () => {
    ResetPasswordNotification.toMailUsing((data) =>
      new MailMessage().subject('Pick a new password').line(`Go to ${data.url}`)
    )

    try {
      const message = new ResetPasswordNotification({
        url: 'https://example.com/reset?token=abc',
        token: 'abc',
        name: 'Ada'
      }).toMail()

      expect<string>(message.subjectOr('')).toBe('Pick a new password')
      expect<string>(message.toText('Elvel')).toContain('Go to https://example.com/reset')
      expect<boolean>(message.toText('Elvel').includes('You are receiving this email')).toBe(false)
    } finally {
      ResetPasswordNotification.mailUsing = undefined
    }
  })

  test('and the default is what answers once it is cleared', () => {
    const message = new ResetPasswordNotification({
      url: 'https://example.com/reset?token=abc',
      token: 'abc'
    }).toMail()

    expect<string>(message.toText('Elvel')).toContain('You are receiving this email')
  })

  /** Each notification carries its own, so setting one does not answer for another. */
  test('the four hooks are separate', () => {
    VerifyEmailNotification.toMailUsing(() => new MailMessage().subject('Confirm it'))

    try {
      expect<string>(
        new VerifyEmailNotification({ url: 'https://example.com/v', token: 't' })
          .toMail()
          .subjectOr('')
      ).toBe('Confirm it')

      expect<string>(
        new ResetPasswordNotification({ url: 'https://example.com/r', token: 't' })
          .toMail()
          .toText('Elvel')
      ).toContain('You are receiving this email')
    } finally {
      VerifyEmailNotification.mailUsing = undefined
    }
  })

  /**
   * The same mail in another language, which is Laravel's `Lang::get` carried over.
   *
   * The English is both the default and the lookup key: `@elvel/translation` accepts
   * a sentence as a key and answers the key itself when nothing matches, so an
   * application ships `lang/id.json` and its password-reset mail arrives in
   * Indonesian without this package changing.
   *
   * And it has to keep working with no translator at all — `@elvel/auth` does not
   * depend on the translation package, so a mail must send without it.
   */
  test('a registered translator changes the words', async () => {
    const app = new Application(process.cwd())

    app.instance(
      'translator' as never,
      {
        get: (key: string, replace: Record<string, unknown>) => {
          const dictionary: Record<string, string> = {
            'Reset password': 'Atur ulang kata sandi',
            'This link expires in :time.': 'Tautan ini kedaluwarsa dalam :time.'
          }

          const line = dictionary[key] ?? key

          return Object.entries(replace).reduce(
            (carry, [name, value]) => carry.replaceAll(`:${name}`, String(value)),
            line
          )
        }
      } as never
    )

    try {
      const text = new ResetPasswordNotification({
        url: 'https://example.com/r',
        token: 't',
        expiresIn: 3600
      })
        .toMail()
        .toText('Elvel')

      expect<string>(text).toContain('Atur ulang kata sandi')
      expect<string>(text).toContain('Tautan ini kedaluwarsa dalam 1 hour.')
      // Untranslated keys read as the English they already were.
      expect<string>(text).toContain('You are receiving this email')
    } finally {
      Application.setInstance(undefined as never)
    }
  })

  test('and with no translator the English is what sends', () => {
    const text = new ResetPasswordNotification({
      url: 'https://example.com/r',
      token: 't',
      expiresIn: 900
    })
      .toMail()
      .toText('Elvel')

    expect<string>(text).toContain('Reset password')
    expect<string>(text).toContain('This link expires in 15 minutes.')
  })
})

describe('the channels an auth notification goes out by', () => {
  /**
   * `['mail']` is the default and the only part of these an application can widen
   * without rewriting them. It is right for the link ones — a reset link nobody can
   * act on from an inbox row is not worth storing — and wrong for the warnings:
   * "your password changed" is exactly what somebody wants to find in the
   * application later.
   */
  test('is mail, until an application says otherwise', () => {
    expect<string[]>(new ResetPasswordNotification({ url: '', token: '' }).via()).toEqual(['mail'])

    PasswordChangedNotification.channels = ['mail', 'database']

    try {
      expect<string[]>(new PasswordChangedNotification({ name: 'Ada' }).via()).toEqual([
        'mail',
        'database'
      ])

      // And widening one leaves the others where they were.
      expect<string[]>(new VerifyEmailNotification({ url: '', token: '' }).via()).toEqual(['mail'])
    } finally {
      PasswordChangedNotification.channels = ['mail']
    }
  })

  /** What a stored row would hold — never the token. */
  test('and what the database channel would store carries no token', () => {
    const stored = new ResetPasswordNotification({
      url: 'https://app.test/reset?token=abc',
      token: 'abc'
    }).toArray()

    expect(stored).toEqual({ url: '[redacted]', kind: 'password-reset' })
  })
})
