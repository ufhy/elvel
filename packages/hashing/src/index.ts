/**
 * Hashing — a password hash for anything that is not a login.
 *
 * better-auth hashes its own passwords, so authentication never needed this.
 * Everything else did: an API token stored as a hash, a signed invite, a
 * one-time code. `Bun.password` already speaks bcrypt and argon2id; what this
 * adds is a configured default, `needsRehash`, and a `check` that answers false
 * instead of throwing on a hash it cannot read.
 */
export {
  Argon2idHasher,
  type ArgonOptions,
  BcryptHasher,
  type BcryptOptions,
  type Hasher,
  type HashInfo,
  type HashOptions,
  isHashed,
  parseHash
} from './hasher.ts'
export { hash } from './helpers.ts'
export { type HasherFactory, HashManager } from './manager.ts'
export { HashServiceProvider } from './provider.ts'
