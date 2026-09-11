import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import { EntryUpdate } from '../entry-update.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Records a job when it is dispatched, and patches it when it finishes.
 *
 * Recorded at **dispatch**, which is Telescope's choice and not an obvious one.
 * It puts the job in the batch of whatever queued it, so a request and the work
 * it handed off appear on one screen — and it is the reason the update channel
 * exists at all: a fast job can finish before the request that dispatched it has
 * flushed, so the patch arrives before the row it patches. The repository
 * reports those back rather than failing, and they are retried.
 *
 * The correlation key is `payload.uuid`, documented in `@elvel/queue` as *stable
 * identity across releases and retries*. Telescope has to inject one of its own
 * through `Queue::createPayloadUsing`; there is nothing to inject here.
 */
export class JobWatcher extends Watcher {
  register(app: ApplicationContract): void {
    const events = app.make('events')

    events.listen('queue.job.queued', (payload: Record<string, unknown>) => {
      this.recordQueued(app.make('lens'), payload)
    })

    events.listen('queue.job.processed', (payload: Record<string, unknown>) => {
      this.patch(app.make('lens'), payload, 'processed')
    })

    events.listen('queue.job.failed', (payload: Record<string, unknown>) => {
      this.patch(app.make('lens'), payload, 'failed')
    })

    events.listen('queue.job.released', (payload: Record<string, unknown>) => {
      this.patch(app.make('lens'), payload, 'released')
    })
  }

  private recordQueued(lens: Recorder, event: Record<string, unknown>): void {
    if (!lens.recording()) return

    const uuid = typeof event.uuid === 'string' ? event.uuid : undefined

    if (uuid === undefined) return

    const payload = (event.payload ?? {}) as Record<string, unknown>
    const name = String(event.job ?? '')

    if (this.option<string[]>('ignore', []).includes(name)) return

    /**
     * The entry's own uuid *is* the payload's.
     *
     * That is what lets the patch find it later without a second key: the worker
     * knows the payload uuid and nothing else about what was recorded.
     */
    lens.record(
      EntryType.JOB,
      new IncomingEntry(
        {
          status: 'pending',
          name,
          connection: event.connection ?? null,
          queue: event.queue ?? null,
          delay: event.delay ?? 0,
          tries: payload.maxTries ?? null,
          timeout: payload.timeout ?? null,
          /**
           * The job's constructor data is *not* recorded.
           *
           * Telescope records it, and it is the field most likely to hold an
           * email address, a token or a whole model. A job is identified by its
           * name and its uuid; reproducing one needs the data, understanding one
           * does not — the same trade the query watcher makes with bindings.
           */
          data: Object.keys((payload.data ?? {}) as Record<string, unknown>).length
        },
        uuid
      ).withTags([name])
    )
  }

  /**
   * Patch the entry the dispatcher recorded.
   *
   * Queued rather than written: the row may not exist yet, and that is normal
   * rather than an error — see the note on the class.
   */
  private patch(lens: Recorder, event: Record<string, unknown>, status: string): void {
    const uuid = typeof event.uuid === 'string' ? event.uuid : undefined

    if (uuid === undefined) return

    const update = new EntryUpdate(uuid, EntryType.JOB).change({
      status,
      attempts: event.attempts ?? null
    })

    if (status === 'failed') {
      update.addTags(['failed'])
      update.change({
        error: event.error instanceof Error ? event.error.message : String(event.error ?? '')
      })
    } else {
      update.removeTags(['failed'])
    }

    lens.recordUpdate(update)
  }
}
