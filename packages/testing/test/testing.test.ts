import { describe, expect, test as it } from 'bun:test'
import { Application } from '@elysian/core'
import { Elysia } from 'elysia'
import { AssertionError, artisan, test } from '../src/index.ts'

/** The assertion failed, and said something useful about why. */
function refuses(callback: () => unknown, matching: RegExp): void {
  try {
    callback()
  } catch (error) {
    expect(error).toBeInstanceOf(AssertionError)
    expect((error as Error).message).toMatch(matching)

    return
  }

  throw new Error('Expected the assertion to fail, but it passed.')
}

/** A small application, pressed the way a real one is. */
function application(): Application {
  const app = new Application(process.cwd())

  app.router.use(
    new Elysia()
      .get('/plain', () => 'Hello there')
      .get('/html', () => '<ul><li>Ada</li><li>Grace</li></ul>')
      .get('/posts', () => ({
        data: [
          { id: 1, title: 'First', tags: ['a'] },
          { id: 2, title: 'Second', tags: [] }
        ],
        meta: { total: 2 }
      }))
      .get('/empty', ({ status }) => status(204))
      .get('/gone', ({ status }) => status(404, { message: 'Not found.' }))
      .get('/away', ({ redirect }) => redirect('/plain'))
      .get('/who', ({ headers }) => ({ token: headers.authorization ?? null }))
      .get('/biscuit', ({ cookie }) => {
        cookie.taste?.set({ value: 'sweet' })

        return 'set'
      })
      .get('/stale', ({ cookie }) => {
        cookie.old?.set({ value: '', expires: new Date(0) })

        return 'cleared'
      })
      .post('/echo', ({ body }) => ({ received: body }))
      .post('/invalid', ({ status }) =>
        status(422, { message: 'Invalid.', errors: { email: ['The email must be valid.'] } })
      )
  )

  return app
}

describe('pressing a route', () => {
  const app = application()

  it('reads a plain body and its status', async () => {
    const response = await test(app).get('/plain')

    response.assertOk().assertSuccessful().assertContent('Hello there').assertSee('Hello')
  })

  it('strips tags for a text assertion', async () => {
    const response = await test(app).get('/html')

    response.assertSee('<li>Ada</li>').assertSeeText('Ada Grace').assertSeeInOrder(['Ada', 'Grace'])

    // Order is the point: the reverse must fail even though both are present.
    refuses(() => response.assertSeeInOrder(['Grace', 'Ada']), /after the previous value/)
  })

  it('carries headers, and a token', async () => {
    const response = await test(app).withToken('abc123').getJson('/who')

    response.assertJsonPath('token', 'Bearer abc123')
  })

  it('sends a JSON body and reads it back', async () => {
    const response = await test(app).postJson('/echo', { name: 'Ada' })

    response.assertOk().assertJson({ received: { name: 'Ada' } })
  })

  it('reports the body when the status is wrong', async () => {
    const response = await test(app).getJson('/gone')

    // The reason is already in the body; a bare status mismatch would hide it.
    refuses(() => response.assertOk(), /Not found/)
    response.assertNotFound().assertClientError()
  })

  it('asserts an empty 204', async () => {
    const response = await test(app).get('/empty')

    response.assertNoContent()
  })
})

describe('json assertions', () => {
  const app = application()

  it('contains, exactly, and by path', async () => {
    const response = await test(app).getJson('/posts')

    response
      .assertJson({ meta: { total: 2 } })
      .assertJsonPath('data.0.title', 'First')
      .assertJsonPath('meta.total', (value) => typeof value === 'number')
      .assertJsonCount(2, 'data')
      .assertJsonMissingPath('data.0.secret')

    refuses(() => response.assertExactJson({ meta: { total: 2 } }), /exactly/)
  })

  it('finds a fragment at any depth', async () => {
    const response = await test(app).getJson('/posts')

    response.assertJsonFragment({ title: 'Second' })
    refuses(() => response.assertJsonFragment({ title: 'Third' }), /somewhere in the JSON body/)
  })

  it('checks a structure, walking arrays with a star', async () => {
    const response = await test(app).getJson('/posts')

    response.assertJsonStructure({ data: { '*': ['id', 'title'] }, meta: ['total'] })
    refuses(
      () => response.assertJsonStructure({ data: { '*': ['id', 'slug'] } }),
      /to have property \[slug\]/
    )
  })

  it('fails an assertion on a body that is not JSON', async () => {
    const response = await test(app).get('/plain')

    refuses(() => response.assertJson({}), /could not be decoded/)
  })
})

