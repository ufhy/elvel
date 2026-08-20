# HTTP client

An outgoing request, and a fake that makes a test of code that calls an API stop
calling the API.

```ts
import { http } from '@elvel/http-client'

const response = await http().get('https://api.example.com/users')

response.status        // 200
response.successful()  // true
response.json()        // { data: [ { id: 1 } ] }
response.header('content-type')
```

::: tip `status` and `body` are properties, not methods
`response.status` and `response.body`, but `response.successful()`,
`response.failed()` and `response.json()`. Calling `response.status()` fails with
`status is not a function`, which is a confusing error for a small mistake — this
is the shape.
:::

## Building the request

```ts
await http().post('https://api.example.com/users', { name: 'Ada' })
await http().asForm('https://api.example.com/login', { user, password })
await http().asMultipart('https://api.example.com/upload', form)

http()
  .baseUrl('https://api.example.com')
  .withToken(jwt)
  .withHeader('x-request-id', id)
  .acceptJson()
  .timeout(5_000)
  .retry(3, 200)
  .withoutRedirecting()
  .throwOnFailure()
```

Every builder returns a new pending request, so a configured base is reusable
without one call leaking settings into the next. `withBunOptions` passes anything
Bun's `fetch` understands straight through, and `proxy(url)` is there for the
environments that need one.

## Deciding what happened

```ts
response.ok()  redirect()  clientError()  serverError()
response.unauthorized()  forbidden()  notFound()  unprocessable()  tooManyRequests()

response.throw()                    // RequestError, if it failed
response.throwIf(condition)
response.throwUnless(condition)
response.throwIfStatus(409)
response.cookies()
```

A `throw()` on a failed response raises `RequestError`; a request that never got
an answer raises `ConnectionError`. The two are separate on purpose — a 500 and
an unreachable host call for different handling, and a client that collapses them
makes retry logic guesswork.

## Testing

```ts
const client = new HttpClient()

client.fake({
  'https://api.example.com/users': { body: { data: [{ id: 1 }] } },
  'https://api.example.com/slow': { body: 'nope', status: 500 },
  '*': 'anything'
}).preventStrayRequests()
```

A definition is a string (the body), an object (`body`, `status`, `headers`), or a
function of the attempt. A pattern may contain `*`, and every metacharacter is
escaped before the pattern becomes a regular expression, so `api.example.com`
cannot match `apiXexample.com`.

`preventStrayRequests()` is the one to reach for: without it, a URL nothing faked
goes to the real network from inside a test.

```ts
const bad = await client.get('https://api.example.com/slow')

bad.failed()       // true
bad.serverError()  // true
bad.body           // 'nope'
bad.throw()        // RequestError
```

Assertions:

```ts
client.assertSent('https://api.example.com/users')
client.assertSentCount(3)
client.assertNotSent('*')
client.assertNothingSent()
```

### A sequence, for polling

```ts
client.sequence('https://api.example.com/poll', ['pending', 'done'])

await client.get('https://api.example.com/poll')   // 'pending'
await client.get('https://api.example.com/poll')   // 'done'
```

That is how you test the code that waits for something to finish, without making
it wait.

`record()` keeps every request and response for inspection when an assertion is
not the shape you want.
