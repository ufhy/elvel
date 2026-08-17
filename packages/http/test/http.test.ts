import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForbiddenException } from '@elyvel/core'
import { Rule, ValidationError, type Validator } from '@elyvel/validation'
import { CookieJar, timingSafeEqual } from '../src/cookies.ts'
import { isExempt, TokenMismatchError, tokenFromRequest, tokensMatch } from '../src/csrf.ts'
import { FormRequest } from '../src/form-request.ts'
import { JsonResource } from '../src/resource.ts'
import { FileSessionDriver, MemorySessionDriver, Session } from '../src/session.ts'

// ------------------------------------------------------------- form requests

class StoreUserRequest extends FormRequest {
  rules() {
    return {
      name: 'required|string|min:2',
      email: 'required|email',
      password: 'required|min:8|confirmed',
      team: 'required_if:role,admin'
    }
  }
}

describe('FormRequest', () => {
  test('validated() returns only the validated keys', async () => {
    const request = new StoreUserRequest({
      body: {
        name: 'Ada',
        email: 'ada@example.com',
        password: 'secret123',
        password_confirmation: 'secret123',
        role: 'member',
        is_admin: true
      }
    })

    const data = await request.validateResolved()

    expect(data).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'secret123'
    })
    // `is_admin` was never validated, so it cannot reach a write.
    expect(data).not.toHaveProperty('is_admin')
  })

  test('failure throws a ValidationError carrying the bag', async () => {
    const request = new StoreUserRequest({ body: { name: 'A', email: 'nope' } })

    await expect(request.validateResolved()).rejects.toThrow(ValidationError)

    try {
      await new StoreUserRequest({ body: { name: 'A', email: 'nope' } }).validateResolved()
    } catch (error) {
      const bag = (error as ValidationError).errors.messages()

      expect(Object.keys(bag).sort()).toEqual(['email', 'name', 'password'])
    }
  })

  test('body, query and params merge, body winning', async () => {
    class Probe extends FormRequest {
      rules() {
        return { id: 'required', page: 'required', name: 'required' }
      }
    }

    const data = await new Probe({
      params: { id: '7', name: 'from-params' },
      query: { page: '2', name: 'from-query' },
      body: { name: 'from-body' }
    }).validateResolved()

    expect(data).toEqual({ id: '7', page: '2', name: 'from-body' })
  })

  test('authorize() refusing is a 403, not a 422', async () => {
    class Guarded extends StoreUserRequest {
      override authorize() {
        return false
      }
    }

    // Note the payload is also invalid: authorization must fail first, so the
    // response cannot leak which fields would have been rejected.
    const request = new Guarded({ body: { name: '' } })

    await expect(request.validateResolved()).rejects.toThrow(ForbiddenException)
  })

  test('prepareForValidation can normalise the payload', async () => {
    class Trimming extends FormRequest {
      override prepareForValidation() {
        this.merge({ email: String(this.input('email', '')).trim().toLowerCase() })
      }

      rules() {
        return { email: 'required|email|lowercase' }
      }
    }

    const data = await new Trimming({ body: { email: '  ADA@Example.COM  ' } }).validateResolved()

    expect(data.email).toBe('ada@example.com')
  })

  test('passedValidation runs after success, not after failure', async () => {
    let ran = 0

    class Tracking extends FormRequest {
      override passedValidation() {
        ran += 1
      }

      rules() {
        return { name: 'required' }
      }
    }

    await new Tracking({ body: { name: 'Ada' } }).validateResolved()
    expect(ran).toBe(1)

    await expect(new Tracking({ body: {} }).validateResolved()).rejects.toThrow(ValidationError)
    expect(ran).toBe(1)
  })

  test('withValidator can add an after hook', async () => {
    class WithHook extends FormRequest {
      rules() {
        return { name: 'required' }
      }

      override withValidator(validator: Validator) {
        validator.after((instance) => {
          instance.addError('name', 'That name is reserved.')
        })
      }
    }

    await expect(new WithHook({ body: { name: 'Ada' } }).validateResolved()).rejects.toThrow(
      'That name is reserved.'
    )
  })

  test('custom messages and attribute labels are honoured', async () => {
    class Custom extends FormRequest {
      rules() {
        return { email_address: 'required' }
      }

      override messages() {
        return { 'email_address.required': 'We need your e-mail.' }
      }

      override attributes() {
        return { email_address: 'e-mail' }
      }
    }

    const request = new Custom({ body: {} })

    await expect(request.validateResolved()).rejects.toThrow('We need your e-mail.')
  })

  test('stopOnFirstFailure reports one field', async () => {
    class Quick extends FormRequest {
      static override stopOnFirstFailure = true

      rules() {
        return { a: 'required', b: 'required' }
      }
    }

    try {
      await new Quick({ body: {} }).validateResolved()
    } catch (error) {
      expect(Object.keys((error as ValidationError).errors.messages())).toEqual(['a'])
    }
  })

  test('failOnUnknownFields rejects keys no rule mentions', async () => {
    class Strict extends FormRequest {
      static override failOnUnknownFields = true

      rules() {
        return { name: 'required' }
      }
    }

    await expect(
      new Strict({ body: { name: 'Ada', surprise: 1 } }).validateResolved()
    ).rejects.toThrow(/surprise field is not allowed/)

    // Without the flag the extra key is simply dropped.
    class Lenient extends FormRequest {
      rules() {
        return { name: 'required' }
      }
    }

    expect(await new Lenient({ body: { name: 'Ada', surprise: 1 } }).validateResolved()).toEqual({
      name: 'Ada'
    })
  })

  test('safe() slices the validated payload', async () => {
    const request = new StoreUserRequest({
      body: {
        name: 'Ada',
        email: 'ada@example.com',
        password: 'secret123',
        password_confirmation: 'secret123'
      }
    })

    await request.validateResolved()

    expect(Object.keys(request.safe().only('name', 'email')).sort()).toEqual(['email', 'name'])
    expect(request.safe().except('password')).not.toHaveProperty('password')
    expect(request.safe().all()).toHaveProperty('password')
  })

  test('validated() before validating is a clear error', () => {
    expect(() => new StoreUserRequest({ body: {} }).validated()).toThrow(
      /Call validateResolved\(\)/
    )
  })

  test('a database rule reaches the injected verifier', async () => {
    const asked: string[] = []

    class Unique extends FormRequest {
      rules() {
        return { email: ['required', Rule.unique('users', 'email')] }
      }
    }

    const request = new Unique(
      { body: { email: 'ada@example.com' } },
      {
        count: async (table) => {
          asked.push(table)
          return 1
        },
        countIn: async () => 0
      }
    )

    await expect(request.validateResolved()).rejects.toThrow('The email has already been taken.')
    expect(asked).toEqual(['users'])
  })
})