describe('the fluent walk', () => {
  const app = application()

  it('holds a scope to what it touched', async () => {
    const response = await test(app).getJson('/posts')

    response.assertJsonFluent((json) => {
      json
        .has('data', 2, (data) => {
          data.each((post) => post.hasAll('id', 'title').etc())
        })
        .has('meta', undefined, (meta) => meta.where('total', 2))
    })
  })

  it('complains about a property nothing asserted', async () => {
    const response = await test(app).getJson('/posts')

    // `meta` is never touched — which is the whole point of the check.
    refuses(
      () => response.assertJsonFluent((json) => json.has('data')),
      /Unexpected properties on the root: \[meta\]/
    )
  })

  it('etc() opts a scope out', async () => {
    const response = await test(app).getJson('/posts')

    response.assertJsonFluent((json) => json.has('data').etc())
  })

  it('checks types and counts', async () => {
    const response = await test(app).getJson('/posts')

    response.assertJsonFluent((json) => {
      json
        .whereType('data', 'array')
        .has('data', undefined, (data) => {
          data.count(2).first((post) => post.where('id', 1).etc())
        })
        .etc()
    })
  })
})

describe('headers, cookies and redirects', () => {
  const app = application()

  it('asserts a cookie that was set', async () => {
    const response = await test(app).get('/biscuit')

    response.assertCookie('taste', 'sweet').assertCookieMissing('other')
  })

  it('tells an expired cookie from an absent one', async () => {
    const response = await test(app).get('/stale')

    // A cleared cookie is *sent* with a past expiry, not omitted.
    response.assertCookie('old').assertCookieExpired('old')
    refuses(() => response.assertCookieExpired('taste'), /Expected a \[taste\] cookie/)
  })

  it('asserts where a redirect went, without following it', async () => {
    const response = await test(app).get('/away')

    response.assertRedirect('/plain').assertRedirectContains('plain')
  })

  it('follows the redirect when asked', async () => {
    const response = await test(app).followingRedirects().get('/away')

    response.assertOk().assertContent('Hello there')
  })

  it('asserts a header, and its absence', async () => {
    const response = await test(app).getJson('/posts')

    response.assertHeaderContains('content-type', 'json').assertHeaderMissing('x-nothing')
  })
})

describe('validation assertions', () => {
  const app = application()

  it('reads the error bag out of a 422', async () => {
    const response = await test(app).postJson('/invalid', {})

    response.assertUnprocessable().assertInvalid('email').assertInvalid({ email: 'must be valid' })
    refuses(() => response.assertInvalid('name'), /saw errors for \[email\]/)
    refuses(() => response.assertValid(), /Expected no validation errors/)
  })

  it('a successful response is valid', async () => {
    const response = await test(app).getJson('/posts')

    response.assertValid().assertValid('email')
  })
})

describe('the builder', () => {
  const app = application()

  it('does not mutate the base', async () => {
    const base = test(app)
    const withToken = base.withToken('abc')

    await (await withToken.getJson('/who')).assertJsonPath('token', 'Bearer abc')
    // The base never learned about the token.
    await (await base.getJson('/who')).assertJsonPath('token', null)
  })

  it('carries cookies from one response into the next request', async () => {
    const first = await test(app).get('/biscuit')
    const second = await test(app).withCookiesFrom(first).getJson('/who')

    second.assertOk()
  })
})

