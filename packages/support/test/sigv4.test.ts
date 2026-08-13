import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { canonicalRequest, signRequest, stringToSign, uriEncode } from '../src/sigv4.ts'

/**
 * AWS's own signing test suite.
 *
 * Each case is four files: the raw request, the canonical request it must
 * produce, the string to sign, and the Authorization header. The credentials,
 * region, service and timestamp are the ones the suite documents.
 *
 * These are the cases that catch a signer: a header value with runs of spaces
 * inside quotes, duplicate header names, query parameters that sort by key
 * *case*, and a non-ASCII path. Passing them is the difference between a
 * transport that works and one that returns 403 with no explanation.
 */
const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
}

const REGION = 'us-east-1'
const SERVICE = 'service'
const WHEN = new Date('2015-08-30T12:36:00Z')

const CASES = [
  'get-vanilla',
  'get-header-value-trim',
  'get-header-key-duplicate',
  'get-vanilla-query-order-key-case',
  'get-utf8',
  'post-header-key-sort'
]

/**
 * A case whose own files disagree, so only the canonical request is checked.
 *
 * `post-x-www-form-urlencoded.creq` signs `content-length` and its `.authz`
 * does not — the two cannot both be right, and the signature in the `.authz`
 * is the one that matches its `.sts`. The canonical request is still worth
 * running: it is the only vector with a request body, and hashing the payload
 * is exactly what a POST to SES depends on.
 */
const CANONICAL_ONLY = ['post-x-www-form-urlencoded']

const fixture = (name: string, extension: string) =>
  Bun.file(join(import.meta.dir, 'fixtures/sigv4', `${name}.${extension}`)).text()

/** Parse the suite's `.req` file into what a signer takes. */
async function parse(name: string): Promise<{
  method: string
  url: string
  headers: Record<string, string>
  body: string
}> {
  const raw = await fixture(name, 'req')
  const [head = '', ...rest] = raw.split('\n\n')
  const [requestLine = '', ...headerLines] = head.split('\n')

  const [method = 'GET', target = '/'] = requestLine.split(' ')
  const headers: Record<string, string> = {}

  for (const line of headerLines) {
    const separator = line.indexOf(':')
    if (separator === -1) continue

    const key = line.slice(0, separator).toLowerCase()
    const value = line.slice(separator + 1)

    // Duplicates join with a comma, in the order they arrived — one of the cases.
    headers[key] = headers[key] === undefined ? value : `${headers[key]},${value}`
  }

  return {
    method,
    url: new URL(target, `https://${headers.host ?? 'example.amazonaws.com'}`).toString(),
    headers,
    body: rest.join('\n\n')
  }
}

describe("AWS's published signing vectors", () => {
  for (const name of CASES) {
    test(name, async () => {
      const request = await parse(name)
      const { canonical } = canonicalRequest(request)

      expect<string>(canonical).toBe(await fixture(name, 'creq'))

      const scope = `20150830/${REGION}/${SERVICE}/aws4_request`

      expect<string>(stringToSign(canonical, scope, '20150830T123600Z')).toBe(
        await fixture(name, 'sts')
      )

      const signed = signRequest(
        { ...request, region: REGION, service: SERVICE, now: WHEN },
        CREDENTIALS
      )

      expect<string | undefined>(signed.authorization).toBe(await fixture(name, 'authz'))
    })
  }
})

describe('a vector whose published files disagree', () => {
  for (const name of CANONICAL_ONLY) {
    test(`${name} (canonical request only)`, async () => {
      const request = await parse(name)

      expect<string>(canonicalRequest(request).canonical).toBe(await fixture(name, 'creq'))
      // The body is what makes this case worth keeping.
      expect<string>(canonicalRequest(request).payloadHash).toBe(
        '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e'
      )
    })
  }
})

describe('encoding', () => {
  test("!'()* are reserved to AWS even though they are not to encodeURIComponent", () => {
    // One of these in a filename is a signature that verifies against nothing,
    // and a 403 with no explanation attached.
    expect<string>(uriEncode("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af')
  })

  test('a space is %20, never a plus', () => {
    expect<string>(uriEncode('a b')).toBe('a%20b')
  })
})

describe('temporary credentials', () => {
  test('the session token is signed, not merely sent', async () => {
    const request = await parse('get-vanilla')

    const signed = signRequest(
      { ...request, region: REGION, service: SERVICE, now: WHEN },
      { ...CREDENTIALS, sessionToken: 'TOKEN' }
    )

    // Signed as well as sent: AWS rejects a token that was not covered by the
    // signature, and the failure looks like bad credentials rather than a bug.
    expect<boolean>(signed.authorization?.includes('x-amz-security-token') === true).toBe(true)
    expect<string | undefined>(signed['x-amz-security-token']).toBe('TOKEN')
  })
})