// ---------------------------------------------------------------- resources

class PostResource extends JsonResource<{ id: number; title: string }> {
  toObject() {
    return { id: this.resource.id, title: this.resource.title }
  }
}

class UserResource extends JsonResource<{
  id: number
  name: string
  email: string
  relationLoaded?: (name: string) => boolean
  posts?: Array<{ id: number; title: string }>
}> {
  constructor(
    resource: UserResource['resource'],
    private readonly viewerIsAdmin = false
  ) {
    super(resource)
  }

  toObject() {
    return {
      id: this.resource.id,
      name: this.resource.name,
      email: this.when(this.viewerIsAdmin, () => this.resource.email),
      posts: this.whenLoaded('posts', () => PostResource.collection(this.resource.posts ?? [])),
      meta: this.merge({ kind: 'user' })
    }
  }
}

describe('JsonResource', () => {
  const user = { id: 1, name: 'Ada', email: 'ada@example.com' }

  test('a false condition removes the key rather than nulling it', () => {
    const hidden = new UserResource(user).resolve()
    const shown = new UserResource(user, true).resolve()

    // A null would tell the client the value exists and is empty.
    expect('email' in hidden).toBe(false)
    expect(shown.email).toBe('ada@example.com')
  })

  test('merge() spreads into the parent object', () => {
    const payload = new UserResource(user).resolve()

    expect(payload.kind).toBe('user')
    expect(payload).not.toHaveProperty('meta')
  })

  test('whenLoaded never triggers a lazy load', () => {
    const withoutRelation = new UserResource({ ...user, relationLoaded: () => false }).resolve()
    expect('posts' in withoutRelation).toBe(false)

    const withRelation = new UserResource({
      ...user,
      relationLoaded: (name) => name === 'posts',
      posts: [{ id: 9, title: 'Hello' }]
    }).resolve()

    expect(withRelation.posts).toEqual([{ id: 9, title: 'Hello' }])
  })

  test('whenLoaded reads the relation, not the method that declares it', () => {
    // A model declares a relation as a method, and JavaScript keeps methods and
    // properties in one namespace — so reading `model.posts` yields the function
    // and JSON.stringify silently drops the key. `getRelation()` wins.
    class BareResource extends JsonResource<Record<string, unknown>> {
      toObject() {
        return { posts: this.whenLoaded('posts') }
      }
    }

    const model = {
      relationLoaded: (name: string) => name === 'posts',
      getRelation: (name: string) => (name === 'posts' ? [{ id: 9 }] : undefined),
      posts: () => 'the relation factory'
    }

    expect(new BareResource(model).resolve().posts).toEqual([{ id: 9 }])
  })

  test('the payload is wrapped, and additional() adds top-level keys', () => {
    const body = new UserResource(user).additional({ status: 'ok' }).toObjectWithWrapper()

    expect(body).toEqual({ data: { id: 1, name: 'Ada', kind: 'user' }, status: 'ok' })
  })

  test('wrap can be turned off per resource', () => {
    class Bare extends JsonResource<{ id: number }> {
      static override wrap = undefined

      toObject() {
        return { id: this.resource.id }
      }
    }

    expect(new Bare({ id: 1 }).toObjectWithWrapper()).toEqual({ id: 1 })
  })

  test('toResponse serialises as JSON', async () => {
    const response = new UserResource(user).toResponse({ status: 201 })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { id: 1, name: 'Ada', kind: 'user' } })
  })

  test('collections share the wrapper and can carry meta', () => {
    const body = PostResource.collection([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' }
    ])
      .withMeta({ total: 2 })
      .toObjectWithWrapper()

    expect(body).toEqual({
      data: [
        { id: 1, title: 'A' },
        { id: 2, title: 'B' }
      ],
      meta: { total: 2 }
    })
  })

  test('nested resources resolve recursively', () => {
    const payload = new UserResource({
      ...user,
      relationLoaded: () => true,
      posts: [{ id: 1, title: 'A' }]
    }).resolve()

    expect(payload.posts).toEqual([{ id: 1, title: 'A' }])
  })
})

