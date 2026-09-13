import { HttpException } from '@elvel/core'
import { Elysia } from 'elysia'

/** 400, because the request is malformed rather than refused on its merits. */
export class UntrustedHostError extends HttpException {
  constructor(host: string) {
    super(400, `The Host header [${host}] is not one this application answers for.`)
    this.name = 'UntrustedHostError'
  }
}

export type TrustHostsOptions = {
  /** Hosts this application answers for. `*.example.com` matches one level. */
  allow: readonly string[]
}

/**
 * Refuse a request whose `Host` is not one of ours.
 *
 * The header decides every generated URL — a password-reset link, a signed URL,
 * an absolute `route()`. A request carrying `Host: attacker.example` therefore
 * produces a reset link pointing there, which is mailed to the account's owner,
 * who clicks it and hands over the token. The application never sees anything
 * wrong.
 *
 * `clientHost()` already refuses to believe `X-Forwarded-Host` from an untrusted
 * proxy. This is the other half: the raw header, when there is no proxy at all.
 *
 * Checked before anything else runs, so a refused host costs a comparison rather
 * than a session read and a database round trip.
 */
export function trustHostsPlugin(options: TrustHostsOptions) {
  const patterns = options.allow.map(compile)

  return new Elysia({ name: 'elvel:trust-hosts' }).onRequest(({ request }) => {
    // The port is not part of the identity: `example.com` and
    // `example.com:8443` are the same site, and requiring both in the list is
    // how a deployment behind a non-standard port gets locked out of itself.
    const host = hostWithoutPort(request.headers.get('host') ?? new URL(request.url).host)

    if (patterns.some((matches) => matches(host))) return

    throw new UntrustedHostError(host)
  })
}

/** `example.com:8443` -> `example.com`, IPv6 literals included. */
export function hostWithoutPort(host: string): string {
  const lowered = host.trim().toLowerCase()
  const separator = lowered.lastIndexOf(':')

  if (separator === -1) return lowered

  // `[::1]:3000` has a colon inside the brackets too; the port is after them.
  if (lowered.includes(']', separator)) return lowered

  return lowered.slice(0, separator)
}

/**
 * `*.example.com` matches `app.example.com` and **not** `example.com` or
 * `a.b.example.com` — one level, because a wildcard that crossed dots would let
 * a subdomain somebody else controls in.
 */
function compile(pattern: string): (host: string) => boolean {
  const lowered = hostWithoutPort(pattern)

  if (!lowered.startsWith('*.')) return (host) => host === lowered

  const suffix = lowered.slice(1)

  return (host) => host.endsWith(suffix) && !host.slice(0, -suffix.length).includes('.')
}

/**
 * The hosts to trust when nothing is configured: whatever `app.url` names.
 *
 * A default rather than "everything", because an application that never thought
 * about this is the one the attack is aimed at. `localhost` and `127.0.0.1` come
 * with it so a development machine is not locked out by its own default.
 */
export function hostsFor(appUrl: string | undefined, configured: readonly string[]): string[] {
  if (configured.length > 0) return [...configured]

  const hosts = ['localhost', '127.0.0.1', '[::1]']

  if (appUrl) {
    try {
      hosts.push(hostWithoutPort(new URL(appUrl).host))
    } catch {
      // A malformed `app.url` is not this plugin's error to raise.
    }
  }

  return hosts
}
