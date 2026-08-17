import { describe, expect, test } from 'bun:test'
import { DecryptError, EncryptError, Encrypter } from '../src/encrypter.ts'
import { EnvelopeEncrypter, LocalMasterKey } from '../src/envelope.ts'
import { deriveKey, generateKey, KEY_BYTES, secretBytes } from '../src/keys.ts'

const SECRET = 'playground-key-at-least-32-characters'

const encrypter = () => new Encrypter(SECRET)

describe('keys', () => {
  test('a generated key is 32 bytes of base64', () => {
    const key = generateKey()

    expect(key.startsWith('base64:')).toBe(true)
    expect(secretBytes(key).length).toBe(KEY_BYTES)
  })

  test('a plain secret is taken as its own bytes', () => {
    expect(secretBytes('abc')).toEqual(new TextEncoder().encode('abc'))
  })

  test('derivation is deterministic, and separated by purpose', () => {
    const first = deriveKey(SECRET, 'elyvel:encrypt:v1')
    const again = deriveKey(SECRET, 'elyvel:encrypt:v1')
    const other = deriveKey(SECRET, 'elyvel:something-else')

    expect(first.equals(again)).toBe(true)
    // The whole point: the cookie signer and the encrypter never share key
    // material, so one compromise does not hand over the other.
    expect(first.equals(other)).toBe(false)
    expect(first.length).toBe(KEY_BYTES)
  })

  test('a short secret is refused, with the command that fixes it', () => {
    expect(() => deriveKey('too-short', 'p')).toThrow(/too short.*key:generate/s)
  })

  test('a key that says base64 but decodes to nothing is refused', () => {
    expect(() => secretBytes('base64:')).toThrow(/decodes to nothing/)
  })
})

describe('round trips', () => {
  test('a string comes back unchanged', () => {
    const crypt = encrypter()
    const payload = crypt.encryptString('hello, world')

    expect(payload).not.toContain('hello')
    expect(crypt.decryptString(payload)).toBe('hello, world')
  })

  test('a structured value comes back as itself', () => {
    const crypt = encrypter()
    const value = { id: 7, tags: ['a', 'b'], nested: { ok: true }, nothing: null }

    expect(crypt.decrypt<typeof value>(crypt.encrypt(value))).toEqual(value)
  })

  test('non-ASCII survives', () => {
    const crypt = encrypter()

    expect(crypt.decryptString(crypt.encryptString('ringkasan 笔记 🎉'))).toBe('ringkasan 笔记 🎉')
  })

  test('the same value encrypts differently every time', () => {
    const crypt = encrypter()

    // A fresh nonce per message: identical plaintexts must not produce identical
    // ciphertexts, or an observer learns when a value repeats.
    expect(crypt.encryptString('same')).not.toBe(crypt.encryptString('same'))
  })

  test('the payload is versioned, compact and URL-safe', () => {
    const payload = encrypter().encryptString('value')
    const [version, iv, body] = payload.split('.')

    expect(version).toBe('v1')
    // 12 bytes of nonce, base64url, unpadded.
    expect(iv?.length).toBe(16)
    expect(payload).not.toMatch(/[+/=]/)
    expect(Buffer.from(String(body), 'base64url').length).toBeGreaterThan(16)
  })

  test('a value that cannot be serialised says so', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => encrypter().encrypt(circular)).toThrow(EncryptError)
  })
})

describe('authentication', () => {
  test('a tampered ciphertext is refused', () => {
    const crypt = encrypter()
    const payload = crypt.encryptString('transfer 100')

    const [version, iv, body] = payload.split('.')
    const bytes = Buffer.from(String(body), 'base64url')
    // Flip one bit of the ciphertext.
    bytes[0] = (bytes[0] as number) ^ 1

    expect(() => crypt.decryptString([version, iv, bytes.toString('base64url')].join('.'))).toThrow(
      DecryptError
    )
  })

  test('a tampered nonce is refused', () => {
    const crypt = encrypter()
    const [version, iv, body] = crypt.encryptString('value').split('.')

    const bytes = Buffer.from(String(iv), 'base64url')
    bytes[0] = (bytes[0] as number) ^ 1

    expect(() =>
      crypt.decryptString([version, bytes.toString('base64url'), body].join('.'))
    ).toThrow(DecryptError)
  })

  test('a truncated payload is refused', () => {
    const crypt = encrypter()
    const payload = crypt.encryptString('value')

    expect(() => crypt.decryptString(payload.slice(0, payload.length - 4))).toThrow(DecryptError)
  })

  test('nonsense is refused rather than parsed', () => {
    const crypt = encrypter()

    for (const rubbish of ['', 'not-a-payload', 'v1.short.short', 'v2.aaaa.bbbb', '{}']) {
      expect(() => crypt.decryptString(rubbish)).toThrow(DecryptError)
    }
  })

  test('another key cannot read it', () => {
    const payload = encrypter().encryptString('secret')
    const stranger = new Encrypter('a-completely-different-key-32-chars!')

    expect(() => stranger.decryptString(payload)).toThrow(DecryptError)
  })

  test('every failure gives the same message', () => {
    const crypt = encrypter()
    const payload = crypt.encryptString('value')

    const reasons = [
      () => crypt.decryptString('rubbish'),
      () => crypt.decryptString(payload.replace('v1', 'v2')),
      () => crypt.decryptString(payload, 'wrong-context'),
      () => new Encrypter('another-key-of-at-least-32-characters').decryptString(payload)
    ].map((attempt) => {
      try {
        attempt()

        return 'no error'
      } catch (error) {
        return (error as Error).message
      }
    })

    // Telling a caller *why* a ciphertext was rejected is how oracle attacks
    // start, so every rejection reads the same.
    expect(new Set(reasons).size).toBe(1)
  })
})

