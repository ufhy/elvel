/** What every hasher answers about a hash it is shown. */
export type HashInfo = {
  algorithm: 'bcrypt' | 'argon2id' | 'argon2i' | 'argon2d' | 'unknown'
  options: Record<string, number>
}

export type BcryptOptions = {
  /** Work factor. Each step doubles the time. */
  cost?: number
  /**
   * Longest input accepted, in bytes.
   *
   * 72 by default, and refused rather than truncated. Standard bcrypt ignores
   * everything past 72 bytes, so a 100-byte passphrase and its first 72 bytes
   * are the same password to most implementations — Bun's is not one of them,
   * which is worse rather than better: a hash made here from a long passphrase
   * would stop verifying the day it moved to a library that truncates. Refusing
   * keeps hashes portable and turns a silent security hole into an error.
   *
   * `0` disables the check, for a caller that has decided otherwise.
   */
  limit?: number
}

export type ArgonOptions = {
  /** Kibibytes of memory. The parameter that actually resists a GPU. */
  memoryCost?: number
  /** Passes over that memory. */
  timeCost?: number
}

export type HashOptions = BcryptOptions & ArgonOptions

export interface Hasher {
  make(value: string, options?: HashOptions): Promise<string>
  makeSync(value: string, options?: HashOptions): string
  check(value: string, hashed: string): Promise<boolean>
  needsRehash(hashed: string, options?: HashOptions): boolean
  info(hashed: string): HashInfo
}

/**
 * Read the algorithm and parameters back out of a hash string.
 *
 * Both formats are self-describing, which is what makes `needsRehash` possible
 * at all: the cost a hash was made with travels inside it.
 *
 * - `$2y$12$…` — bcrypt, cost 12
 * - `$argon2id$v=19$m=65536,t=4,p=1$…` — argon2id
 */
export function parseHash(hashed: string): HashInfo {
  const bcrypt = /^\$2[abxy]?\$(\d{2})\$/.exec(hashed)
  if (bcrypt) return { algorithm: 'bcrypt', options: { cost: Number(bcrypt[1]) } }

  const argon = /^\$(argon2(?:id|i|d))\$v=(\d+)\$([^$]*)\$/.exec(hashed)
  if (argon) {
    const options: Record<string, number> = { version: Number(argon[2]) }

    for (const pair of (argon[3] ?? '').split(',')) {
      const [key, value] = pair.split('=')
      if (key === 'm') options.memoryCost = Number(value)
      if (key === 't') options.timeCost = Number(value)
      if (key === 'p') options.threads = Number(value)
    }

    return { algorithm: argon[1] as HashInfo['algorithm'], options }
  }

  return { algorithm: 'unknown', options: {} }
}

/** Does this look like something one of our hashers produced? */
export function isHashed(value: unknown): boolean {
  return typeof value === 'string' && parseHash(value).algorithm !== 'unknown'
}

/**
 * Verify, treating a hash we cannot read as a mismatch.
 *
 * `Bun.password.verify` throws `UnsupportedAlgorithm` on a malformed hash. A
 * throw is wrong here: the caller asked whether a password matches, and a
 * corrupt or empty column is a "no", not an exception to handle at every call
 * site. Laravel's `check()` returns false for the same reason.
 */
async function verify(value: string, hashed: string): Promise<boolean> {
  if (hashed === '') return false

  try {
    return await Bun.password.verify(value, hashed)
  } catch {
    return false
  }
}

/** bcrypt, the conservative default. */
export class BcryptHasher implements Hasher {
  constructor(private readonly defaults: BcryptOptions = {}) {}

  private cost(options?: BcryptOptions): number {
    return options?.cost ?? this.defaults.cost ?? 12
  }

  private guard(value: string, options?: BcryptOptions): void {
    const limit = options?.limit ?? this.defaults.limit ?? 72
    if (limit === 0) return

    const bytes = new TextEncoder().encode(value).length
    if (bytes > limit) {
      throw new Error(
        `The value is ${bytes} bytes and bcrypt accepts ${limit}. ` +
          `Hash it with argon2id instead, or pass { limit: 0 } to accept the truncation risk.`
      )
    }
  }

  async make(value: string, options?: BcryptOptions): Promise<string> {
    this.guard(value, options)

    return Bun.password.hash(value, { algorithm: 'bcrypt', cost: this.cost(options) })
  }

  makeSync(value: string, options?: BcryptOptions): string {
    this.guard(value, options)

    return Bun.password.hashSync(value, { algorithm: 'bcrypt', cost: this.cost(options) })
  }

  check(value: string, hashed: string): Promise<boolean> {
    return verify(value, hashed)
  }

  /**
   * Was it made with weaker settings than we use now?
   *
   * Only weaker. A hash made with a *higher* cost than the current config does
   * not need replacing — rehashing it would make it worse, which is what a bare
   * inequality would do after someone lowers the cost to speed up a test suite.
   */
  needsRehash(hashed: string, options?: BcryptOptions): boolean {
    const info = parseHash(hashed)
    if (info.algorithm !== 'bcrypt') return true

    return (info.options.cost ?? 0) < this.cost(options)
  }

  info(hashed: string): HashInfo {
    return parseHash(hashed)
  }
}

/** argon2id — memory-hard, and what to reach for when the input is long. */
export class Argon2idHasher implements Hasher {
  constructor(private readonly defaults: ArgonOptions = {}) {}

  private settings(options?: ArgonOptions) {
    return {
      algorithm: 'argon2id' as const,
      memoryCost: options?.memoryCost ?? this.defaults.memoryCost ?? 65_536,
      timeCost: options?.timeCost ?? this.defaults.timeCost ?? 4
    }
  }

  make(value: string, options?: ArgonOptions): Promise<string> {
    return Bun.password.hash(value, this.settings(options))
  }

  makeSync(value: string, options?: ArgonOptions): string {
    return Bun.password.hashSync(value, this.settings(options))
  }

  check(value: string, hashed: string): Promise<boolean> {
    return verify(value, hashed)
  }

  needsRehash(hashed: string, options?: ArgonOptions): boolean {
    const info = parseHash(hashed)
    if (info.algorithm !== 'argon2id') return true

    const wanted = this.settings(options)

    return (
      (info.options.memoryCost ?? 0) < wanted.memoryCost ||
      (info.options.timeCost ?? 0) < wanted.timeCost
    )
  }

  info(hashed: string): HashInfo {
    return parseHash(hashed)
  }
}
