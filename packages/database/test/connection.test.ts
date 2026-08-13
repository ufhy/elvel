import { describe, expect, test } from 'bun:test'
import { pickHost } from '../src/connection/manager.ts'

describe('choosing a replica', () => {
  test('a weight decides how often a host is picked', () => {
    const hosts = [
      { host: 'small', weight: 1 },
      { host: 'large', weight: 9 }
    ]

    const counts = new Map<string, number>()

    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const host = String(pickHost(hosts).host)
      counts.set(host, (counts.get(host) ?? 0) + 1)
    }

    // Replicas are rarely identical: sending half the traffic to the small one
    // is how the small one becomes the bottleneck. Loose bounds, because this
    // is random by design.
    expect<boolean>((counts.get('large') ?? 0) > (counts.get('small') ?? 0) * 3).toBe(true)
  })

  test('an unweighted list is uniform, as before', () => {
    const seen = new Set<string>()

    for (let attempt = 0; attempt < 200; attempt += 1) {
      seen.add(String(pickHost([{ host: 'a' }, { host: 'b' }]).host))
    }

    expect<number>(seen.size).toBe(2)
  })

  test('a zero weight drains a host out of the rotation', () => {
    const hosts = [
      { host: 'draining', weight: 0 },
      { host: 'live', weight: 1 }
    ]

    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect<string>(String(pickHost(hosts).host)).toBe('live')
    }
  })

  test('but draining every host reads anyway', () => {
    // A config that excludes everything is a mistake; an outage is worse.
    expect<boolean>(
      ['a', 'b'].includes(
        String(
          pickHost([
            { host: 'a', weight: 0 },
            { host: 'b', weight: 0 }
          ]).host
        )
      )
    ).toBe(true)
  })
})
