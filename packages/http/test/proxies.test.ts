import { describe, expect, test } from 'bun:test'
import {
  AWS_ELB_HEADERS,
  clientHost,
  clientIp,
  clientPort,
  clientPrefix,
  clientProtocol,
  clientUrl,
  isTrustedProxy
} from '../src/proxies.ts'

const request = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/orders', { headers })

const socket = (address: string) => ({ address })

describe('trusting a proxy', () => {
  test('nothing is trusted by default', () => {
    expect(isTrustedProxy('10.0.0.1', {})).toBe(false)
    expect(isTrustedProxy('10.0.0.1', { trustedProxies: [] })).toBe(false)
  })

  test('a named proxy is', () => {
    expect(isTrustedProxy('10.0.0.1', { trustedProxies: ['10.0.0.1'] })).toBe(true)
    expect(isTrustedProxy('10.0.0.2', { trustedProxies: ['10.0.0.1'] })).toBe(false)
  })

  test("'*' says I am always behind one", () => {
    expect(isTrustedProxy('anything', { trustedProxies: '*' })).toBe(true)
  })
})

describe('the client address', () => {
  test('untrusted, a forwarding header is ignored', () => {
    // Anyone can send this header. Believing it while directly exposed hands every
    // caller a fresh identity per request, and a rate limit that counts nothing.
    const ip = clientIp(request({ 'x-forwarded-for': '9.9.9.9' }), socket('203.0.113.5'))

    expect(ip).toBe('203.0.113.5')
  })

  test('trusted, the first entry of the chain is the client', () => {
    // client, then each proxy in turn: everything after the first was appended by
    // infrastructure rather than sent by the caller.
    const ip = clientIp(
      request({ 'x-forwarded-for': '9.9.9.9, 10.0.0.9, 10.0.0.1' }),
      socket('10.0.0.1'),
      { trustedProxies: ['10.0.0.1'] }
    )

    expect(ip).toBe('9.9.9.9')
  })

  test('a trusted proxy that forwards nothing is itself', () => {
    expect(clientIp(request(), socket('10.0.0.1'), { trustedProxies: '*' })).toBe('10.0.0.1')
  })

  test('an IPv4-mapped address is reported as IPv4', () => {
    // Bun reports an IPv4 client through an IPv6 socket this way, so `ip ===
    // '127.0.0.1'` in a limiter would never match — an exemption that silently
    // never fires.
    expect(clientIp(request(), socket('::ffff:127.0.0.1'))).toBe('127.0.0.1')
    expect(
      clientIp(request({ 'x-forwarded-for': '::ffff:8.8.8.8' }), socket('10.0.0.1'), {
        trustedProxies: '*'
      })
    ).toBe('8.8.8.8')
  })

  test('a real IPv6 address is left alone', () => {
    expect(clientIp(request(), socket('2001:db8::1'))).toBe('2001:db8::1')
  })

  test('no socket at all is an empty address rather than a crash', () => {
    expect(clientIp(request(), undefined)).toBe('')
  })
})

describe('protocol and host', () => {
  test('untrusted, the request itself decides', () => {
    const forwarded = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.test' }

    expect(clientProtocol(request(forwarded), socket('203.0.113.5'))).toBe('http')
    expect(clientHost(request(forwarded), socket('203.0.113.5'))).toBe('localhost')
  })

  test('trusted, the headers do', () => {
    const forwarded = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.test' }
    const options = { trustedProxies: '*' } as const

    expect(clientProtocol(request(forwarded), socket('10.0.0.1'), options)).toBe('https')
    expect(clientHost(request(forwarded), socket('10.0.0.1'), options)).toBe('public.test')
  })

  test('a chain in the proto header takes its first entry', () => {
    expect(
      clientProtocol(request({ 'x-forwarded-proto': 'https, http' }), socket('10.0.0.1'), {
        trustedProxies: '*'
      })
    ).toBe('https')
  })
})

const trusted = { trustedProxies: ['10.0.0.1'] }
const proxy = socket('10.0.0.1')

describe('the mount prefix', () => {
  test('a gateway that strips /api tells us so', () => {
    // Without this every generated link points at `/orders`, which exists only
    // inside the cluster.
    expect<string>(clientPrefix(request({ 'x-forwarded-prefix': '/api' }), proxy, trusted)).toBe(
      '/api'
    )
  })

  test('a trailing slash is dropped and a missing one added', () => {
    expect<string>(clientPrefix(request({ 'x-forwarded-prefix': '/api/' }), proxy, trusted)).toBe(
      '/api'
    )
    expect<string>(clientPrefix(request({ 'x-forwarded-prefix': 'api' }), proxy, trusted)).toBe(
      '/api'
    )
    expect<string>(clientPrefix(request({ 'x-forwarded-prefix': '/' }), proxy, trusted)).toBe('')
  })

  test('an untrusted client cannot claim one', () => {
    expect<string>(
      clientPrefix(request({ 'x-forwarded-prefix': '/api' }), socket('203.0.113.9'), trusted)
    ).toBe('')
  })

  test('no header is no prefix', () => {
    expect<string>(clientPrefix(request(), proxy, trusted)).toBe('')
  })
})

describe('the client port', () => {
  test('the forwarded port wins', () => {
    expect<number | undefined>(
      clientPort(request({ 'x-forwarded-port': '8443' }), proxy, trusted)
    ).toBe(8443)
  })

  test('a nonsense port falls through rather than poisoning a URL', () => {
    expect<number | undefined>(
      clientPort(request({ 'x-forwarded-port': 'nope' }), proxy, trusted)
    ).toBe(80)
  })

  test('the host header carries it when the port header does not', () => {
    expect<number | undefined>(
      clientPort(request({ 'x-forwarded-host': 'shop.test:8080' }), proxy, trusted)
    ).toBe(8080)
  })

  test('otherwise it is the default for the scheme', () => {
    expect<number | undefined>(clientPort(request(), proxy, trusted)).toBe(80)
    expect<number | undefined>(
      clientPort(request({ 'x-forwarded-proto': 'https' }), proxy, trusted)
    ).toBe(443)
  })
})

describe('narrowing which headers are believed', () => {
  test("AWS's balancer never sends a host, so a claimed one is ignored", () => {
    const spoofed = request({ 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' })
    const options = { ...trusted, trustedHeaders: AWS_ELB_HEADERS }

    // Host is what a password-reset link is built from; believing a claimed one
    // sends the link to the attacker.
    expect<string>(clientHost(spoofed, proxy, options)).toBe('localhost')
    expect<string>(clientProtocol(spoofed, proxy, options)).toBe('https')
  })
})

describe('the URL the client actually asked for', () => {
  test('scheme, host and prefix all come from the proxy', () => {
    const forwarded = request({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'shop.test',
      'x-forwarded-prefix': '/api'
    })

    expect<string>(clientUrl(forwarded, proxy, trusted)).toBe('https://shop.test/api/orders')
  })

  test('a non-standard port is kept and a standard one is not', () => {
    expect<string>(
      clientUrl(
        request({ 'x-forwarded-host': 'shop.test', 'x-forwarded-port': '8080' }),
        proxy,
        trusted
      )
    ).toBe('http://shop.test:8080/orders')

    expect<string>(
      clientUrl(
        request({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'shop.test' }),
        proxy,
        trusted
      )
    ).toBe('https://shop.test/orders')
  })

  test('with no proxy it is just the request', () => {
    expect<string>(clientUrl(request(), socket('203.0.113.9'), trusted)).toBe(
      'http://localhost/orders'
    )
  })
})