describe('actingAs', () => {
  /** A stand-in for `AuthManager`, recording what it was told. */
  function impersonator() {
    const calls: string[] = []

    return {
      calls,
      impersonate: (value: unknown) =>
        calls.push(`impersonate:${(value as { user?: { id?: string } })?.user?.id ?? 'guest'}`),
      stopImpersonating: () => calls.push('stop')
    }
  }

  function appWith(auth: unknown): Application {
    const app = new Application(process.cwd())
    app.instance('auth' as never, auth as never)
    app.router.use(new Elysia().get('/plain', () => 'Hello there'))

    return app
  }

  it('impersonates for the callback and restores after it', async () => {
    const auth = impersonator()
    const app = appWith(auth)

    await test(app).actingAs({ id: 'ada' }, async (request) => {
      ;(await request.get('/plain')).assertOk()
    })

    expect<string[]>(auth.calls).toEqual(['impersonate:ada', 'stop'])
  })

  it('restores even when an assertion inside it fails', async () => {
    const auth = impersonator()
    const app = appWith(auth)

    await expect(
      test(app).actingAs({ id: 'ada' }, async (request) => {
        ;(await request.get('/plain')).assertNotFound()
      })
    ).rejects.toBeInstanceOf(AssertionError)

    // The point: a failing test must not leave the next one authenticated.
    expect<string[]>(auth.calls).toEqual(['impersonate:ada', 'stop'])
  })

  it('says what is missing when auth is not registered', async () => {
    const app = new Application(process.cwd())

    await expect(test(app).actingAs({ id: 'ada' }, async () => undefined)).rejects.toThrow(
      /needs the auth package/
    )
  })
})

describe('artisan commands', () => {
  it('captures output and the exit code', async () => {
    const kernel = {
      run: async (argv: string[]) => {
        console.log(`ran ${argv.join(' ')}`)

        return 0
      }
    }

    const command = await artisan(kernel, ['migrate', '--force']).run()

    command.assertSuccessful().assertOutputContains('ran migrate --force')
  })

  it('strips colour before matching', async () => {
    const esc = String.fromCharCode(27)
    const kernel = {
      run: async () => {
        console.log(`${esc}[32mdone${esc}[39m`)

        return 0
      }
    }

    const command = await artisan(kernel, ['x']).run()

    command.assertOutputContains('done')
  })

  it('reports a failure with the output attached', async () => {
    const kernel = {
      run: async () => {
        console.error('it went wrong')

        return 1
      }
    }

    const command = await artisan(kernel, ['x']).run()

    command.assertFailed()
    refuses(() => command.assertSuccessful(), /it went wrong/)
  })

  it('answers queued questions, and matches them by text', async () => {
    const prompts = {
      ask: async (_question: string) => 'typed',
      confirm: async (_question: string) => false
    }

    const kernel = {
      run: async () => {
        console.log(await prompts.ask('What is the name?'))
        console.log(String(await prompts.confirm('Overwrite the file?')))

        return 0
      }
    }

    const command = await artisan(kernel, ['make:thing'], prompts)
      .expectsQuestion('Overwrite', true)
      .expectsQuestion('name', 'Post')
      .run()

    // Queued out of order on purpose: each answer found its own question.
    command.assertSuccessful().assertOutputInOrder(['Post', 'true']).assertAllQuestionsAnswered()
  })

  it('fails rather than hanging when a question has no answer', async () => {
    const prompts = { ask: async (_question: string) => 'typed' }
    const kernel = {
      run: async () => {
        await prompts.ask('Who goes there?')

        return 0
      }
    }

    await expect(artisan(kernel, ['x'], prompts).run()).rejects.toThrow(/no answer was queued/)
  })

  it('restores the prompts even when the command throws', async () => {
    const original = async (_question: string) => 'untouched'
    const prompts = { ask: original }
    const kernel = {
      run: async () => {
        throw new Error('boom')
      }
    }

    await expect(artisan(kernel, ['x'], prompts).run()).rejects.toThrow('boom')
    expect(prompts.ask).toBe(original)
  })
})
