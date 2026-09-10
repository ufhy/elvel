import { describe, expect, test } from 'bun:test'
import { entryTypes } from '../src/entry-type.ts'
import { labelFor, methodTone, SECTIONS, statusTone, timeAgo } from '../src/http/views/ui.ts'

describe('badge tones', () => {
  test('a status takes Telescope requestStatusClass', () => {
    expect(statusTone(0)).toBe('danger')
    expect(statusTone(200)).toBe('success')
    expect(statusTone(302)).toBe('info')
    expect(statusTone(404)).toBe('warning')
    expect(statusTone(500)).toBe('danger')
  })

  test('a verb takes Telescope requestMethodClass', () => {
    expect(methodTone('GET')).toBe('secondary')
    expect(methodTone('OPTIONS')).toBe('secondary')
    expect(methodTone('POST')).toBe('info')
    expect(methodTone('PUT')).toBe('info')
    expect(methodTone('PATCH')).toBe('info')
    expect(methodTone('DELETE')).toBe('danger')
  })
})

describe('timeAgo', () => {
  const now = new Date('2026-09-11T12:00:00Z')
  const ago = (seconds: number) =>
    timeAgo(new Date(now.getTime() - seconds * 1000).toISOString(), now)

  /**
   * A list is scanned for "just now" and "yesterday", not read for a clock
   * reading — which is why the exact time goes in the `title` instead.
   */
  test('reads as a person would say it', () => {
    expect(ago(5)).toBe('just now')
    expect(ago(90)).toBe('2 minutes ago')
    expect(ago(3600)).toBe('1 hour ago')
    expect(ago(7200)).toBe('2 hours ago')
    expect(ago(86_400 * 3)).toBe('3 days ago')
    expect(ago(86_400 * 40)).toBe('1 month ago')
    expect(ago(86_400 * 400)).toBe('1 year ago')
  })

  test('accepts the space-separated form the database stores', () => {
    expect(timeAgo('2026-09-11 11:58:00', now)).toBe('2 minutes ago')
  })

  test('a clock skew reads as now rather than as the future', () => {
    expect(timeAgo('2026-09-11T12:00:30Z', now)).toBe('just now')
  })

  test('nothing and nonsense do not throw', () => {
    expect(timeAgo(undefined, now)).toBe('')
    expect(timeAgo('not a date', now)).toBe('not a date')
  })
})

describe('the sidebar', () => {
  /**
   * Telescope's order, not alphabetical: what a request ran comes first, the
   * rest below a separator. Held here because "sorted" is the change somebody
   * makes without noticing it was a decision.
   */
  test('is grouped the way Telescope groups it', () => {
    expect(SECTIONS[0]?.types).toEqual(['request', 'command', 'schedule', 'job'])
    expect(SECTIONS[1]?.types[0]).toBe('batch')
  })

  test('names every entry type exactly once', () => {
    const listed = SECTIONS.flatMap((section) => section.types)

    expect([...listed].sort()).toEqual([...entryTypes()].sort())
    expect(new Set(listed).size).toBe(listed.length)
  })

  test('every type has a label a person would recognise', () => {
    expect(labelFor('client_request')).toBe('HTTP Client')
    expect(labelFor('schedule')).toBe('Schedule')

    for (const type of entryTypes()) {
      expect(labelFor(type)).not.toBe('')
      expect(labelFor(type)[0]).toBe(labelFor(type)[0]?.toUpperCase())
    }
  })
})
