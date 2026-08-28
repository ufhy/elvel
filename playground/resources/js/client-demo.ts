import { http, Invalid, NeedsPasswordConfirmation, send, Unauthenticated } from '@elvel/client'

/**
 * `@elvel/client`, exercised in a real browser against this application.
 *
 * Bundled to `public/js/client-demo.js` by `bun run playground:assets`, because
 * the playground has no Vite project — one `bun build` is the whole toolchain
 * this needs, and the page loads the result as a module.
 *
 * Every button below calls the client the way an application would and prints
 * what came back. The point is the parts a snippet in a document cannot show: a
 * file that actually uploads, a request that is actually cancelled, and a 422
 * arriving as a typed error with its field bag intact.
 */
const out = (id: string, value: unknown) => {
  const target = document.getElementById(id)

  if (target)
    target.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

const on = (id: string, run: () => Promise<void>) =>
  document.getElementById(id)?.addEventListener('click', () => {
    void run().catch((problem: unknown) => out(id.replace('run-', 'out-'), String(problem)))
  })

/** A read, with a query the client serialises. */
on('run-get', async () => {
  const answer = await http.get('/check/browser/echo', {
    query: { status: 'paid', ids: [1, 2], page: 2, live: true, cursor: null, note: undefined }
  })

  out('out-get', answer)
})

/** A write: JSON body, content-type and CSRF token added by the client. */
on('run-post', async () => {
  out('out-post', await http.post('/check/browser/echo', { body: { total: 1200 } }))
})

/** A file. No content-type is set — the runtime writes the boundary. */
on('run-upload', async () => {
  const form = new FormData()

  form.append('report', new Blob(['line one\nline two']), 'report.txt')
  form.append('note', 'from the browser')

  out('out-upload', await http.post('/check/browser/upload', { body: form }))
})

/** The whole answer, when the status and a header are the point. */
on('run-send', async () => {
  const answer = await send('/check/browser/created', { method: 'POST', body: {} })

  out('out-send', {
    status: answer.status,
    location: answer.headers.get('location'),
    data: answer.data
  })
})

/** A request cancelled while it is still in flight. */
on('run-abort', async () => {
  const controller = new AbortController()

  setTimeout(() => controller.abort(), 200)
  out('out-abort', 'waiting…')

  try {
    await http.get('/check/browser/slow', { signal: controller.signal })
    out('out-abort', 'it landed — the abort did not fire')
  } catch (problem) {
    out('out-abort', `rejected after ~200ms: ${(problem as Error).name}`)
  }
})

/** The three statuses that arrive as types rather than as numbers. */
for (const [id, path] of [
  ['run-invalid', '/check/browser/invalid'],
  ['run-401', '/check/browser/gone'],
  ['run-423', '/check/browser/locked']
] as const) {
  on(id, async () => {
    const target = id.replace('run-', 'out-')

    try {
      await http.post(path, { body: {} })
      out(target, 'no error — which is the bug')
    } catch (problem) {
      if (problem instanceof Invalid) {
        out(target, { caught: 'Invalid', message: problem.message, errors: problem.errors })
      } else if (problem instanceof Unauthenticated) {
        out(target, { caught: 'Unauthenticated' })
      } else if (problem instanceof NeedsPasswordConfirmation) {
        out(target, { caught: 'NeedsPasswordConfirmation' })
      } else {
        out(target, { caught: (problem as Error).name, message: (problem as Error).message })
      }
    }
  })
}
