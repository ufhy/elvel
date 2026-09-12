import { Session } from 'node:inspector/promises'

/** One function, and what it actually cost. */
export type Hot = {
  name: string
  file: string
  line: number
  /** Samples in which this function was on top of the stack. */
  self: number
  /** Milliseconds it was on top of the stack, from the profile's own clock. */
  selfMs: number
  /** Milliseconds it or anything it called was running. */
  totalMs: number
}

export type Profile = {
  /** Milliseconds the profiler was running, as the profiler measured it. */
  durationMs: number
  samples: number
  /**
   * Milliseconds the runtime spent outside application code — idle waiting for
   * work, the collector, the engine itself.
   *
   * Reported rather than hidden, and kept out of {@link hot}: sampling begins
   * when the profiler is armed and a request arrives some moment later, so the
   * idle in between is usually the largest single number in the profile. Left in
   * the list it would bury every real function; left out silently it would make
   * the parts not add up.
   */
  outsideMs: number
  hot: Hot[]
}

/**
 * A CPU profile of one request, taken from inside the process.
 *
 * This is the capability that has no equivalent in the tools Lens is shaped
 * after. Telescope, Debugbar and Clockwork can all tell you a request took
 * 900ms and that 40ms of it was the database; none of them can tell you where
 * the other 860ms went, because PHP cannot profile itself without Xdebug and a
 * separate UI. Bun can: `node:inspector`'s Profiler is available in-process, so
 * arming this makes the next request answer the question directly.
 *
 * **The profiler is process-wide.** It samples whatever the runtime is doing,
 * so a request served concurrently with the armed one lands in the same profile.
 * That is a real limitation and the reason this is armed by hand for one request
 * rather than left running: in development there is usually one request at a
 * time, and the alternative — pretending the samples belong to one request when
 * they might not — would be worse than saying so.
 */
export class RequestProfiler {
  private session: Session | undefined

  private running = false

  private startedAt = 0

  /** The batch that claimed this run, once one has. */
  private owner: string | undefined

  /**
   * Start sampling now, and let the next request claim the result.
   *
   * Starting at *arm* time rather than when the request arrives is the only
   * shape that works. `onRequest` has to stay synchronous — it is where the
   * request context is entered — and `Profiler.start` is a round trip over the
   * inspector session, so a fire-and-forget start would miss the whole of a fast
   * request and produce an empty profile. Sampling from here instead means the
   * profile also covers the idle moment before the request arrives, which costs
   * nothing: an idle runtime produces no samples.
   */
  async arm(): Promise<boolean> {
    if (this.running) return true

    try {
      if (this.session === undefined) {
        this.session = new Session()
        this.session.connect()
        await this.session.post('Profiler.enable')
      }

      await this.session.post('Profiler.start')

      this.running = true
      this.owner = undefined
      this.startedAt = performance.now()

      return true
    } catch {
      this.session = undefined

      return false
    }
  }

  /**
   * Claim the running profile for this unit of work. Synchronous, so it can be
   * called from `onRequest` beside everything else that has to be.
   */
  claim(batchId: string): boolean {
    if (!this.running || this.owner !== undefined) return false

    this.owner = batchId

    return true
  }

