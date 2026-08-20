# Encryption

One AEAD, chosen rather than configurable: **AES-256-GCM**, through Bun's
synchronous `node:crypto`. Encryption is therefore not an `await` in the middle of
an accessor.

```ts
encryptString('4111111111111111')          // v1.<nonce>.<ciphertext‖tag>
encrypt({ card: '4111…' }, 'card:1')       // JSON, bound to a purpose
decrypt<Card>(payload, 'card:1')           // throws unless the purpose matches
```

Three things worth stating:

**Keys are derived, never used raw.** `APP_KEY` goes through HKDF with a purpose
string, so the cookie *signer* and the *encrypter* share an origin but no key
material. `elvel key:generate` writes one and refuses to overwrite an existing
key without `--force`, printing the `APP_PREVIOUS_KEYS=` line that keeps old
payloads readable through the rotation.

**Context is authenticated, not carried.** The second argument becomes the AEAD's
associated data: it costs no bytes, appears nowhere in the payload, and makes a
value encrypted for one purpose fail to decrypt as another. That is what stops a
cookie value being pasted into a different cookie, or a job payload into a
different job.

**Every failure reads the same** — "Could not decrypt the payload." — whether the
version, length, tag, context or key was wrong. Distinguishing them is how an
oracle attack starts.

It reaches three places:

| Where | How |
| --- | --- |
| Cookies | `SESSION_ENCRYPT=true`, or `cookies().encrypt(name, value)`, bound to the cookie name. |
| Queue payloads | `static encrypted = true` on a job. The queue stores a ciphertext it cannot read; the worker decrypts it, bound to the job class. |
| Model columns | `casts = { editor_note: 'encrypted' }` (or `'encrypted:json'`). Ciphertext at rest, the value on the model — and no `where` on the plaintext will ever match, which is the price. |
