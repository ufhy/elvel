import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  bypassCookieIsValid,
  generateSecret,
  issueBypassCookie,
  MaintenanceMode
} from '../src/maintenance.ts'

const file = join(import.meta.dir, '.maintenance-probe', 'down')
let maintenance: MaintenanceMode

beforeEach(() => {
  maintenance = new MaintenanceMode(file)
})

afterEach(async () => {
  await rm(join(import.meta.dir, '.maintenance-probe'), { recursive: true, force: true })
})

describe('the down file', () => {
  test('an application is up until it is put down', async () => {
    expect(await maintenance.active()).toBe(false)

    await maintenance.activate({ since: 1, retry: 60 })

    expect(await maintenance.active()).toBe(true)
    expect((await maintenance.data())?.retry).toBe(60)
  })

  test('the directory is created if it is missing', async () => {
    // A fresh checkout has no storage/framework yet, and `down` must still work.
    await maintenance.activate({ since: 1 })

    expect(await maintenance.active()).toBe(true)
  })

  test('deactivate reports whether it did anything', async () => {
    expect(await maintenance.deactivate()).toBe(false)

    await maintenance.activate({ since: 1 })

    expect(await maintenance.deactivate()).toBe(true)
    expect(await maintenance.active()).toBe(false)
  })

  test('an unreadable file reads as no payload, not a crash', async () => {
    // A deploy can catch this file half-written; a request must not 500 over it.
    await Bun.write(file, '{ not json')

    expect(await maintenance.active()).toBe(true)
    expect(await maintenance.data()).toBeUndefined()
  })
})

describe('the bypass cookie', () => {
  test('a cookie it issued is valid', () => {
    const secret = generateSecret()

    expect(bypassCookieIsValid(issueBypassCookie(secret), secret)).toBe(true)
  })

  test('another secret does not open it', () => {
    expect(bypassCookieIsValid(issueBypassCookie('one'), 'another')).toBe(false)
  })

  test('the secret itself is never in the cookie', () => {
    const secret = 'a-memorable-phrase'
    const decoded = Buffer.from(issueBypassCookie(secret), 'base64url').toString()

    // What travels is a MAC over the expiry, so a stolen cookie is a temporary
    // problem rather than a permanent key.
    expect(decoded).not.toContain(secret)
    expect(JSON.parse(decoded)).toHaveProperty('mac')
  })

  test('a tampered MAC is refused', () => {
    const forged = Buffer.from(
      JSON.stringify({ expiresAt: 9_999_999_999, mac: 'deadbeef' })
    ).toString('base64url')

    expect(bypassCookieIsValid(forged, 'secret')).toBe(false)
  })

  test('an expired cookie is refused even with a good MAC', () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const secret = 'phrase'
    // Signed correctly, but for a moment that has passed.
    const signed = issueBypassCookie(secret)
    const payload = JSON.parse(Buffer.from(signed, 'base64url').toString()) as { mac: string }

    const expired = Buffer.from(JSON.stringify({ expiresAt: past, mac: payload.mac })).toString(
      'base64url'
    )

    expect(bypassCookieIsValid(expired, secret)).toBe(false)
  })

  test('rubbish is refused rather than throwing', () => {
    for (const value of ['', 'not-base64!', Buffer.from('{}').toString('base64url')]) {
      expect(bypassCookieIsValid(value, 'secret')).toBe(false)
    }

    expect(bypassCookieIsValid(undefined, 'secret')).toBe(false)
  })

  test('a generated secret is URL-safe and long enough', () => {
    const secret = generateSecret()

    expect(secret).toMatch(/^[0-9a-f]{32}$/)
  })
})
