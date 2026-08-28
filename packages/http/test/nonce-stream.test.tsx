import { expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { stream, ViewServiceProvider } from '@elvel/view'
import { Elysia } from 'elysia'
import { HttpServiceProvider } from '../src/provider.ts'
import { cspNonce } from '../src/scope.ts'

/**
 * The nonce a streamed page renders is the nonce its header names.
 *
 * Two subsystems have to agree here and they run at different moments. The policy
 * header is written when the response leaves; a streamed body is produced *after*
 * that, part by part. So the nonce cannot be minted by either one — it is generated
 * once when the request scope is entered, before the handler runs, and both read it.
 *
 * This is the path with the least margin for error: get it wrong and the header
 * names a nonce the page does not carry, so the browser blocks the inline script
 * with nothing failing on the server.
 */
function Shell() {
  return (
    <html lang="en">
      <head>
        <script nonce={cspNonce()}>{'/* theme */'}</script>
      </head>
      <body>
        <p>streamed</p>
      </body>
    </html>
  )
}

test('a streamed page carries the nonce its own policy names', async () => {
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('app.env', 'testing')
  app.config.set('session', { driver: 'memory' })
  app.config.set('view.serveStatic', false)

  await app.register(HttpServiceProvider)
  await app.register(ViewServiceProvider)
  await app.boot()
  app.handleExceptions()

  app.useRoutes(new Elysia().get('/streamed', () => stream([[Shell as never, {}]])))

  const response = await app.handle(new Request('http://localhost/streamed'))
  const body = await response.text()

  const policy = response.headers.get('content-security-policy') ?? ''
  const named = /'nonce-([^']+)'/.exec(policy)?.[1]
  const rendered = /nonce="([^"]+)"/.exec(body)?.[1]

  expect<string | undefined>(named).toBeDefined()
  expect<string | undefined>(rendered).toBe(named)
})

test('and a second request gets a different one', async () => {
  const app = new Application(process.cwd())

  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
  app.config.set('app.env', 'testing')
  app.config.set('session', { driver: 'memory' })
  app.config.set('view.serveStatic', false)

  await app.register(HttpServiceProvider)
  await app.register(ViewServiceProvider)
  await app.boot()
  app.handleExceptions()

  app.useRoutes(new Elysia().get('/streamed', () => stream([[Shell as never, {}]])))

  const first = /nonce="([^"]+)"/.exec(
    await (await app.handle(new Request('http://localhost/streamed'))).text()
  )?.[1]

  const second = /nonce="([^"]+)"/.exec(
    await (await app.handle(new Request('http://localhost/streamed'))).text()
  )?.[1]

  expect<string | undefined>(first).toBeDefined()
  expect<string | undefined>(second).not.toBe(first)

  // 16 random bytes, base64: the length is the entropy, stated.
  expect<number>(Buffer.from(first as string, 'base64').byteLength).toBe(16)
})
