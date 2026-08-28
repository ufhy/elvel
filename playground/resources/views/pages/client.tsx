import { push } from '@elvel/view'
import { Layout } from '../components/layout.tsx'

/** One button per thing the client decides, and a place to print the answer. */
const CASES = [
  ['get', 'GET with a query', 'Arrays repeat the key; null and undefined are dropped.'],
  ['post', 'POST with a JSON body', 'content-type and x-csrf-token added by the client.'],
  ['upload', 'POST a file', 'FormData travels as it is — the runtime writes the boundary.'],
  ['send', 'send() for status + headers', 'A 201 and its Location, not just the body.'],
  ['abort', 'Cancel in flight', 'Aborted after 200ms against a request that sleeps 3s.'],
  ['invalid', '422 → Invalid', 'The field bag arrives intact.'],
  ['401', '401 → Unauthenticated', 'For a router to act on.'],
  ['423', '423 → NeedsPasswordConfirmation', 'Behind password.confirm.']
] as const

/**
 * `@elvel/client` running in the browser, against this application.
 *
 * A document can show the snippets; only a page can show a file uploading and a
 * request being cancelled. The script is `resources/js/client-demo.ts`, bundled
 * by `bun run playground:assets`.
 */
export function Client({ title }: { title: string }) {
  push('scripts', '<script type="module" src="/js/client-demo.js"></script>')

  return (
    <Layout title={title}>
      <section class="panel">
        <p class="eyebrow">@elvel/client</p>
        <h1>One fetch, already decided</h1>

        <p class="muted">
          Every button calls this application the way a screen would. Nothing here sets a header, a
          cookie or a CSRF token — the client does. Open the network tab and watch what it sends.
        </p>
      </section>

      {CASES.map(([id, label, note]) => (
        <section class="panel">
          <h2>{label}</h2>
          <p class="muted" safe>
            {note}
          </p>

          <button type="button" id={`run-${id}`}>
            Run
          </button>

          <pre id={`out-${id}`} class="output">
            —
          </pre>
        </section>
      ))}
    </Layout>
  )
}
