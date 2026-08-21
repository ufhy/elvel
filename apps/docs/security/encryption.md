# Encryption

One AEAD, chosen rather than configurable: **AES-256-GCM**, through Bun's
synchronous `node:crypto`.

```ts
import { decrypt, encrypt, encryptString } from '@elvel/encryption'

encryptString('4111111111111111')      // 'v1.<nonce>.<ciphertext‖tag>'
encrypt({ card: '4111…' }, 'card:1')   // JSON, bound to a purpose
decrypt<Card>(payload, 'card:1')       // throws unless the purpose matches
```

## Three decisions, and why

**GCM only, no CBC.** GCM is AEAD: one operation encrypts *and* authenticates, so
there is no separate MAC to compute, order, or forget to compare in constant time.
Laravel keeps CBC for payloads written by older versions of itself; there is no
such history here to honour.

**A versioned, compact payload** — `v1.<iv>.<ciphertext‖tag>` in base64url —
rather than base64 of a JSON object. Shorter, which matters inside a 4 KB cookie;
URL-safe; and nothing about an untrusted payload is parsed as JSON before its tag
has been verified.

**Synchronous**, via `node:crypto` rather than WebCrypto. Not a style choice: the
model cast pipeline is synchronous, so an async-only encrypter could not back an
`encrypted` cast at all. Encryption is therefore never an `await` in the middle of
an accessor.

## Keys are derived, never used raw

`APP_KEY` goes through HKDF with a purpose string, so the cookie **signer** and the
**encrypter** share an origin and no key material. A blind index gets its own
derived key too.

```bash
bun elvel key:generate
```

It refuses to overwrite an existing key without `--force`, and prints the
`APP_PREVIOUS_KEYS=` line that keeps old payloads readable through the rotation.

`AUTH_SECRET` is a different key and must stay different — one encrypts data, the
other signs sessions, and one value doing both means a leak of either is a leak of
both.

## Context is authenticated, not carried

```ts
encrypt(value, 'card:1')
decrypt(payload, 'card:1')     // any other context throws
```

The second argument becomes the AEAD's **associated data**: it costs no bytes,
appears nowhere in the payload, and makes a value encrypted for one purpose fail to
decrypt as another. That is what stops a cookie value being pasted into a different
cookie, or a queue payload into a different job.

## Every failure reads the same

```
Could not decrypt the payload.
```

Whether the version, the length, the tag, the context or the key was wrong.
Distinguishing them is how an oracle attack starts — the attacker learns which
part of their guess was correct.

## Where it reaches

| Where | How |
| --- | --- |
| Cookies | `SESSION_ENCRYPT=true`, or `cookies().encrypt(name, value)` — bound to the cookie name |
| Queue payloads | `static encrypted = true` on a job; the queue stores a ciphertext it cannot read |
| Model columns | `casts = { editor_note: 'encrypted' }`, or `'encrypted:json'` |

## Searching an encrypted column

```ts
import { blindIndex } from '@elvel/encryption'

await User.query().where('email_index', blindIndex(email, 'users.email')).first()
```

Encryption is not searchable, and that is the point rather than a limitation:
`where('email', …)` against a ciphertext column can **never** match, because every
write produces different bytes. A blind index is the standard answer — store an
HMAC of the plaintext beside the ciphertext and search that.

The model keeps it in step for you:

```ts
class User extends Model {
  static override casts = { email: 'encrypted' }
  static override blindIndexes = { email: 'email_index' }
}
```

Recomputed only when the source attribute changed, since the fingerprint is
deterministic and rewriting it every save would dirty the row for nothing.

::: warning What a blind index costs, stated plainly
It is **deterministic**, so equal plaintexts give equal fingerprints. Anyone who
can read the column can tell which rows hold the same value — and for a small
domain like a status or a country, can *confirm a guess* by computing the
fingerprint of it. **Never index a low-entropy column.** It supports equality
only: no ordering, no prefix search, no `like`.

It is keyed with its own derived key, so a leaked index tells you nothing about the
ciphertext beside it, and bound to a context — usually the column — so the same
address in two tables does not fingerprint alike.
:::

## Rotating a key

```bash
bun elvel key:generate --force              # keeps the old one in APP_PREVIOUS_KEYS
bun elvel encryption:rotate users email
```

`APP_PREVIOUS_KEYS` lets old payloads keep decrypting, which is what makes a
rotation deployable at all — nothing has to be re-encrypted at the same moment the
key changes. `encryption:rotate` then walks a table and re-encrypts one column
onto the current key, so the old key can eventually be retired.

Without that command, rotating a key means every `encrypted` cast stops
decrypting the day you remove the old one.
