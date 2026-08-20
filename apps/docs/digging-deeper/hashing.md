# Hashing

For everything you choose to store as a hash — an API token, an invite code, a
one-time secret.

::: tip Sign-in passwords do not read this
Those are better-auth's business, and it hashes them itself. This package is for
the hashes your own code makes.
:::

```ts
import { hash } from '@elvel/hashing'

const digest = await hash().make('secret')
// '$argon2id$v=19$m=19456,t=2,p=1$…'

await hash().check('secret', digest)   // true
await hash().check('nope', digest)     // false
```

## Two drivers

```ts
// config/hashing.ts
driver: process.env.HASH_DRIVER ?? 'bcrypt',

bcrypt: { cost: 12, limit: 72 },
argon:  { memory: 65536, time: 4 }
```

```ts
await hash().driver('bcrypt').make('secret')   // '$2b$10$…' at cost 10
```

`bcrypt` is the default and each step of `cost` doubles the time — 12 is roughly
250ms on current hardware. `argon2id` is the other, and `memory` is the parameter
that resists a GPU rather than a CPU.

`limit: 72` is not arbitrary. **bcrypt ignores everything past 72 bytes** in most
implementations, so a longer value is refused rather than silently truncated —
otherwise a 100-character passphrase and its first 72 characters are the same
secret and nobody is told. Set it to `0` to allow it, or use `argon2id`, which has
no such ceiling.

## Rehashing when the cost changes

```ts
hash().needsRehash(digest)   // false, until the configured cost moves
```

```ts
hash().info(digest)
// { algorithm: 'argon2id', options: { version: 19, memoryCost: 19456, timeCost: 2, threads: 1 } }
```

`info()` reads the parameters out of the digest itself, which is what makes
`needsRehash` answerable: the stored hash says what it cost, so raising the cost
in configuration lets the next successful check re-hash the value at the new one.
