import { Application } from './application.ts'
import { CARRIES_RESPONSE } from './exceptions.ts'

/**
 * `dump()` and `dd()` — Symfony's helpers, not Laravel's.
 *
 * Worth saying plainly, because it is easy to assume otherwise: Laravel ships
 * neither. Its `composer.json` lists *"symfony/var-dumper: Required to use the
 * dd function"* and adds a `Dumpable` trait so an object can dump itself. The
 * behaviour below follows `symfony/var-dumper`'s `Resources/functions/dump.php`
 * wherever the runtime allows.
 *
 * The one place it cannot follow is the ending, and the reason is the same one
 * that keeps Lens from recording a per-request memory figure. Symfony's `dd()`
 * calls `exit(1)`, which is correct under PHP-FPM because **the process is the
 * request**. Bun's process is the *server*: an `exit(1)` inside one request
 * would take down every other request in flight, and the server with them. So
 * `dd()` throws, and what it throws carries the page — which also gives the 500
 * status Symfony sets by hand before exiting.
 */

/** A formatted value, ready to print or record. */
export type DumpedValue = {
  /** `1`, `2`, … when several values were dumped at once, as Symfony labels them. */
  label: string | undefined
  /** `Bun.inspect` output, without colour. */
  text: string
}

/** Where a dump was written, so the entry is worth reading later. */
export type DumpOrigin = { file: string; line: number } | undefined

export type DumpRecord = {
  values: DumpedValue[]
  origin: DumpOrigin
}

/** Symfony dumps a bug when nothing was passed, which answers "did this line run". */
const NOTHING = '🐛'

/**
 * Print the given values and give them back.
 *
 * Returning is Symfony's, and it is what makes the helper usable without taking
 * a statement apart: `const user = dump(await find(id))`. One value returns that
 * value; several return the array.
 */
export function dump<T>(value: T): T
export function dump<T extends unknown[]>(...values: T): T
export function dump(...values: unknown[]): unknown {
  const record = describe(values)

  write(record)
  announce(record)

  if (values.length === 0) return undefined
  if (values.length === 1) return values[0]

  return values
}

/**
 * Print the given values and stop.
 *
 * Throws rather than exiting — see the note at the top of this file. In a
 * request the handler renders what it carries; in a console command the kernel
 * reports it and the command ends with a non-zero code, which is the same
 * outcome `exit(1)` would have had there.
 */
export function dd(...values: unknown[]): never {
  const record = describe(values)

  write(record)
  announce(record)

  throw new DumpException(record)
}

/**
 * What `dd()` throws.
 *
 * Carries its own response, so the page a developer sees is the dump and not a
 * stack trace about a dump. Status 500, which is what Symfony sets on the way
 * out for the same reason: whatever was being built is not finished.
 */
export class DumpException extends Error {
  constructor(readonly record: DumpRecord) {
    super('Execution stopped by dd().')
    this.name = 'DumpException'
  }

  [CARRIES_RESPONSE](): Response {
    return new Response(page(this.record), {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  }
}

/** Format the values, and find where the call was made. */
function describe(values: unknown[]): DumpRecord {
  if (values.length === 0) {
    return { values: [{ label: undefined, text: NOTHING }], origin: originOf(new Error().stack) }
  }

  return {
    values: values.map((value, index) => ({
      // Labelled only when there is more than one, and from 1 — Symfony's `1 + $k`.
      label: values.length === 1 ? undefined : String(index + 1),
      text: Bun.inspect(value, { colors: false, depth: 6 })
    })),
    origin: originOf(new Error().stack)
  }
}

/** To the terminal, coloured when one is attached. */
function write(record: DumpRecord): void {
  const where = record.origin === undefined ? '' : ` ${record.origin.file}:${record.origin.line}`

  for (const value of record.values) {
    const head = value.label === undefined ? `↓ dump${where}` : `↓ dump ${value.label}${where}`

    console.log(head)
    console.log(value.text)
  }
}

/**
 * Tell whoever is listening, if anybody is.
 *
 * Guarded by `hasListeners`, so an application with no recorder pays nothing —
 * and wrapped, because a dump must never be the thing that breaks the code
 * somebody is in the middle of debugging.
 */
function announce(record: DumpRecord): void {
  try {
    const application = Application.getInstance()

    if (!application.bound('events' as never)) return

    const events = application.make('events' as never) as {
      dispatch(name: string, payload?: unknown): unknown
      hasListeners?(event: unknown): boolean
    }

    if (events.hasListeners?.('dump.captured') === false) return

    void events.dispatch('dump.captured', record)
  } catch {
    // No application, or no dispatcher. Printing already happened.
  }
}

/**
 * The first frame outside this file.
 *
 * A dump with no origin is `console.log` with extra steps: the whole difficulty
 * with scattered dumps is finding which one is talking.
 */
function originOf(stack: string | undefined): DumpOrigin {
  if (stack === undefined) return undefined

  for (const line of stack.split('\n').slice(1)) {
    const match = /\(?((?:\/|[A-Za-z]:\\)[^()]*?):(\d+):\d+\)?\s*$/.exec(line.trim())

    if (match === null) continue

    const [, file, number] = match

    if (file === undefined || number === undefined) continue
    if (file.includes('/core/src/dump.ts') || file.includes('node:')) continue

    return { file, line: Number(number) }
  }

  return undefined
}

/** The page `dd()` answers with. Plain, because it is read at a glance. */
function page(record: DumpRecord): string {
  const where =
    record.origin === undefined
      ? ''
      : `<p class="at">${escape(`${record.origin.file}:${String(record.origin.line)}`)}</p>`

  const blocks = record.values
    .map((value) => {
      const label = value.label === undefined ? '' : `<h2>${escape(value.label)}</h2>`

      return `${label}<pre>${escape(value.text)}</pre>`
    })
    .join('')

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>dd()</title><style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 32px; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
           background: #f3f4f6; color: #111827; }
    @media (prefers-color-scheme: dark) { body { background: #111827; color: #f3f4f6; } }
    h1 { font-size: 15px; margin: 0 0 4px; }
    h2 { font-size: 12px; color: #6b7280; margin: 18px 0 6px; font-weight: 600; }
    .at { color: #6b7280; font-size: 12px; margin: 0 0 18px; }
    pre { background: rgb(128 128 128 / 0.12); border-radius: 8px; padding: 14px; margin: 0 0 12px;
          overflow-x: auto; font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style></head><body><h1>Execution stopped by <code>dd()</code></h1>${where}${blocks}</body></html>`
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
