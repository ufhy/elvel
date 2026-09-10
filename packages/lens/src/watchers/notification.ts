import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/** Every outcome the sender reports, and the word for it. */
const OUTCOMES: Record<string, string> = {
  'notification.sent': 'sent',
  'notification.failed': 'failed',
  'notification.skipped': 'skipped'
}

/**
 * Records each notification, per channel, however it turned out.
 *
 * Telescope records only `NotificationSent`, because that is the only event
 * Laravel fires. Elvel's sender reports three, and the two extra are the
 * interesting ones: a notification that was **skipped** — by `shouldSend`, or
 * because the notifiable had no route for the channel — looks exactly like one
 * that was never dispatched, and that is a support question nobody can answer
 * from a table of successes.
 *
 * A notification usually goes out over several channels, and each is its own
 * entry: mail can succeed while a webhook fails, and one row per notification
 * would have to pick which of those to be.
 */
export class NotificationWatcher extends Watcher {
  register(app: ApplicationContract): void {
    for (const [event, outcome] of Object.entries(OUTCOMES)) {
      app.make('events').listen(event, (payload: Record<string, unknown>) => {
        this.record(app.make('lens'), outcome, payload)
      })
    }
  }

  private record(lens: Recorder, outcome: string, payload: Record<string, unknown>): void {
    if (!lens.recording()) return

    const notification = String(payload.notification ?? '')
    const content: Record<string, unknown> = {
      notification,
      channel: payload.channel ?? null,
      outcome
    }

    if (payload.id !== undefined && payload.id !== null) content.id = payload.id

    if (payload.error !== undefined && payload.error !== null) {
      content.error = payload.error instanceof Error ? payload.error.message : String(payload.error)
    }

    lens.record(
      EntryType.NOTIFICATION,
      IncomingEntry.make(content).withTags(notification === '' ? [] : [notification])
    )
  }
}
