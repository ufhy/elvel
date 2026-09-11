import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import { statusTone } from '../http/views/ui.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Records what the application asked of somebody else.
 *
 * The entry type most worth having on the timeline: an outbound call is usually
 * the slowest thing in a request, and it is the one thing a database trace
 * cannot show. A request that takes 900ms with one 850ms bar against another
 * service is a different problem from the same 900ms spread across forty
 * queries, and the waterfall says which at a glance.
 *
 * The response body is **not** recorded. Telescope keeps it up to a size limit;
 * an outbound response is somebody else's data arriving over a network the
 * application does not control, and a recorder is the wrong place for it by
 * default. The status, the timing and the host are what the question is usually
 * about.
 */
export class ClientRequestWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen('http.client.response', (payload: Record<string, unknown>) => {
      this.record(app.make('lens'), payload)
    })
  }

  private record(lens: Recorder, payload: Record<string, unknown>): void {
    if (!lens.recording()) return

    const attempt = payload.attempt as { method?: unknown; url?: unknown } | undefined
    const response = payload.response as { status?: unknown; body?: unknown } | undefined

    if (attempt === undefined) return

    const address = String(attempt.url ?? '')
    const host = hostOf(address)

    if (this.ignoredHosts().includes(host)) return

    const status = Number(response?.status ?? 0)

    lens.record(
      EntryType.CLIENT_REQUEST,
      IncomingEntry.make({
        method: String(attempt.method ?? 'GET'),
        uri: address,
        host,
        responseStatus: status,
        /** Bytes, not the body — see the note on the class. */
        responseSize: typeof response?.body === 'string' ? response.body.length : 0,
        failed: statusTone(status) === 'danger'
      }).withTags(host === '' ? [] : [host])
    )
  }

  private ignoredHosts(): string[] {
    return this.option<string[]>('ignoreHosts', [])
  }
}

/** The host, or nothing when the URL is not one this can parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
