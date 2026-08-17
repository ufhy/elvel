import { afterEach, describe, expect, test as it } from 'bun:test'
import { decrypt, decryptString, encrypt, encryptString } from '@elyvel/encryption'
import { EventFake, events } from '@elyvel/events'
import { hash } from '@elyvel/hashing'
import { notifications } from '@elyvel/notifications'
import { storage } from '@elyvel/storage'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * The services an application reaches for without a request in hand.
 *
 * Each of these has a fake, and using it is the point: a storage test that wrote
 * to the real disk leaves files behind, and a notification test that did not
 * fake would send email from a test run. The fake is undone in `afterEach`
 * every time — one left in place makes the next file's assertions vacuous.
 */
/** The real dispatcher, put back after a test swaps a fake in for it. */
const realEvents = app.make('events')

afterEach(() => {
  storage().restore()
  notifications().restore()
  app.instance('events', realEvents)
})

describe('storage', () => {
  it('a faked disk records without touching the filesystem', async () => {
    const disk = storage().fake()

    await disk.put('reports/january.csv', 'a,b,c')

    disk.assertExists('reports/january.csv').assertContents('reports/january.csv', 'a,b,c')
    disk.assertMissing('reports/february.csv')
  })

  /**
   * "A file was stored" is rarely the question.
   *
   * `assertExists` passes for code that wrote an empty file, which is the actual
   * failure when an upload stream is consumed before it is saved.
   */
  it('and the contents are what is worth asserting', async () => {
    const disk = storage().fake()

    await disk.put('invoice.pdf', 'PDF-BYTES')

    expect(() => disk.assertContents('invoice.pdf', 'something else')).toThrow()
  })

  it('directories and counts', async () => {
    const disk = storage().fake()

    await disk.put('exports/one.csv', 'x')
    await disk.put('exports/two.csv', 'x')

    disk.assertCount('exports', 2).assertDirectoryEmpty('archive')
    expect(await disk.directoryExists('exports')).toBe(true)
  })
})

describe('notifications', () => {
  /**
   * Faked, nothing is delivered and the assertion reads what would have been.
   *
   * The recipient is asserted as well as the notification: "a welcome mail was
   * sent" is true of a run that sent it to the wrong person, and that is the
   * failure worth catching.
   */
  it('records who would have been notified, and with what', async () => {
    const fake = notifications().fake()
    const { VerifyEmailNotification } = await import('@elyvel/auth')

    const recipient = notifications().route('mail', 'ada@example.com')

    await notifications().send(
      recipient,
      new VerifyEmailNotification({ url: 'https://example.test/verify', token: 't' })
    )

    fake.assertSentTo(recipient, 'VerifyEmailNotification')
    fake.assertNotSentTo(recipient, 'ResetPasswordNotification')
  })
})

describe('encryption', () => {
  it('round-trips a value, and the ciphertext is not the value', () => {
    const payload = encryptString('a secret')

    expect(payload).not.toContain('a secret')
    expect(decryptString(payload)).toBe('a secret')
  })

  it('and carries structure, not only strings', () => {
    const payload = encrypt({ id: 7, roles: ['admin'] })

    expect(decrypt<{ id: number; roles: string[] }>(payload)).toEqual({ id: 7, roles: ['admin'] })
  })

  /**
   * Two encryptions of the same value differ.
   *
   * A deterministic ciphertext leaks equality: an attacker who sees two rows
   * with the same encrypted value knows they hold the same plaintext, without
   * ever decrypting either. `blindIndex` is the deliberate exception, for the
   * case where a column has to be searchable.
   */
  it('the same value encrypts differently every time', () => {
    expect(encryptString('same')).not.toBe(encryptString('same'))
  })

  it('and tampering is detected rather than decrypted into rubbish', () => {
    const payload = encryptString('a secret')
    const tampered = `${payload.slice(0, -4)}AAAA`

    expect(() => decryptString(tampered)).toThrow()
  })
})

describe('hashing', () => {
  it('verifies a password it made, and refuses one it did not', async () => {
    const hashed = await hash().make('longenough1')

    expect(await hash().check('longenough1', hashed)).toBe(true)
    expect(await hash().check('not-the-password', hashed)).toBe(false)
  })

  it('and two hashes of one password differ, because of the salt', async () => {
    expect(await hash().make('same')).not.toBe(await hash().make('same'))
  })
})

describe('events', () => {
  /**
   * The fake is bound in place of the dispatcher, not asked of it.
   *
   * `EventFake` is a `Dispatcher` that records instead of calling listeners, so
   * swapping it into the container is the whole mechanism — and the reason
   * `afterEach` puts the real one back.
   */
  const faked = (): EventFake => {
    const fake = new EventFake()
    app.instance('events', fake as never)

    return fake
  }

  it('records instead of running listeners', async () => {
    const fake = faked()

    await events().dispatch('order.shipped', { orderId: 7 })

    fake.assertDispatched('order.shipped')
    fake.assertNotDispatched('order.cancelled')
  })

  it('and how many times', async () => {
    const fake = faked()

    await events().dispatch('order.shipped', { orderId: 7 })
    await events().dispatch('order.shipped', { orderId: 8 })

    fake.assertDispatched('order.shipped', 2)
  })

  /**
   * The payload, not only the name.
   *
   * An event dispatched with the wrong id fires every listener correctly and
   * does the wrong thing, and a name-only assertion cannot tell.
   */
  it('and what was in it', async () => {
    const fake = faked()

    await events().dispatch('order.shipped', { orderId: 7 })

    expect(fake.dispatched('order.shipped')).toEqual([{ orderId: 7 }])
  })
})