describe('context binding', () => {
  test('a payload cannot be decrypted as another context', () => {
    const crypt = encrypter()
    const payload = crypt.encryptString('a token', 'cookie:remember')

    expect(crypt.decryptString(payload, 'cookie:remember')).toBe('a token')
    // Lifting the value into a different cookie has to fail, not merely look odd.
    expect(() => crypt.decryptString(payload, 'cookie:session')).toThrow(DecryptError)
    expect(() => crypt.decryptString(payload)).toThrow(DecryptError)
  })

  test('a payload written without a context needs none', () => {
    const crypt = encrypter()
    const payload = crypt.encryptString('plain')

    expect(crypt.decryptString(payload)).toBe('plain')
    expect(() => crypt.decryptString(payload, 'any')).toThrow(DecryptError)
  })

  test('the context is not in the payload', () => {
    // It is authenticated, not carried: binding costs no bytes and leaks nothing.
    const payload = encrypter().encryptString('value', 'job:DeleteAccount')

    expect(
      Buffer.from(payload.split('.')[2] as string, 'base64url').toString('latin1')
    ).not.toContain('DeleteAccount')
  })
})

describe('key rotation', () => {
  test('a previous key can still read what it wrote', () => {
    const old = 'the-previous-application-key-32-ch!'
    const written = new Encrypter(old).encryptString('written before the rotation')

    const rotated = new Encrypter(SECRET, { previousKeys: [old] })

    expect(rotated.keyCount).toBe(2)
    expect(rotated.decryptString(written)).toBe('written before the rotation')
  })

  test('new payloads are written with the new key only', () => {
    const old = 'the-previous-application-key-32-ch!'
    const rotated = new Encrypter(SECRET, { previousKeys: [old] })

    const payload = rotated.encryptString('written after the rotation')

    // The old key must not be able to read what came after it.
    expect(() => new Encrypter(old).decryptString(payload)).toThrow(DecryptError)
    expect(new Encrypter(SECRET).decryptString(payload)).toBe('written after the rotation')
  })

  test('an unknown key is still refused', () => {
    const rotated = new Encrypter(SECRET, { previousKeys: ['another-old-key-of-32-characters!!'] })
    const stranger = new Encrypter('never-configured-key-of-32-chars!!!').encryptString('x')

    expect(() => rotated.decryptString(stranger)).toThrow(DecryptError)
  })

  test('usesCurrentKey separates what still needs rotating from what does not', () => {
    const old = 'the-previous-application-key-32-ch!'
    const rotated = new Encrypter(SECRET, { previousKeys: [old] })

    const before = new Encrypter(old).encryptString('written before the rotation')
    const after = rotated.encryptString('written after the rotation')

    // Both are readable — that is what previousKeys is for — but only one of
    // them is work for `encryption:rotate`.
    expect(rotated.decryptString(before)).toBe('written before the rotation')
    expect(rotated.usesCurrentKey(before)).toBe(false)
    expect(rotated.usesCurrentKey(after)).toBe(true)
  })

  test('usesCurrentKey respects the context, as decryption does', () => {
    const rotated = new Encrypter(SECRET)
    const payload = rotated.encryptString('value', 'users.ssn')

    expect(rotated.usesCurrentKey(payload, 'users.ssn')).toBe(true)
    // Right key, wrong column: the tag does not authenticate, so this is not a
    // row the rotation command may quietly skip.
    expect(rotated.usesCurrentKey(payload, 'users.other')).toBe(false)
    expect(rotated.usesCurrentKey(payload)).toBe(false)
  })

  test('usesCurrentKey is false for anything that is not a readable payload', () => {
    const rotated = new Encrypter(SECRET, { previousKeys: ['another-old-key-of-32-characters!!'] })

    // An unreadable row is not "already current" — it is the one thing the
    // operator has to be told about, so it must not be skipped.
    const stranger = new Encrypter('never-configured-key-of-32-chars!!!').encryptString('x')

    expect(rotated.usesCurrentKey(stranger)).toBe(false)
    expect(rotated.usesCurrentKey('plain text that was never encrypted')).toBe(false)
    expect(rotated.usesCurrentKey('')).toBe(false)
    expect(rotated.usesCurrentKey('v9.abc.def')).toBe(false)
  })
})

