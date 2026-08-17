import type { ApplicationContract } from '@elyvel/contracts'
import {
  Argon2idHasher,
  BcryptHasher,
  type Hasher,
  type HashInfo,
  type HashOptions,
  isHashed,
  parseHash
} from './hasher.ts'

export type HasherFactory = () => Hasher

/**
 * Resolves hashers and forwards to the default one — Laravel's `HashManager`.
 *
 * The default is bcrypt, matching Laravel and better-auth's own choice, so a
 * password column written by one is readable by the other. `argon2id` is a
 * driver away and is the better answer for anything long, since bcrypt's 72-byte
 * ceiling does not apply to it.
 */
export class HashManager implements Hasher {
  private readonly drivers = new Map<string, Hasher>()
  private readonly custom = new Map<string, HasherFactory>()

  constructor(private readonly app?: ApplicationContract) {}

  private config<T>(key: string, fallback: T): T {
    return this.app?.config.get<T>(`hashing.${key}`, fallback) ?? fallback
  }

  /** The configured default, or a named one. */
  driver(name?: string): Hasher {
    const resolved = name ?? this.config<string>('driver', 'bcrypt')

    const cached = this.drivers.get(resolved)
    if (cached) return cached

    const built = this.build(resolved)
    this.drivers.set(resolved, built)

    return built
  }

  extend(name: string, factory: HasherFactory): this {
    this.custom.set(name, factory)
    this.drivers.delete(name)

    return this
  }

  private build(name: string): Hasher {
    const custom = this.custom.get(name)
    if (custom) return custom()

    switch (name) {
      case 'bcrypt':
        return new BcryptHasher({
          cost: this.config<number>('bcrypt.cost', 12),
          limit: this.config<number>('bcrypt.limit', 72)
        })

      case 'argon2id':
      case 'argon':
        return new Argon2idHasher({
          memoryCost: this.config<number>('argon.memory', 65_536),
          timeCost: this.config<number>('argon.time', 4)
        })

      default:
        throw new Error(`Hash driver [${name}] is not supported. Register it with hash().extend().`)
    }
  }

  make(value: string, options?: HashOptions): Promise<string> {
    return this.driver().make(value, options)
  }

  /**
   * The blocking form.
   *
   * Hashing is deliberately slow, so this stops the event loop for as long as
   * the work takes — tens of milliseconds at a real cost. It exists for a
   * seeder, a migration or a command, where there is nothing else to serve.
   * Never reach for it inside a request.
   */
  makeSync(value: string, options?: HashOptions): string {
    return this.driver().makeSync(value, options)
  }

  check(value: string, hashed: string): Promise<boolean> {
    return this.driver().check(value, hashed)
  }

  needsRehash(hashed: string, options?: HashOptions): boolean {
    return this.driver().needsRehash(hashed, options)
  }

  info(hashed: string): HashInfo {
    return parseHash(hashed)
  }

  isHashed(value: unknown): boolean {
    return isHashed(value)
  }
}
