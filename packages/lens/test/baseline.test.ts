import { describe, expect, test } from 'bun:test'
import { Baselines } from '../src/bar/baseline.ts'
import { originOf, RequestProfiler, reduce } from '../src/bar/profiler.ts'

describe('what a route usually costs', () => {
  /**
   * The thing no PHP debug bar can do. PHP-FPM forgets everything between
   * requests, so "usually" is not a question it can answer; a Bun server is one
   * process and simply remembers.
   */
  test('a request is compared against the ones before it', () => {
    const baselines = new Baselines()

    for (const at of [10, 10, 10, 10]) baselines.record('/articles', at)

    const verdict = baselines.record('/articles', 80)

    expect(verdict.samples).toBe(5)
    expect(verdict.times).toBe(8)
  })

  /**
   * Measured against the median *before* this request, or a slow one is partly
   * compared against itself and the multiple comes out too small.
   */
  test('the first request of a route has nothing to compare to', () => {
    expect(new Baselines().record('/new', 40).times).toBeUndefined()
  })

  test('a rolling window, so it follows the code being edited', () => {
    const baselines = new Baselines(3)

    baselines.record('/x', 1000)
    baselines.record('/x', 10)
    baselines.record('/x', 10)
    baselines.record('/x', 10)

    const [cost] = baselines.costs()

    expect(cost).toMatchObject({ route: '/x', samples: 3, medianMs: 10, slowestMs: 10 })
  })

  test('costs are listed slowest first', () => {
    const baselines = new Baselines()

    baselines.record('/fast', 5)
    baselines.record('/slow', 500)

    expect(baselines.costs().map((cost) => cost.route)).toEqual(['/slow', '/fast'])
  })
})

describe('the CPU profile', () => {
  /**
   * Run for real, not stubbed: the whole claim of this feature is that Bun can
   * profile itself in-process, and a mocked inspector would prove nothing.
   */
  test('attributes time to the function that spent it', async () => {
    const profiler = new RequestProfiler()

    expect(await profiler.arm()).toBe(true)
    expect(profiler.isArmed()).toBe(true)
    expect(profiler.claim('batch-1')).toBe(true)
    expect(profiler.isArmed()).toBe(false)

    burnFor(200)

    const profile = await profiler.end('batch-1')

    expect(profile).toBeDefined()
    expect(profile?.samples).toBeGreaterThan(0)

    /**
     * Named in the profile — not pinned to the top of it.
     *
     * A sampling profiler reports where the samples landed, and which function
     * holds first place is a race with whatever else the runtime was doing:
     * `arm` came first on Windows CI, which is the profiler working rather than
     * failing. What the feature claims is that time reaches the function that
     * spent it, and that is what is asserted.
     */
    const burnt = profile?.hot.find((frame) => frame.name === 'burnFor')

    expect(burnt).toBeDefined()
    expect(burnt?.selfMs).toBeGreaterThan(0)
    // The profile's own clock, not a wall-clock guess spread across samples.
    expect(burnt?.selfMs).toBeLessThan((profile?.durationMs ?? 0) + 1)
  })

  test('only the batch that claimed it may end it', async () => {
    const profiler = new RequestProfiler()

    await profiler.arm()
    profiler.claim('mine')

    expect(await profiler.end('somebody else')).toBeUndefined()
    expect(await profiler.end('mine')).toBeDefined()
  })

  test('a second request cannot steal a claimed profile', async () => {
    const profiler = new RequestProfiler()

    await profiler.arm()

    expect(profiler.claim('first')).toBe(true)
    expect(profiler.claim('second')).toBe(false)

    await profiler.end('first')
  })

  test('ending without arming is nothing, not an error', async () => {
    expect(await new RequestProfiler().end('anything')).toBeUndefined()
  })

  /**
   * Both engines number the first line 0 here and every editor numbers it 1.
   * An off-by-one in a link is worse than no link.
   */
  test('line numbers are made one-based for the editor link', () => {
    const profile = reduce(
      {
        nodes: [{ id: 1, callFrame: { functionName: 'go', url: '/app/x.ts', lineNumber: 41 } }],
        samples: [1, 1],
        timeDeltas: [4000, 6000]
      },
      10
    )

    expect(profile.hot[0]).toMatchObject({ name: 'go', line: 42, self: 2, selfMs: 10 })
  })

  /**
   * The bug this replaced: wall-clock time divided evenly across samples. A
   * profile armed six seconds before a 6ms request has a handful of samples, so
   * every function came out at 1.26 seconds. `timeDeltas` is what the engine
   * measured, and the idle before the request is one enormous delta rather than
   * a share of everything.
   */
  test('a long idle before the work does not inflate the work', () => {
    const profile = reduce(
      {
        nodes: [
          { id: 1, callFrame: { functionName: '(idle)' } },
          { id: 2, callFrame: { functionName: 'handle', url: '/app/h.ts', lineNumber: 0 } }
        ],
        samples: [1, 2, 2],
        timeDeltas: [6_000_000, 2000, 3000],
        startTime: 0,
        endTime: 6_005_000
      },
      0
    )

    expect(profile.durationMs).toBe(6005)
    expect(profile.outsideMs).toBe(6000)
    expect(profile.hot).toHaveLength(1)
    expect(profile.hot[0]).toMatchObject({ name: 'handle', selfMs: 5 })
  })

  test('engine frames are counted as outside, not listed as functions', () => {
    const profile = reduce(
      {
        nodes: [
          { id: 1, callFrame: { functionName: '(garbage collector)' } },
          { id: 2, callFrame: { functionName: '(program)' } }
        ],
        samples: [1, 2],
        timeDeltas: [1000, 2000]
      },
      0
    )

    expect(profile.hot).toEqual([])
    expect(profile.outsideMs).toBe(3)
  })

  /** A nameless engine frame is time, but not a function anybody can go and fix. */
  test('a nameless frame is counted as outside rather than shown', () => {
    const profile = reduce(
      {
        nodes: [{ id: 1, callFrame: { functionName: '', url: '', lineNumber: 0 } }],
        samples: [1],
        timeDeltas: [0]
      },
      1
    )

    expect(profile.hot).toEqual([])
    expect(profile.outsideMs).toBe(0)
  })

  /**
   * Total time is summed by walking up from the leaves, with a guard, because a
   * sampled stack from a recursive function can be very deep and a recursive
   * walk would overflow before it finished.
   */
  test('a caller carries the time of everything below it', () => {
    const profile = reduce(
      {
        nodes: [
          { id: 1, children: [2], callFrame: { functionName: 'outer' } },
          { id: 2, callFrame: { functionName: 'inner' } }
        ],
        samples: [2, 2, 2],
        timeDeltas: [1000, 1000, 1000]
      },
      3
    )

    expect(profile.hot).toHaveLength(1)
    expect(profile.hot[0]).toMatchObject({ name: 'inner', self: 3, selfMs: 3, totalMs: 3 })
  })
})

