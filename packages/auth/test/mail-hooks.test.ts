import { describe, expect, test } from 'bun:test'
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
})
