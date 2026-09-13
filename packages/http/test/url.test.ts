import { afterEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { RouteRegistry } from '../src/routes.ts'
import { asset, secureAsset, secureUrl, Url, url } from '../src/url.ts'

function boot(config: Record<string, string> = {}): RouteRegistry {
  const app = new Application(process.cwd())
  const registry = new RouteRegistry()

  registry.origin = config['app.url'] ?? 'http://example.com'

  app.config.set('app.url', registry.origin)
  app.config.set('app.assetUrl', config['app.assetUrl'] ?? '')
  app.instance('routes', registry)

  return registry
}

afterEach(() => {
  Url.forceScheme(undefined)
})

describe('url', () => {
  test('a path is joined to the origin', () => {
    boot()

    expect(url('/articles')).toBe('http://example.com/articles')
    expect(url('articles')).toBe('http://example.com/articles')
  })

  test('the origin alone', () => {
    boot()

    expect(url()).toBe('http://example.com')
  })

  test('leftovers become the query string', () => {
    boot()

    expect(url('/articles', { page: 2, sort: 'new' })).toBe(
      'http://example.com/articles?page=2&sort=new'
    )
  })

  /** So a value that may already be one does not need checking at the call site. */
  test('an absolute URL is returned untouched', () => {
    boot()

    expect(url('https://cdn.example.net/a.png')).toBe('https://cdn.example.net/a.png')
  })

  test('secureUrl is the same over https', () => {
    boot()

    expect(secureUrl('/pay')).toBe('https://example.com/pay')
  })
})

describe('asset', () => {
  test('comes from the application when no host is configured', () => {
    boot()

    expect(asset('/img/logo.svg')).toBe('http://example.com/img/logo.svg')
  })

  test('and from the configured host when there is one', () => {
    boot({ 'app.assetUrl': 'https://cdn.example.net/' })

    expect(asset('img/logo.svg')).toBe('https://cdn.example.net/img/logo.svg')
    expect(secureAsset('img/logo.svg')).toBe('https://cdn.example.net/img/logo.svg')
  })
})

/**
 * The case this exists for: TLS ends at the proxy, so the application sees http
 * and mails a link a browser will not post a form back to.
 */
describe('a forced scheme', () => {
  test('rewrites every absolute URL', () => {
    boot({ 'app.url': 'http://example.com' })

    Url.forceScheme('https')

    expect(url('/reset')).toBe('https://example.com/reset')
    expect(asset('/img/logo.svg')).toBe('https://example.com/img/logo.svg')
  })

  test('and stops when it is cleared', () => {
    boot()

    Url.forceScheme('https')
    Url.forceScheme(undefined)

    expect(url('/reset')).toBe('http://example.com/reset')
  })
})

describe('URL defaults', () => {
  test('fill a placeholder nobody passed', () => {
    const registry = boot()

    registry.name('articles.show', '/{locale}/articles/{id}')
    Url.defaults({ locale: 'id' })

    expect(registry.to('articles.show', { id: 12 })).toBe('/id/articles/12')
  })

  test('an explicit parameter still wins', () => {
    const registry = boot()

    registry.name('articles.show', '/{locale}/articles/{id}')
    Url.defaults({ locale: 'id' })

    expect(registry.to('articles.show', { id: 12, locale: 'en' })).toBe('/en/articles/12')
  })

  /** A default is not a query parameter: an unused one must not reach the URL. */
  test('an unused default is not appended', () => {
    const registry = boot()

    registry.name('articles.index', '/articles')
    Url.defaults({ locale: 'id' })

    expect(registry.to('articles.index')).toBe('/articles')
  })

  test('and they can be read back', () => {
    boot()

    Url.defaults({ locale: 'id' })

    expect(Url.defaulted()).toEqual({ locale: 'id' })
  })
})
