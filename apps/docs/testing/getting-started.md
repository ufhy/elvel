# Testing

Press the application without a socket, and assert on what comes back.

```ts
import { describe, test as it } from 'bun:test'
import { test } from '@elvel/testing'
import app from '../bootstrap/app.ts'

describe('a page', () => {
  it('renders', async () => {
    ;(await test(app).get('/'))
      .assertOk()
      .assertHeaderContains('content-type', 'text/html')
      .assertSee('<!DOCTYPE html>')
  })
})
```

Requests go through `app.handle()` — Elysia's own entry point — so routing,
hooks, validation, the session and the error handler all run. The only thing
skipped is the network, which is the part a test does not want to pay for.

Nothing here knows about a test runner. Assertions throw `AssertionError`, which
every runner reports as a failure, so the same helpers work under `bun test` and
under a plain script.

## The request

```ts
await test(app).get('/posts')
await test(app).post('/posts', { title: 'Hello' })
await test(app).getJson('/api/posts')
await test(app).postJson('/api/posts', { title: 'Hello' })
```

`get`, `head`, `options`, `post`, `put`, `patch`, `delete`, and a `…Json`
variant of each that sets `accept` and `content-type` for you.

Builders return a **new instance** rather than mutating, so a configured base is
reusable:

```ts
const api = test(app).withToken(jwt).acceptJson()

await api.getJson('/posts')       // the base is untouched
await api.postJson('/posts', {})  // and still usable
```

| Builder | What it does |
| --- | --- |
| `withHeader` / `withHeaders` / `withoutHeader` | Headers |
| `withToken(token, type?)` | `Authorization: Bearer …` |
| `withBasicAuth(user, pass)` | Basic credentials |
| `acceptJson()` | Ask for JSON without using a `…Json` verb |
| `withCookie` / `withCookies` | Cookies |
| `withCookiesFrom(response)` | Carry a previous response's cookies — a session |
| `from(url)` | Set the referer, which is where a validation failure redirects back to |
| `followingRedirects(max?)` | Off by default: most redirect tests want to assert *where* it went |

## Acting as a user

```ts
await test(app).actingAs(user, async (request) => {
  ;(await request.get('/dashboard')).assertOk()
})
```

Impersonation is restored afterwards **including when an assertion throws**, so
one test cannot leave another authenticated. It needs `AuthServiceProvider`
registered, and says so plainly if it is not.

## Asserting on the response

Status has a name for every case you actually use — `assertOk`, `assertCreated`,
`assertNoContent`, `assertUnauthorized`, `assertForbidden`, `assertNotFound`,
`assertUnprocessable`, `assertTooManyRequests`, `assertRedirect` — plus
`assertStatus(n)`, `assertSuccessful`, `assertClientError` and
`assertServerError`.

Content:

```ts
response.assertSee('Welcome back')
response.assertSeeText('Welcome back')     // tags stripped first
response.assertSeeInOrder(['First', 'Second'])
response.assertDontSee('<script>')
```

Headers and cookies: `assertHeader`, `assertHeaderContains`,
`assertHeaderMissing`, `assertCookie`, `assertCookieMissing`,
`assertCookieExpired`.

Validation:

```ts
response.assertInvalid('email')
response.assertInvalid({ email: 'The email field must be a valid email address.' })
response.assertValid(['title', 'body'])
```

A failure names what it saw, not only what it wanted:

```
Expected status 418, saw 200. Body: "{\"data\":[{\"id\":1,\"title\":\"Article 0\"…
```

## JSON

```ts
response.assertJson({ title: 'Hello' })          // a subset
response.assertExactJson({ id: 1, title: 'Hi' }) // the whole thing
response.assertJsonPath('data.0.title', 'Hello')
response.assertJsonPath('data', (value) => Array.isArray(value))
response.assertJsonCount(3, 'data')
response.assertJsonFragment({ slug: 'hello' })
response.assertJsonMissingPath('data.0.password')
response.assertJsonStructure({ data: [['id', 'title']] })
```

### Fluent JSON, and its one surprise

```ts
response.assertJsonFluent((json) => {
  json
    .has('data', undefined, (data) => data.each((row) => row.hasAll('id', 'title').etc()))
    .etc()
})
```

**It is strict.** Every key in a scope must be touched by an assertion, or the
scope has to say it does not care. Forget the `etc()` and you get:

```
Unexpected properties on the root: [meta]. Assert them, or call etc() to allow them.
```

That is the point of the thing: a test written against a response with three
fields fails when a fourth appears, which is when you find out that a change
started leaking a `password_hash` into the payload. The `etc()` is a decision,
not noise.

`has`, `hasAll`, `hasAny`, `missing`, `missingAll`, `where`, `whereNot`,
`whereAll`, `whereContains`, `whereType`, `count`, `each`, `first`, and `json()`
for anything this does not cover.

## Commands

```ts
import { Output } from '@elvel/console'
import { elvel } from '@elvel/testing'

const command = await elvel(kernel, ['make:model', 'Post'], Output.prototype)
  .expectsConfirmation('Overwrite', true)
  .run()

command.assertSuccessful().assertOutputContains('Created')
```

`run()` resolves to the command itself, so the assertions chain off the awaited
value.

`expectsQuestion`, `answers`, `expectsConfirmation` queue the answers a prompt
will ask for; `assertAllQuestionsAnswered` checks none was left unused, which is
how you catch a prompt that stopped being asked. `assertExitCode`,
`assertSuccessful`, `assertFailed`, `assertOutputContains`,
`assertOutputMissing`, `assertOutputInOrder` and `plain()` cover the rest.

`Output.prototype` is passed in by the caller because this package must not
depend on `@elvel/console`. Omit it for a command that asks nothing.

## Fakes

Each package brings its own, and they all follow the same shape — swap the real
thing for a recorder, then assert on what was recorded:

```ts
const fake = queue().fake()
await dispatch(new SendWelcomeEmail({ userId: 'u9' }))
fake.assertPushed('SendWelcomeEmail')
```

The same shape exists elsewhere: `mail().fake()`, `notifications().fake()`,
`storage().fake(disk?)` — which swaps in an in-memory disk — and `EventFake`
from `@elvel/events`.

## Two kinds of test

The framework's own suite builds a small application per package to exercise one
thing. `playground/test` boots an application with **every provider registered at
once**, and that is a different shape: ordering bugs between providers only exist
there, and that is where they have been found.

A scaffolded application starts with the same split — `tests/Feature` for tests
that boot the application, `tests/Unit` for those that do not — because being
able to run the fast half alone is the difference between a suite you run on
every save and one you run before pushing.
