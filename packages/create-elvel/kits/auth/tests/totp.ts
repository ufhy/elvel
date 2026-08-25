/**
 * A TOTP code, the way an authenticator app computes one.
 *
 * RFC 6238 over RFC 4226: base32-decode the secret, HMAC-SHA1 the 30-second
 * counter, and read six digits out of the offset the last nibble points at. It is
 * written out here rather than imported so that this file needs no dependency
 * beyond what the application already has — and it cannot quietly be wrong,
 * because the only assertion it feeds is the server accepting the code.
 */
export async function totp(base32Secret: string): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''

  for (const character of base32Secret.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character)

    if (index === -1) continue

    bits += index.toString(2).padStart(5, '0')
  }

  const bytes = new Uint8Array(Math.floor(bits.length / 8))

  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)
  }

  /**
   * better-auth stores the secret as text and base32-encodes it for the URI, so
   * the bytes above are that text — and the HMAC key is the text, not the bytes
   * of some further decoding. Getting this backwards produces codes that look
   * perfectly plausible and are always rejected.
   */
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign'
  ])

  const counter = Math.floor(Date.now() / 1000 / 30)
  const message = new DataView(new ArrayBuffer(8))
  message.setUint32(0, Math.floor(counter / 2 ** 32))
  message.setUint32(4, counter % 2 ** 32)

  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message.buffer))
  const offset = (digest.at(-1) as number) & 0x0f
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    ((digest[offset + 1] as number) << 16) |
    ((digest[offset + 2] as number) << 8) |
    (digest[offset + 3] as number)

  return String(binary % 1_000_000).padStart(6, '0')
}
