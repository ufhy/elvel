import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { canonicalRequest, signingKey, stringToSign } from '@elyvel/support'
import type { SentMessage } from '../src/message.ts'
import { SesTransport } from '../src/transports/ses.ts'

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
}

type Received = { body: Record<string, unknown>; verified: boolean; reason?: string }

let server: ReturnType<typeof Bun.serve>
let last: Received | undefined

/**
 * A stand-in for SES that **recomputes the signature** and refuses the request
 * if it does not match.
 *
 * A stub that accepted anything would prove only that a POST was made. This one
 * derives the same signing key from the same secret and rebuilds the canonical
 * request from what actually arrived over the socket, so a transport that signs
 * the wrong headers, the wrong body, or the wrong path gets a 403 here exactly
 * as it would from AWS.
 */
function verify(request: Request, body: string): { ok: boolean; reason?: string } {
  const authorization = request.headers.get('authorization') ?? ''
  const match =
    /Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(
      authorization
    )

  if (!match) return { ok: false, reason: `unparseable authorization: ${authorization}` }

  const [, keyId, date, region, service, signedHeaders, signature] = match as unknown as string[]

  if (keyId !== CREDENTIALS.accessKeyId) return { ok: false, reason: 'wrong key id' }

  // Only the headers the transport said it signed, in the order it said.
  const headers: Record<string, string> = {}
  for (const name of (signedHeaders as string).split(';')) {
    headers[name] = request.headers.get(name) ?? ''
  }

  const { canonical } = canonicalRequest({
    method: request.method,
    url: request.url,
    headers,
    body
  })

  const scope = `${date}/${region}/${service}/aws4_request`
  const expected = createHmac(
    'sha256',
    signingKey(CREDENTIALS.secretAccessKey, date as string, region as string, service as string)
  )
    .update(stringToSign(canonical, scope, request.headers.get('x-amz-date') ?? ''))
    .digest('hex')

  return expected === signature ? { ok: true } : { ok: false, reason: 'signature mismatch' }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text()
      const result = verify(request, body)

      last = {
        body: JSON.parse(body) as Record<string, unknown>,
        verified: result.ok,
        ...(result.reason === undefined ? {} : { reason: result.reason })
      }

      if (!result.ok) {
        return Response.json({ message: result.reason }, { status: 403 })
      }

      return Response.json({ MessageId: 'ses-message-id' })
    }
  })
})

afterAll(() => {
  server.stop(true)
})

const transport = () =>
  new SesTransport({
    ...CREDENTIALS,
    region: 'eu-west-1',
    endpoint: `http://127.0.0.1:${server.port}`
  })

const message = (overrides: Partial<SentMessage> = {}): SentMessage => ({
  mailable: 'Welcome',
  from: { address: 'hello@example.com', name: 'Elyvel' },
  to: [{ address: 'ada@example.com' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Welcome',
  html: '<p>Hello.</p>',
  text: 'Hello.',
  attachments: [],
  tags: [],
  metadata: {},
  headers: {},
  ...overrides
})

describe('SES over a real socket', () => {
  test('the signature verifies against a recomputed one', async () => {
    const result = await transport().send(message())

    expect<boolean>(last?.verified === true).toBe(true)
    expect<string | undefined>(result.id).toBe('ses-message-id')
    expect<string>(result.transport).toBe('ses')
  })

  test('a message with no attachment goes as Simple content', async () => {
    await transport().send(message({ headers: { 'X-Campaign': 'spring' } }))

    const content = last?.body.Content as {
      Simple?: { Subject: { Data: string }; Body: { Html?: { Data: string } }; Headers?: unknown[] }
    }

    // SES builds the MIME itself, which is what you want with nothing to attach.
    expect<string | undefined>(content.Simple?.Subject.Data).toBe('Welcome')
    expect<string | undefined>(content.Simple?.Body.Html?.Data).toBe('<p>Hello.</p>')
    expect<number>(content.Simple?.Headers?.length ?? 0).toBe(1)
  })

  test('an attachment forces Raw, and the MIME carries the file', async () => {
    await transport().send(
      message({
        attachments: [{ filename: 'report.txt', content: 'total: 42', contentType: 'text/plain' }]
      })
    )

    const content = last?.body.Content as { Raw?: { Data: string }; Simple?: unknown }

    // Simple has nowhere to put an attachment, so this is not a preference.
    expect<unknown>(content.Simple).toBeUndefined()

    const mime = Buffer.from(content.Raw?.Data ?? '', 'base64').toString()

    expect<boolean>(mime.includes('filename=report.txt')).toBe(true)
    expect<boolean>(mime.includes('multipart/')).toBe(true)
    // Still verified: the signature covers the base64 body, which is the case
    // most likely to break if the payload hash were computed before encoding.
    expect<boolean>(last?.verified === true).toBe(true)
  })

  test('recipients, reply-to and tags reach the request', async () => {
    await transport().send(
      message({
        cc: [{ address: 'cc@example.com' }],
        bcc: [{ address: 'bcc@example.com' }],
        replyTo: [{ address: 'support@example.com' }],
        tags: ['welcome']
      })
    )

    const destination = last?.body.Destination as Record<string, string[]>

    expect<string[] | undefined>(destination.CcAddresses).toEqual(['cc@example.com'])
    expect<string[] | undefined>(destination.BccAddresses).toEqual(['bcc@example.com'])
    expect<unknown>(last?.body.ReplyToAddresses).toEqual(['support@example.com'])
    // A message that silently loses its tags is one nobody can report on.
    expect<unknown>(last?.body.EmailTags).toEqual([{ Name: 'welcome', Value: '' }])
  })

  test('a rejection names the status and what SES said', async () => {
    const wrongKey = new SesTransport({
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'not-the-right-secret',
      region: 'eu-west-1',
      endpoint: `http://127.0.0.1:${server.port}`
    })

    await expect(wrongKey.send(message())).rejects.toThrow('SES rejected the message (403)')
  })
})