// ----------------------------------------------------------------- sessions

describe('Session', () => {
  let driver: MemorySessionDriver

  beforeEach(() => {
    driver = new MemorySessionDriver()
  })

  test('a fresh session has a CSRF token', async () => {
    const session = await new Session(Session.newId(), driver).start()

    expect(session.token()).toHaveLength(40)
  })

  test('values survive a save and reload', async () => {
    const id = Session.newId()
    const first = await new Session(id, driver).start()

    first.put('user_id', 7)
    await first.save()

    const second = await new Session(id, driver).start()

    expect(second.get<number>('user_id')).toBe(7)
  })

  test('pull reads and forgets', async () => {
    const session = await new Session(Session.newId(), driver).start()
    session.put('once', 'value')

    expect(session.pull<string>('once')).toBe('value')
    expect(session.has('once')).toBe(false)
  })

  test('flash data survives exactly one further request', async () => {
    const id = Session.newId()

    const first = await new Session(id, driver).start()
    first.flash('status', 'Saved!')
    await first.save()

    // The next request can read it...
    const second = await new Session(id, driver).start()
    expect(second.get<string>('status')).toBe('Saved!')
    await second.save()

    // ...but the one after that cannot.
    const third = await new Session(id, driver).start()
    expect(third.get<string | undefined>('status')).toBeUndefined()
  })

  test('reflash keeps it for one more request', async () => {
    const id = Session.newId()

    const first = await new Session(id, driver).start()
    first.flash('status', 'Saved!')
    await first.save()

    const second = await new Session(id, driver).start()
    second.reflash()
    await second.save()

    const third = await new Session(id, driver).start()
    expect(third.get<string>('status')).toBe('Saved!')
  })

  test('flush keeps the token but drops the data', async () => {
    const session = await new Session(Session.newId(), driver).start()
    const token = session.token()

    session.put('a', 1).flush()

    expect(session.has('a')).toBe(false)
    expect(session.token()).toBe(token)
  })

  test('regenerateToken changes it', async () => {
    const session = await new Session(Session.newId(), driver).start()
    const before = session.token()

    session.regenerateToken()

    expect(session.token()).not.toBe(before)
  })

  test('invalidate destroys the stored data', async () => {
    const id = Session.newId()
    const session = await new Session(id, driver).start()
    session.put('a', 1)
    await session.save()

    await session.invalidate()

    expect(await driver.read(id)).toBeUndefined()
    // A save after invalidation must not resurrect it.
    await session.save()
    expect(await driver.read(id)).toBeUndefined()
  })

  test('gc removes sessions past their lifetime', async () => {
    let now = 1_000_000
    const clock = new MemorySessionDriver(() => now)

    await new Session('old', clock).start().then((session) => session.save())
    now += 10_000
    await new Session('fresh', clock).start().then((session) => session.save())

    expect(await clock.gc(5)).toBe(1)
    expect(await clock.read('old')).toBeUndefined()
    expect(await clock.read('fresh')).toBeDefined()
  })

  test('the file driver round-trips and refuses an unsafe id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elyvel-session-'))

    try {
      const files = new FileSessionDriver(directory)
      const session = await new Session('abc123', files).start()

      session.put('user_id', 42)
      await session.save()

      expect((await files.read('abc123'))?.user_id).toBe(42)
      await expect(files.read('../escape')).rejects.toThrow(/unsafe session id/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------------ cookies

describe('CookieJar', () => {
  const jar = new CookieJar('a-key-long-enough-to-sign')

  test('a signed value round-trips', () => {
    const signed = jar.sign('session-id')

    expect(signed).toContain('|')
    expect(jar.unsign(signed)).toBe('session-id')
  })

  test('tampering is detected', () => {
    const signed = jar.sign('session-id')

    expect(jar.unsign(signed.replace('session-id', 'other-id'))).toBeUndefined()
    expect(jar.unsign('no-signature')).toBeUndefined()
    expect(jar.unsign(undefined)).toBeUndefined()
  })

  test('another key cannot verify', () => {
    const other = new CookieJar('a-different-key-entirely')

    expect(other.unsign(jar.sign('session-id'))).toBeUndefined()
  })

  test('a value containing the separator still verifies', () => {
    const signed = jar.sign('a|b|c')

    expect(jar.unsign(signed)).toBe('a|b|c')
  })

  test('a short key is refused rather than weakly used', () => {
    expect(() => new CookieJar('short')).toThrow(/at least 16/)
  })

  test('serialize sets the flags a session cookie needs', () => {
    const header = CookieJar.serialize('sid', 'value', { maxAge: 60, secure: true })

    expect(header).toContain('Path=/')
    expect(header).toContain('Max-Age=60')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
  })

  test('parse reads a request header', () => {
    expect(CookieJar.parse('a=1; b=hello%20world')).toEqual({ a: '1', b: 'hello world' })
    expect(CookieJar.parse(null)).toEqual({})
  })

  test('timingSafeEqual compares without leaking length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

// --------------------------------------------------------------------- csrf

describe('CSRF', () => {
  async function session(): Promise<Session> {
    return new Session(Session.newId(), new MemorySessionDriver()).start()
  }

  test('read requests never need a token', async () => {
    const store = await session()

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(tokensMatch(store, { method, path: '/x' })).toBe(true)
    }
  })

  test('a writing request without a token is rejected', async () => {
    const store = await session()

    expect(tokensMatch(store, { method: 'POST', path: '/x' })).toBe(false)
  })

  test('the token is accepted from the body or the header', async () => {
    const store = await session()
    const token = store.token()

    expect(tokensMatch(store, { method: 'POST', path: '/x', body: { _token: token } })).toBe(true)
    expect(
      tokensMatch(store, { method: 'POST', path: '/x', headers: { 'x-csrf-token': token } })
    ).toBe(true)
  })

  test('a wrong token is rejected', async () => {
    const store = await session()

    expect(
      tokensMatch(store, { method: 'POST', path: '/x', body: { _token: 'not-the-token' } })
    ).toBe(false)
  })

  test('exempt paths skip the check, including prefixes', async () => {
    const store = await session()
    const options = { method: 'POST', path: '/webhooks/stripe', except: ['/webhooks/*'] }

    expect(tokensMatch(store, options)).toBe(true)
    expect(isExempt('/webhooks/stripe', ['/webhooks/*'])).toBe(true)
    expect(isExempt('/api/users', ['/webhooks/*'])).toBe(false)
    expect(isExempt('/exact', ['/exact'])).toBe(true)
  })

  test('tokenFromRequest prefers the body field', () => {
    expect(tokenFromRequest({ _token: 'from-body' }, { 'x-csrf-token': 'from-header' })).toBe(
      'from-body'
    )
    expect(tokenFromRequest({}, { 'x-csrf-token': 'from-header' })).toBe('from-header')
    expect(tokenFromRequest(undefined, {})).toBeUndefined()
    // An encrypted X-XSRF-TOKEN needs the encryption package, so it is not
    // silently accepted.
    expect(tokenFromRequest({}, { 'x-xsrf-token': 'encrypted' })).toBeUndefined()
  })

  test('the mismatch error carries a 419', () => {
    expect(new TokenMismatchError().status).toBe(419)
  })
})

describe('encrypted cookies', () => {
  /** A stand-in for the encryption package, with the same two methods. */
  const encrypter = {
    encryptString: (value: string, context?: string) =>
      `enc:${Buffer.from(`${context ?? ''}|${value}`).toString('base64url')}`,
    decryptString: (payload: string, context?: string) => {
      if (!payload.startsWith('enc:')) throw new Error('not a payload')

      const decoded = Buffer.from(payload.slice(4), 'base64url').toString()
      const separator = decoded.indexOf('|')

      // The context is authenticated in the real encrypter; here it is compared,
      // which is enough to prove the jar passes the cookie name through.
      if (decoded.slice(0, separator) !== (context ?? '')) throw new Error('wrong context')

      return decoded.slice(separator + 1)
    }
  }

  test('a jar without an encrypter still signs, and says so', () => {
    const jar = new CookieJar('a-key-of-at-least-16-characters')

    expect(jar.encrypts).toBe(false)
    expect(() => jar.encrypt('session', 'value')).toThrow(/EncryptionServiceProvider/)
  })

  test('an encrypted cookie round-trips under its own name', () => {
    const jar = new CookieJar('a-key-of-at-least-16-characters', encrypter)

    const payload = jar.encrypt('session', 'the-session-id')

    expect(jar.encrypts).toBe(true)
    expect(payload).not.toContain('the-session-id')
    expect(jar.decrypt('session', payload)).toBe('the-session-id')
  })

  test('a value cannot be moved to another cookie', () => {
    const jar = new CookieJar('a-key-of-at-least-16-characters', encrypter)

    const payload = jar.encrypt('remember_token', 'a-long-lived-token')

    // Lifting `remember_token` into `session` has to fail, not merely look odd.
    expect(jar.decrypt('session', payload)).toBeUndefined()
    expect(jar.decrypt('remember_token', payload)).toBe('a-long-lived-token')
  })

  test('a tampered or absent cookie reads as undefined', () => {
    const jar = new CookieJar('a-key-of-at-least-16-characters', encrypter)

    expect(jar.decrypt('session', undefined)).toBeUndefined()
    expect(jar.decrypt('session', 'rubbish')).toBeUndefined()
  })
})
