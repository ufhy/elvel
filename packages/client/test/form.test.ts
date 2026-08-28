import { afterEach, describe, expect, test } from 'bun:test'
import { Unauthenticated } from '../src/index.ts'
import { useForm } from '../src/vue.ts'

/**
 * The form half, which is where a client-routed application spends its errors.
 *
 * A 302 is useless to `fetch` — it follows it silently and lands on a document
 * whose flash it never renders — so the server answers a client with a 422 and a
 * bag. This is the other end of that: the bag becoming a message under an input.
 */
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** What the last request was, and what to answer it with. */
function answering(answer: { status?: number; body?: unknown } = {}) {
  const seen: { url: string; init: RequestInit } = { url: '', init: {} }

  globalThis.fetch = ((url: string, init: RequestInit) => {
    seen.url = url
    seen.init = init

    return Promise.resolve(
      new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 })
    )
  }) as typeof fetch

  return seen
}

describe('submitting', () => {
  test('posts to the address it names, with no prefix in front of it', async () => {
    const seen = answering({ body: { redirect: '/dashboard' } })
    const form = useForm({ email: 'ada@example.com', password: 'secret' })

    await form.post('/sign-in')

    // `/api/sign-in` would be a 404: auth is not an API route, it is the same
    // address a browser navigates to.
    expect(seen.url).toBe('/sign-in')
    expect(seen.init.method).toBe('POST')
    expect(JSON.parse(seen.init.body as string)).toEqual({
      email: 'ada@example.com',
      password: 'secret'
    })
  })

  test('the redirect the server chose is handed to the router', async () => {
    answering({ body: { redirect: '/two-factor-challenge' } })

    const went: string[] = []
    const form = useForm({ email: '' }, { onRedirect: (to) => went.push(to) })

    await form.post('/sign-in')

    // Where signing in leads is the server's decision — a dashboard, or a
    // challenge — and this is how the client is told which.
    expect(went).toEqual(['/two-factor-challenge'])
  })

  test('every verb reaches the same submission', async () => {
    const seen = answering()
    const form = useForm({ name: 'Ada' })

    await form.put('/settings/profile')
    expect(seen.init.method).toBe('PUT')

    await form.patch('/settings/profile')
    expect(seen.init.method).toBe('PATCH')

    await form.delete('/settings/passkeys/1')
    expect(seen.init.method).toBe('DELETE')
  })
})

describe('a refusal', () => {
  test('becomes one message per field', async () => {
    answering({
      status: 422,
      body: {
        message: 'Those details did not match.',
        errors: { email: ['Those details did not match.', 'And it is not an address.'] }
      }
    })

    const form = useForm({ email: 'nope' })

    await form.post('/sign-in')

    // The first message is the one that fits under an input; the rest would stack
    // the layout. A caller wanting all of them catches `Invalid` from `call`.
    expect(form.errors).toEqual({ email: 'Those details did not match.' })
  })

  test('and is not thrown — a 422 is an answer', async () => {
    answering({ status: 422, body: { errors: { email: ['No.'] } } })

    const form = useForm({ email: '' })

    expect(await form.post('/sign-in')).toBeUndefined()
  })

  test('anything else still throws', async () => {
    answering({ status: 401 })

    const form = useForm({ email: '' })

    // What a signed-out session means is the router's decision, not a form's.
    await expect(form.post('/sign-in')).rejects.toBeInstanceOf(Unauthenticated)
  })

  test('errors clear on the way out, not on the way back', async () => {
    answering({ status: 422, body: { errors: { email: ['No.'] } } })

    const form = useForm({ email: '' })
    await form.post('/sign-in')
    expect(form.errors.email).toBe('No.')

    /**
     * A field the server no longer objects to has to stop being red, and the only
     * certain moment is before asking. Clearing on the answer instead leaves the
     * previous refusal on screen for the length of the request.
     */
    answering({ body: { redirect: '/dashboard' } })
    await form.post('/sign-in')

    expect(form.errors).toEqual({})
  })
})

describe('the state a button binds to', () => {
  test('processing is true in flight and false after, even when refused', async () => {
    let release: (() => void) | undefined

    // `as unknown as` because this stub takes no arguments at all: a `fetch` that
    // ignores its input does not overlap with the real signature closely enough
    // for a direct assertion, and `preconnect` is the property TS names.
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response('{}', { status: 422 }))
      })) as unknown as typeof fetch

    const form = useForm({ email: '' })

    const submission = form.post('/sign-in')
    expect(form.processing).toBe(true)

    release?.()
    await submission

    // In a `finally`, so a refusal does not leave the button disabled forever.
    expect(form.processing).toBe(false)
  })

  test('reset puts back what it started with', async () => {
    answering({ status: 422, body: { errors: { email: ['No.'] } } })

    const form = useForm({ email: 'ada@example.com', password: 'secret' })
    form.data.email = 'changed'
    form.data.password = 'changed'

    form.reset('password')
    expect(form.data).toEqual({ email: 'changed', password: 'secret' })

    form.reset()
    expect(form.data).toEqual({ email: 'ada@example.com', password: 'secret' })
  })

  test('clearErrors takes all of them, or only those named', async () => {
    answering({ status: 422, body: { errors: { email: ['No.'], password: ['Also no.'] } } })

    const form = useForm({ email: '', password: '' })
    await form.post('/sign-in')

    form.clearErrors('email')
    expect(form.errors).toEqual({ password: 'Also no.' })

    form.clearErrors()
    expect(form.errors).toEqual({})
  })
})