/**
 * Busy work measured by the clock, not by an iteration count.
 *
 * A sampling profiler catches whatever it wakes up inside, and four million
 * square roots is a few milliseconds on a fast runner — few enough samples that
 * whether this frame appears at all was a coin flip. It came up both ways in
 * CI: on Windows another frame took first place, on macOS this one was missing
 * entirely. Two hundred milliseconds is hundreds of samples at any interval the
 * engine picks for itself.
 *
 * The clock is read once per block rather than per iteration, or reading it
 * would be the hot function instead of this one.
 */
function burnFor(ms: number): number {
  const until = Bun.nanoseconds() + ms * 1_000_000
  let total = 0
  let i = 0

  while (Bun.nanoseconds() < until) {
    for (let n = 0; n < 200_000; n += 1) {
      total += Math.sqrt(i)
      i += 1
    }
  }

  return total
}

describe('the profile is about the request, not about the wait', () => {
  /**
   * Measured on a real page before this existed: 414ms attributed to `map` on a
   * 5ms request. Sampling starts when the profiler is armed and the request
   * arrives whenever somebody reloads, so the idle in between was charged to
   * whichever function the sampler woke up inside.
   */
  test('samples older than the request window are dropped', () => {
    const profile = reduce(
      {
        nodes: [
          { id: 1, callFrame: { functionName: 'waiting', url: '/app/a.ts' } },
          { id: 2, callFrame: { functionName: 'handling', url: '/app/b.ts' } }
        ],
        // 400ms of idle woke up inside `waiting`, then 6ms of real work.
        samples: [1, 2, 2],
        timeDeltas: [400_000, 3000, 3000],
        startTime: 0,
        endTime: 406_000
      },
      0,
      6
    )

    expect(profile.durationMs).toBe(6)
    expect(profile.hot.map((hot) => hot.name)).toEqual(['handling'])
    expect(profile.hot[0]?.selfMs).toBe(6)
  })

  test('a sample straddling the boundary contributes only its overlap', () => {
    const profile = reduce(
      {
        nodes: [{ id: 1, callFrame: { functionName: 'work', url: '/app/a.ts' } }],
        samples: [1],
        timeDeltas: [100_000],
        startTime: 0,
        endTime: 100_000
      },
      0,
      10
    )

    expect(profile.hot[0]?.selfMs).toBe(10)
  })

  test('with no window given, the whole recording counts', () => {
    const profile = reduce(
      {
        nodes: [{ id: 1, callFrame: { functionName: 'work', url: '/app/a.ts' } }],
        samples: [1],
        timeDeltas: [50_000],
        startTime: 0,
        endTime: 50_000
      },
      0
    )

    expect(profile.hot[0]?.selfMs).toBe(50)
  })
})

describe('the profile says whose code it was', () => {
  /**
   * Twenty function names is a list to read; four origins is an answer to act
   * on. Order matters in `originOf`: a monorepo has the framework under
   * `packages/`, so the application's own root is checked last or every
   * framework file in this repository counts as the application's.
   */
  test('a frame is attributed to its owner', () => {
    const root = '/app'

    expect(originOf('/app/Http/Controllers/Page.ts', root)).toBe('your code')
    expect(originOf('/repo/packages/database/src/query/builder.ts', root)).toBe('@elvel/database')
    expect(originOf('/app/node_modules/@kitajs/html/index.js', root)).toBe('@kitajs/html')
    expect(originOf('/app/node_modules/picocolors/index.js', root)).toBe('picocolors')
    expect(originOf('internal:sql/query', root)).toBe('runtime')
    expect(originOf('', root)).toBe('runtime')
  })

  test('the profile groups every frame, not only the twenty shown', () => {
    const profile = reduce(
      {
        nodes: [
          { id: 1, callFrame: { functionName: 'a', url: '/app/one.ts' } },
          { id: 2, callFrame: { functionName: 'b', url: '/app/two.ts' } },
          { id: 3, callFrame: { functionName: 'c', url: '/repo/packages/http/src/x.ts' } }
        ],
        samples: [1, 2, 3],
        timeDeltas: [1000, 2000, 4000]
      },
      0,
      undefined,
      '/app'
    )

    expect(profile.origins).toEqual([
      { name: '@elvel/http', selfMs: 4, mine: false },
      { name: 'your code', selfMs: 3, mine: true }
    ])
  })
})
