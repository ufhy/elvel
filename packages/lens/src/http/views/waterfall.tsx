import type { EntryResult } from '../../entry-result.ts'
import { EntryType } from '../../entry-type.ts'
import { cellsFor } from './columns.ts'
import { labelFor } from './ui.ts'

export type WaterfallProps = {
  path: string
  /** Every entry in the batch, the subject included. */
  batch: EntryResult[]
  /** Which one is being viewed, so it can be marked. */
  current: string
}

type Bar = {
  entry: EntryResult
  /** Milliseconds from the start of the unit of work. */
  offset: number
  /** How long it took, when the entry knows. */
  duration: number
  /** Percentages, for the bar's position and width. */
  left: number
  width: number
  summary: string
  /** How many identical neighbours were folded into this one. */
  repeats: number
}

/**
 * Where the time went, as a bar per entry.
 *
 * Telescope lists the related entries and stops there, which answers "what else
 * happened" but not the question people actually arrive with — *what took the
 * time*. Twelve identical queries in a row, or one external call holding
 * everything up, are obvious on an axis and invisible in a list.
 *
 * It needs one thing the recorder now provides: `offsetMs`, stamped when an
 * entry is recorded. `created_at` cannot serve — it is stored to the second, so
 * every entry in a batch carries the same value. Entries recorded before that
 * existed have no offset and fall back to a plain ordered list rather than
 * pretending to a position.
 */
export function Waterfall({ path, batch, current }: WaterfallProps) {
  const bars = layout(batch)

  /**
   * Untimed entries still get a list.
   *
   * The first version returned a message and nothing else, which lost the
   * summaries an older batch could still show — a regression a test caught.
   * A missing axis is a reason to draw no bars, not a reason to say nothing.
   */
  if (bars === undefined) {
    return (
      <div class="fall">
        <p class="fall-note">Recorded before Lens timed entries, so there is no axis.</p>

        {batch.map((entry) => (
          <a
            class={entry.uuid === current ? 'fall-row bare here' : 'fall-row bare'}
            href={`/${path}/${entry.type}/${entry.uuid}`}
          >
            <span class="fall-type" safe>
              {labelFor(entry.type)}
            </span>
            <span class="fall-what" title={summarise(entry)} safe>
              {summarise(entry)}
            </span>
          </a>
        ))}
      </div>
    )
  }

  const total = Math.max(...bars.map((bar) => bar.offset + bar.duration), 1)
  const repeated = bars.filter((bar) => bar.repeats > 1)

  return (
    <div class="fall">
      {repeated.length === 0 ? null : (
        <p class="fall-warn" safe>
          {`${String(repeated.reduce((sum, bar) => sum + bar.repeats, 0))} of these ran the same ` +
            `${repeated.length === 1 ? 'statement' : 'statements'} back to back — the shape of an N+1.`}
        </p>
      )}

      <div class="fall-scale">
        <span>0</span>
        <span safe>{`${String(Math.round(total / 2))}ms`}</span>
        <span safe>{`${String(Math.round(total))}ms`}</span>
      </div>

      {bars.map((bar) => (
        <a
          class={bar.entry.uuid === current ? 'fall-row here' : 'fall-row'}
          href={`/${path}/${bar.entry.type}/${bar.entry.uuid}`}
        >
          <span class="fall-type" safe>
            {labelFor(bar.entry.type)}
          </span>

          <span class="fall-track">
            <span
              class={`fall-bar t-${bar.entry.type}`}
              style={`left:${bar.left.toFixed(2)}%;width:${bar.width.toFixed(2)}%`}
            />
          </span>

          <span class="fall-ms" safe>
            {bar.duration === 0 ? '' : `${formatMs(bar.duration)}ms`}
          </span>

          {bar.repeats > 1 ? (
            <span class="fall-times" safe>
              {`×${String(bar.repeats)}`}
            </span>
          ) : (
            <span class="fall-times" />
          )}

          <span class="fall-what" title={bar.summary} safe>
            {bar.summary}
          </span>
        </a>
      ))}
    </div>
  )
}

/** Nothing to draw unless at least one entry knows where it sat. */
function layout(batch: EntryResult[]): Bar[] | undefined {
  const timed = batch.filter((entry) => typeof entry.content.offsetMs === 'number')

  if (timed.length === 0) return undefined

  const measured = timed.map((entry) => ({
    entry,
    offset: Number(entry.content.offsetMs ?? 0),
    duration: durationOf(entry)
  }))

  /**
   * A request's own bar spans the whole unit of work.
   *
   * It is recorded last — the response has to exist first — so its offset is
   * the end, not the beginning, and drawing it there would put the longest bar
   * in the wrong place entirely.
   */
  for (const bar of measured) {
    if (bar.entry.type === EntryType.REQUEST) bar.offset = 0
  }

  const total = Math.max(...measured.map((bar) => bar.offset + bar.duration), 1)

  const ordered = measured
    .sort((a, b) => a.offset - b.offset || a.duration - b.duration)
    .map((bar) => ({ ...bar, summary: summarise(bar.entry), repeats: 1 }))

  return fold(ordered).map((bar) => ({
    ...bar,
    left: (bar.offset / total) * 100,
    // A floor, so an instantaneous entry is still something to aim at.
    width: Math.max((bar.duration / total) * 100, 0.6)
  }))
}

/**
 * Collapse identical neighbours into one bar with a count.
 *
 * This is the N+1 made visible. Twelve rows reading the same statement are
 * twelve bars nobody counts; one bar reading `×12` is the bug, stated. Only
 * *adjacent* entries are folded — the timeline has to stay honest about order,
 * and two identical statements with something between them are not the same
 * event as two in a row.
 *
 * The folded bar spans from the first start to the last end, so the width still
 * says how long the whole run took.
 */
function fold(bars: Array<Omit<Bar, 'left' | 'width'>>): Array<Omit<Bar, 'left' | 'width'>> {
  const folded: Array<Omit<Bar, 'left' | 'width'>> = []

  for (const bar of bars) {
    const last = folded.at(-1)

    if (last !== undefined && last.entry.type === bar.entry.type && last.summary === bar.summary) {
      last.repeats++
      last.duration = Math.max(last.duration, bar.offset + bar.duration - last.offset)

      continue
    }

    folded.push({ ...bar })
  }

  return folded
}

function durationOf(entry: EntryResult): number {
  const content = entry.content

  for (const key of ['duration', 'time']) {
    const value = content[key]

    if (typeof value === 'number') return value
    if (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value))) {
      return Number(value)
    }
  }

  return 0
}

/** Trailing zeroes help nobody: `0.13ms`, `12ms`. */
function formatMs(value: number): string {
  return value < 10 ? String(Math.round(value * 100) / 100) : String(Math.round(value))
}

function summarise(entry: EntryResult): string {
  const line = cellsFor(entry.type, entry.content)
    .slice(0, 2)
    .map((cell) => cell.text)
    .filter((value) => value !== '' && value !== '-')
    .join(' ')

  return line.length <= 90 ? line : `${line.slice(0, 89)}…`
}
