import { readFileSync } from 'node:fs'
import type { ApplicationContract } from '@elvel/contracts'
import { MessageLogged } from '@elvel/log'
import { type CallerFrame, callerFrom } from '../caller.ts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/** Lines of source shown either side of the failing line, as Telescope shows ten. */
const CONTEXT_LINES = 10

/**
 * Records exceptions, and folds repeats of the same one into a single row.
 *
 * Telescope listens for `MessageLogged` and treats any record carrying a
 * `Throwable` in its context as an exception rather than a log line. The same
 * event exists here and carries the same signal — `ExceptionHandler.report()`
 * logs at `error` with the stack in `context.stack` — but not the same thing:
 * what arrives is `exception: error.name` and `stack: error.stack`, two strings,
 * because `report()` does not put the object in the context.
 *
 * So the frames are parsed out of the stack instead of read off the object. What
 * that costs is `isReportableException()`, which needs the handler to ask, and
 * structured context beyond what was logged. What it keeps is everything the
 * dashboard shows: the class, the message, the failing file and line, the
 * surrounding source, and the family hash that makes five hundred occurrences
 * one row on the index.
 */
export class ExceptionWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen(MessageLogged, (event: MessageLogged) => {
      this.record(app.make('lens'), event)
    })
  }

  /** Does this record describe an exception rather than a log line? */
  static describesException(context: Record<string, unknown>): boolean {
    return typeof context.stack === 'string' && context.stack !== ''
  }

  private record(lens: Recorder, event: MessageLogged): void {
    if (!lens.recording()) return

    const context = event.context as Record<string, unknown>

    if (!ExceptionWatcher.describesException(context)) return

    const stack = String(context.stack)
    const frames = framesFrom(stack)
    const origin = callerFrom(stack, this.option<string[]>('ignorePaths', []))

    const content: Record<string, unknown> = {
      class: typeof context.exception === 'string' ? context.exception : 'Error',
      message: event.message,
      file: origin?.file ?? null,
      line: origin?.line ?? null,
      trace: frames,
      channel: event.channel
    }

    const preview = origin === undefined ? undefined : previewOf(origin)

    if (preview !== undefined) content.linePreview = preview

    lens.record(EntryType.EXCEPTION, IncomingEntry.make(content).withFamilyHash(familyHash(origin)))
  }
}

/**
 * Group occurrences of the same failure — Telescope's `md5(file . line)`.
 *
 * The message is left out deliberately, and it is the message that carries the
 * varying part: "user 41 not found" and "user 87 not found" are one bug. A hash
 * over the message would put each of them on the index as news.
 *
 * An exception with no application frame gets none, so it is never folded
 * together with an unrelated one that also has no frame.
 */
function familyHash(origin: CallerFrame | undefined): string | undefined {
  if (origin === undefined) return undefined

  return new Bun.CryptoHasher('md5').update(`${origin.file}${origin.line}`).digest('hex')
}

/** Every frame with a file and a line, in order, as `trace`. */
function framesFrom(stack: string): CallerFrame[] {
  const frames: CallerFrame[] = []

  for (const line of stack.split('\n').slice(1)) {
    const frame = callerFrom(`x\n${line}`, [])

    if (frame !== undefined) frames.push(frame)
  }

  return frames
}

/**
 * The ten lines either side of the failure, keyed by line number.
 *
 * Read synchronously, which is the one place this file does that. Telescope
 * reads the file at record time too, and the alternative here is worse: opening
 * a batch is synchronous, so an awaited read would have to mutate an entry
 * already queued and race the flush. An exception is rare and the file is
 * usually warm; a failure to read is simply no preview.
 */
function previewOf(origin: CallerFrame): Record<number, string> | undefined {
  try {
    const lines = readFileSync(origin.file, 'utf8').split('\n')
    const first = Math.max(0, origin.line - CONTEXT_LINES - 1)
    const preview: Record<number, string> = {}

    for (const [offset, text] of lines.slice(first, first + CONTEXT_LINES * 2).entries()) {
      preview[first + offset + 1] = text
    }

    return preview
  } catch {
    return undefined
  }
}
