import { describe, expect, test } from 'bun:test'
import { isUnlimited, Limit } from '../src/limit.ts'

describe('Limit', () => {
  test('the windows are what they say', () => {
    expect(Limit.perSecond(5).decaySeconds).toBe(1)
    expect(Limit.perMinute(5).decaySeconds).toBe(60)
    expect(Limit.perHour(5).decaySeconds).toBe(3600)
    expect(Limit.perDay(5).decaySeconds).toBe(86_400)
    expect(Limit.perMinute(5, 15).decaySeconds).toBe(900)
  })

  test('by() sets the subject and keeps the window', () => {
    const limit = Limit.perHour(100).by('user:7')

    expect(limit.key).toBe('user:7')
    expect(limit.maxAttempts).toBe(100)
    expect(limit.decaySeconds).toBe(3600)
  })

  test('a numeric subject is stringified', () => {
    expect(Limit.perMinute(1).by(7).key).toBe('7')
  })

  test('none() is recognisable, and stays so through by()', () => {
    expect(isUnlimited(Limit.none())).toBe(true)
    // An exemption said out loud: `by()` must not turn it back into a limit.
    expect(isUnlimited(Limit.none().by('user:7'))).toBe(true)
    expect(isUnlimited(Limit.perMinute(1))).toBe(false)
  })
})
