import { controller } from '@elyvel/core'
import {
  clientPrefix,
  clientUrl,
  cookie,
  errorBags,
  errors,
  forgetCookie,
  intended,
  queueCookie,
  redirect
} from '@elyvel/http'

/**
 * Cookies that hide their contents, named error bags and proxy-aware URLs —
 * asserted over the network by `scripts/smoke.ts`.
 *
 * The cookie routes are the interesting half: a value queued here goes out
 * encrypted and bound to its own name, so what the browser holds is opaque and
 * cannot be edited into something else.
 */
export default controller('cookie', '/cookies')
  /** Queue a cookie. The response says what the value was; the header does not. */
  .get('/set', ({ query }) => {
    queueCookie('preference', String(query.value ?? 'dark'), { maxAge: 3600 })

    // Readable straight back: the browser has not sent it yet, but a handler that
    // sets a preference and then renders must render the new one.
    return { queued: cookie('preference') }
  })

  /** Read it back on the next request, decrypted. */
  .get('/read', () => ({ preference: cookie('preference') ?? null }))

  .get('/forget', () => {
    forgetCookie('preference')

    return { forgotten: true }
  })

  /** Two forms on one page, each with its own errors. */
  .post('/register', async () => {
    return redirect('/cookies/bags').withErrors({ email: 'is taken' }, 'register').toResponse()
  })

  .post('/login', async () => {
    return redirect('/cookies/bags').withErrors({ password: 'is wrong' }, 'login').toResponse()
  })

  .get('/bags', () => ({
    bags: errorBags().sort(),
    register: errors('register').first('email') ?? null,
    login: errors('login').first('password') ?? null,
    // The default bag stays empty, which is the point of naming them: a failed
    // sign-up must not mark the sign-in form's fields.
    fallback: errors().first('email') ?? null
  }))

  /** Where a guest was going, remembered across the sign-in. */
  .get('/private', () => redirect('/cookies/sign-in').guest().toResponse())

  .get('/sign-in', () => intended('/cookies/home').toResponse())

  .get('/home', () => ({ landed: 'home' }))

  /** What the application thinks its own address is, behind a gateway. */
  .get('/whereami', ({ request, server }) => ({
    url: clientUrl(request, server?.requestIP(request), { trustedProxies: '*' }),
    prefix: clientPrefix(request, server?.requestIP(request), { trustedProxies: '*' })
  }))