  /** Whether a profile is running and still unclaimed. */
  isArmed(): boolean {
    return this.running && this.owner === undefined
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * Stop and reduce, for the batch that claimed it. Otherwise nothing.
   *
   * `windowMs` is how long the request took, and it is what makes the numbers
   * mean anything: sampling starts when the profiler is armed and the request
   * arrives whenever somebody reloads, so most of the recording is idle. Samples
   * older than the window are not this request's and are dropped.
   */
  async end(batchId: string, windowMs?: number): Promise<Profile | undefined> {
    if (!this.running || this.session === undefined || this.owner !== batchId) return undefined

    this.running = false
    this.owner = undefined

    try {
      const answer = (await this.session.post('Profiler.stop')) as { profile: RawProfile }

      return reduce(answer.profile, performance.now() - this.startedAt, windowMs)
    } catch {
      return undefined
    }
  }
}

type RawNode = {
  id: number
  hitCount?: number
  children?: number[]
  callFrame: { functionName?: string; url?: string; lineNumber?: number }
}

type RawProfile = {
  nodes: RawNode[]
  samples?: number[]
  /** Microseconds between each sample and the one before it. */
  timeDeltas?: number[]
  startTime?: number
  endTime?: number
}

/**
 * A sampled call tree, flattened to the twenty functions worth reading.
 *
 * A flamegraph is the famous shape and the wrong one at thirty pixels tall. What
 * answers "why was this slow" is self time, sorted — the flamegraph is how you
 * find that number when you have a screen for it, and the dashboard is where
 * that belongs.
 */
export function reduce(profile: RawProfile, fallbackMs: number, windowMs?: number): Profile {
  const byId = new Map<number, RawNode>()

  for (const node of profile.nodes) byId.set(node.id, node)

  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []

  /**
   * Only the samples belonging to the request, clipped to its own window.
   *
   * Without this the idle between arming and the reload is charged to whatever
   * function the sampler happened to wake up inside — measured: 414ms of a 5ms
   * request attributed to `map`, which is not a number anybody should act on.
   * The engine's own timestamps make the window exact rather than guessed, and
   * the sample that straddles the boundary contributes only its overlap.
   */
  const opens = openedAt(profile, windowMs)

  /**
   * Microseconds per sample, from the profile itself.
   *
   * The first version divided wall-clock time evenly across samples, and it was
   * wrong by three orders of magnitude: a profile armed six seconds before a
   * 6ms request has five samples, so every function came out at 1.26 seconds.
   * `timeDeltas` is what the engine actually measured between one sample and the
   * next — the 300ms of idle is one 302774µs delta, not a share of everything.
   */
  const selfUs = new Map<number, number>()
  const selfHits = new Map<number, number>()

  let at = profile.startTime ?? 0

  for (let index = 0; index < samples.length; index++) {
    const id = samples[index] as number
    const delta = deltas[index] ?? 0
    const before = at

    at += delta

    if (at < opens) continue

    selfUs.set(id, (selfUs.get(id) ?? 0) + Math.min(delta, at - Math.max(before, opens)))
    selfHits.set(id, (selfHits.get(id) ?? 0) + 1)
  }

  /**
   * Total time: self plus everything below. Walked from the leaves up rather
   * than recursing down, so a deep recursive stack cannot overflow it.
   */
  const totalUs = new Map<number, number>(selfUs)
  const parents = new Map<number, number>()

  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id)
  }

  for (const [id, cost] of selfUs) {
    let at = parents.get(id)
    let guard = 0

    while (at !== undefined && guard++ < 1000) {
      totalUs.set(at, (totalUs.get(at) ?? 0) + cost)
      at = parents.get(at)
    }
  }

  const hot: Hot[] = []
  let outsideUs = 0

  for (const [id, cost] of selfUs) {
    const node = byId.get(id)

    if (node === undefined) continue

    /**
     * A frame credited no time is not a row. The sample straddling the start of
     * the window contributes its overlap, which for one that ends exactly on the
     * boundary is nothing at all.
     */
    if (cost <= 0) continue

    const name = node.callFrame.functionName

    if (name === undefined || name === '' || SYNTHETIC.has(name)) {
      outsideUs += cost

      continue
    }

    hot.push({
      name,
      file: node.callFrame.url ?? '',
      // Both engines count lines from zero here; every editor counts from one.
      line: (node.callFrame.lineNumber ?? 0) + 1,
      self: selfHits.get(id) ?? 0,
      selfMs: ms(cost),
      totalMs: ms(totalUs.get(id) ?? cost)
    })
  }

  const whole =
    profile.startTime !== undefined && profile.endTime !== undefined
      ? (profile.endTime - profile.startTime) / 1000
      : fallbackMs
  const measured = windowMs === undefined ? whole : Math.min(whole, windowMs)

  return {
    durationMs: Math.round(measured * 100) / 100,
    samples: samples.length,
    outsideMs: ms(outsideUs),
    hot: hot.sort((a, b) => b.selfMs - a.selfMs).slice(0, 20)
  }
}

/**
 * When the window this profile is about begins, in the engine's own clock.
 *
 * `Profiler.stop` is called immediately after the response, so `endTime` is
 * effectively the end of the request and the window is measured back from
 * there. Without a window everything from arming onwards counts.
 */
function openedAt(profile: RawProfile, windowMs?: number): number {
  if (windowMs === undefined || profile.endTime === undefined) return -Infinity

  return profile.endTime - windowMs * 1000
}

/**
 * Frames the engine invents. Real time, but not a function anybody wrote.
 *
 * An anonymous *application* function is not in here — it is named
 * `(anonymous)` further up, keeps its file and line, and is worth showing.
 */
const SYNTHETIC = new Set(['(root)', '(program)', '(idle)', '(garbage collector)'])

function ms(microseconds: number): number {
  return Math.round((microseconds / 1000) * 100) / 100
}