describe('appearsEncrypted', () => {
  test('it recognises our own payloads', () => {
    expect(Encrypter.appearsEncrypted(encrypter().encryptString('value'))).toBe(true)
  })

  test('and nothing else', () => {
    for (const other of ['plain text', 'a.b.c', '', null, 42, {}]) {
      expect(Encrypter.appearsEncrypted(other)).toBe(false)
    }
  })
})

describe('the encrypt/decrypt asymmetry', () => {
  test('a string written with encryptString is not JSON', () => {
    const crypt = encrypter()

    // Reading it with `decrypt` would try to parse it, and says so rather than
    // returning something surprising.
    expect(() => crypt.decrypt(crypt.encryptString('not json'))).toThrow(/does not contain JSON/)
  })

  test('a value written with encrypt reads back through decrypt', () => {
    const crypt = encrypter()

    expect(crypt.decrypt<string>(crypt.encrypt('a string'))).toBe('a string')
    expect(crypt.decryptString(crypt.encrypt('a string'))).toBe('"a string"')
  })

  test('undefined round-trips as null, because JSON has no undefined', () => {
    const crypt = encrypter()

    expect(crypt.decrypt(crypt.encrypt(undefined))).toBeNull()
  })
})

describe('a blind index', () => {
  const index = encrypter()

  test('the same value always fingerprints the same way', () => {
    // Determinism is the whole point — and the whole cost.
    expect<string>(index.blindIndex('ada@example.com', 'users.email')).toBe(
      index.blindIndex('ada@example.com', 'users.email')
    )
  })

  test('a different context is a different fingerprint', () => {
    // So the same address in two tables cannot be correlated across them.
    expect<boolean>(
      index.blindIndex('ada@example.com', 'users.email') ===
        index.blindIndex('ada@example.com', 'contacts.email')
    ).toBe(false)
  })

  test('it is keyed, so another application cannot reproduce it', () => {
    const other = new Encrypter('b'.repeat(40))

    expect<boolean>(
      index.blindIndex('ada@example.com') === other.blindIndex('ada@example.com')
    ).toBe(false)
  })

  test('it is not derived from the encryption key itself', () => {
    // Its own HKDF purpose: a leaked index must say nothing about the ciphertext
    // sitting beside it.
    const payload = index.encryptString('ada@example.com')

    expect<boolean>(payload.includes(index.blindIndex('ada@example.com'))).toBe(false)
  })

  test('the fingerprint carries no plaintext', () => {
    const fingerprint = index.blindIndex('ada@example.com', 'users.email')

    expect<boolean>(fingerprint.includes('ada')).toBe(false)
    // base64url, so it is safe in a URL and in every column type.
    expect<boolean>(/^[A-Za-z0-9_-]+$/.test(fingerprint)).toBe(true)
  })
})

describe('envelope encryption', () => {
  const master = () => new LocalMasterKey(Buffer.alloc(32, 7))
  const envelope = () => new EnvelopeEncrypter(master())

  test('a value round trips through a wrapped data key', async () => {
    const payload = await envelope().encrypt({ card: '4111' }, 'orders.card')

    expect<boolean>(payload.startsWith('e1.')).toBe(true)
    expect<unknown>(await envelope().decrypt(payload, 'orders.card')).toEqual({ card: '4111' })
  })

  test('every payload gets its own data key', async () => {
    const one = await envelope().encryptString('same', 'x')
    const two = await envelope().encryptString('same', 'x')

    // The wrapped key differs, not just the IV: a leaked data key opens one
    // payload rather than the table.
    expect<boolean>(one.split('.')[1] === two.split('.')[1]).toBe(false)
  })

  test('the context is authenticated', async () => {
    const payload = await envelope().encryptString('secret', 'orders.card')

    await expect(envelope().decryptString(payload, 'users.card')).rejects.toThrow()
  })

  test('another master key cannot unwrap it', async () => {
    const payload = await envelope().encryptString('secret', 'x')
    const stranger = new EnvelopeEncrypter(new LocalMasterKey(Buffer.alloc(32, 9)))

    await expect(stranger.decryptString(payload, 'x')).rejects.toThrow()
  })

  test('rewrapping leaves the ciphertext alone', async () => {
    const payload = await envelope().encryptString('secret', 'x')
    const rewrapped = await envelope().rewrap(payload, 'x')

    // The rotation an envelope makes cheap: ten million rows become ten million
    // small updates rather than as many decrypt-and-re-encrypt round trips.
    expect<boolean>(rewrapped.split('.')[3] === payload.split('.')[3]).toBe(true)
    expect<boolean>(rewrapped.split('.')[1] === payload.split('.')[1]).toBe(false)
    expect<string>(await envelope().decryptString(rewrapped, 'x')).toBe('secret')
  })

  test('a payload in the wrong format says so', async () => {
    await expect(envelope().decryptString('v1.abc.def', 'x')).rejects.toThrow('envelope format')
  })
})
