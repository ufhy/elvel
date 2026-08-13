import { createHash, createHmac } from 'node:crypto'

/**
 * AWS Signature Version 4.
 *
 * Written here rather than pulled in, because the alternative is the AWS SDK —
 * hundreds of packages to sign one HTTP request. The algorithm itself is small
 * and, more to the point, exactly specified: AWS publishes a suite of test
 * vectors giving the canonical request, string to sign and signature for each
 * awkward case, and `test/fixtures/sigv4` holds them. Every rule below is one of
 * those cases, so this is transcription rather than interpretation.
 *
 * Bun signs S3 requests itself, which is why storage needs none of this; SES has
 * no such shortcut.
 */
export type Credentials = {
  accessKeyId: string
  secretAccessKey: string
  /** For temporary credentials. Signed as `x-amz-security-token`. */
  sessionToken?: string | undefined
}

export type SigningRequest = {
  method: string
  /** Absolute URL. Its host becomes the `Host` header. */
  url: string
  headers: Record<string, string>
  body?: string | Uint8Array
  region: string
  service: string
  /** The signing time. Passed in rather than read, so a signature is testable. */
  now: Date
}

const ALGORITHM = 'AWS4-HMAC-SHA256'

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

/** `20150830T123600Z` and `20150830`. */
export function amzDate(now: Date): { long: string; short: string } {
  const long = `${now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '')
    .slice(0, 15)}Z`

  return { long, short: long.slice(0, 8) }
}

/**
 * RFC 3986 encoding — stricter than `encodeURIComponent`.
 *
 * `!'()*` are unreserved to `encodeURIComponent` and reserved to AWS, and a
 * single one of them in a filename is the difference between a signature that
 * verifies and a 403 nobody can explain.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/** Each path segment encoded, with the separators left alone. */
function canonicalPath(pathname: string): string {
  if (pathname === '') return '/'

  return pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/')
}

/** Sorted by name, then by value — both encoded. */
function canonicalQuery(search: URLSearchParams): string {
  const pairs: Array<[string, string]> = []

  for (const [name, value] of search) pairs.push([uriEncode(name), uriEncode(value)])

  pairs.sort((left, right) =>
    left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0])
  )

  return pairs.map(([name, value]) => `${name}=${value}`).join('&')
}

/**
 * Lower-cased names, trimmed values, runs of whitespace collapsed.
 *
 * The collapsing applies inside quotes too — `"a   b   c"` signs as `"a b c"`,
 * which is one of the published vectors and not what anybody guesses.
 */
function canonicalHeaders(headers: Record<string, string>): {
  canonical: string
  signed: string
} {
  const normalised = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort((left, right) => left[0].localeCompare(right[0]))

  return {
    canonical: normalised.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: normalised.map(([name]) => name).join(';')
  }
}

/** The canonical request, exactly as the `.creq` vectors give it. */
export function canonicalRequest(
  request: Pick<SigningRequest, 'method' | 'url' | 'headers' | 'body'>
): { canonical: string; signed: string; payloadHash: string } {
  const url = new URL(request.url)
  const { canonical, signed } = canonicalHeaders(request.headers)
  const payloadHash = sha256(request.body ?? '')

  return {
    canonical: [
      request.method.toUpperCase(),
      canonicalPath(url.pathname),
      canonicalQuery(url.searchParams),
      canonical,
      signed,
      payloadHash
    ].join('\n'),
    signed,
    payloadHash
  }
}

/** The string that actually gets signed. */
export function stringToSign(canonical: string, scope: string, timestamp: string): string {
  return [ALGORITHM, timestamp, scope, sha256(canonical)].join('\n')
}

/**
 * The signing key: four HMACs, each keyed by the last.
 *
 * Derived per day, region and service rather than using the secret directly, so
 * a leaked signature is useless outside that scope.
 */
export function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string
): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request')
}

/**
 * Sign a request, returning the headers to send with it.
 *
 * `Host` and `X-Amz-Date` are added here because they are signed: adding them
 * afterwards, or letting `fetch` add its own, breaks the signature.
 */
export function signRequest(
  request: SigningRequest,
  credentials: Credentials
): Record<string, string> {
  const { long, short } = amzDate(request.now)
  const url = new URL(request.url)

  const headers: Record<string, string> = {
    ...request.headers,
    host: url.host,
    'x-amz-date': long,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {})
  }

  const { canonical, signed, payloadHash } = canonicalRequest({ ...request, headers })
  const scope = `${short}/${request.region}/${request.service}/aws4_request`

  const signature = createHmac(
    'sha256',
    signingKey(credentials.secretAccessKey, short, request.region, request.service)
  )
    .update(stringToSign(canonical, scope, long))
    .digest('hex')

  return {
    ...headers,
    // The payload hash is signed, and SES rejects a request whose header
    // disagrees with what was signed — so it is sent rather than recomputed.
    'x-amz-content-sha256': payloadHash,
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`
  }
}
