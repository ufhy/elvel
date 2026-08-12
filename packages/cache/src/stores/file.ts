import { mkdir, open, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decode, encode, expiresAt, FOREVER } from '../payload.ts'
import { Lock, type LockProvider, type Store } from '../store.ts'

/**
 * A file-backed store — `Illuminate\Cache\FileStore`.
 *
 * The layout is Laravel's: `sha1(key)` split into two two-character directories
 * so no single directory collects a million files, and the payload is a
 * ten-digit expiry timestamp followed by the value. Reading only the first ten
 * bytes is enough to know whether an entry is still alive.
 */
export class FileStore implements Store, LockProvider {
  constructor(
    private readonly directory: string,
    readonly prefix = ''
  ) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const payload = await this.payload(key)

    return (payload?.value as T) ?? null
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | null>> {
    const result: Record<string, T | null> = {}

    for (const key of keys) result[key] = await this.get<T>(key)

    return result
  }

  async put(key: string, value: unknown, seconds: number): Promise<boolean> {
    await Bun.write(this.path(key), this.stamp(seconds) + encode(value))

    return true
  }

  async putMany(values: Record<string, unknown>, seconds: number): Promise<boolean> {
    for (const [key, value] of Object.entries(values)) await this.put(key, value, seconds)

    return true
  }

  /**
   * Create the file only if it does not exist, using the filesystem as the lock.
   *
   * `wx` fails when the path is already there, which is the one atomic primitive
   * a filesystem reliably gives us. An expired entry has to be replaced, so that
   * case falls through to a plain write.
   */
  async add(key: string, value: unknown, seconds: number): Promise<boolean> {
    const path = this.path(key)
    const contents = this.stamp(seconds) + encode(value)

    // `Bun.write` creates missing parents; `open` does not, and the sharded
    // directories will not exist until something has been written to them.
    await mkdir(dirname(path), { recursive: true })

    try {
      const handle = await open(path, 'wx')

      try {
        await handle.writeFile(contents)
      } finally {
        await handle.close()
      }

      return true
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }

    // The file exists: only a dead entry may be taken over.
    if ((await this.payload(key)) !== null) return false

    return this.put(key, value, seconds)
  }

  async increment(key: string, value = 1): Promise<number | false> {
    const payload = await this.payload(key)

    if (!payload) {
      await this.put(key, value, 0)
      return value
    }

    if (typeof payload.value !== 'number') return false

    const next = payload.value + value
    // Keep the original expiry: a counter's window must not slide on every hit.
    await Bun.write(this.path(key), String(payload.expires).padStart(10, '0') + encode(next))

    return next
  }

  async decrement(key: string, value = 1): Promise<number | false> {
    return this.increment(key, -value)
  }

  async forever(key: string, value: unknown): Promise<boolean> {
    return this.put(key, value, 0)
  }

  async forget(key: string): Promise<boolean> {
    try {
      await unlink(this.path(key))
      return true
    } catch {
      return false
    }
  }

  async flush(): Promise<boolean> {
    await rm(this.directory, { recursive: true, force: true })

    return true
  }

  lock(name: string, seconds = 0, owner?: string): Lock {
    return new FileLock(join(this.directory, 'locks'), this.prefix + name, seconds, owner)
  }

  restoreLock(name: string, owner: string): Lock {
    return this.lock(name, 0, owner)
  }

  /** The path an entry lives at. Public because tests and tooling want it. */
  path(key: string): string {
    const hash = new Bun.CryptoHasher('sha1').update(this.prefix + key).digest('hex')

    return join(this.directory, hash.slice(0, 2), hash.slice(2, 4), hash)
  }

  /** The stored entry, or null when it is missing, expired or unreadable. */
  private async payload(key: string): Promise<{ value: unknown; expires: number } | null> {
    const file = Bun.file(this.path(key))

    let contents: string
    try {
      contents = await file.text()
    } catch {
      return null
    }

    const expires = Number(contents.slice(0, 10))
    if (!Number.isFinite(expires)) return null

    if (expires !== FOREVER && expires <= Math.floor(Date.now() / 1000)) {
      // Reading is also when expired files get cleaned up, as Laravel does it.
      await this.forget(key)
      return null
    }

    return { value: decode(contents.slice(10)), expires }
  }

  private stamp(seconds: number): string {
    return String(expiresAt(seconds)).padStart(10, '0')
  }
}

class FileLock extends Lock {
  constructor(
    private readonly directory: string,
    name: string,
    seconds: number,
    owner?: string
  ) {
    super(name, seconds, owner)
  }

  async acquire(): Promise<boolean> {
    const existing = await this.read()

    // A lock whose holder died is reclaimed; an unexpired one is not.
    if (existing && existing.expires > Date.now()) return false
    if (existing) await this.forget()

    await mkdir(this.directory, { recursive: true })

    try {
      const handle = await open(this.path(), 'wx')

      try {
        await handle.writeFile(JSON.stringify({ owner: this.owner(), expires: this.expiry() }))
      } finally {
        await handle.close()
      }

      return true
    } catch (error) {
      // Another process created the file between our read and our write.
      if ((error as { code?: string }).code === 'EEXIST') return false

      throw error
    }
  }

  async release(): Promise<boolean> {
    if (!(await this.isOwnedByCurrentProcess())) return false

    return this.forget()
  }

  override async refresh(seconds?: number): Promise<boolean> {
    if (!(await this.isOwnedByCurrentProcess())) return false

    await Bun.write(
      this.path(),
      JSON.stringify({ owner: this.owner(), expires: this.expiry(seconds) })
    )

    return true
  }

  protected async currentOwner(): Promise<string | null> {
    const existing = await this.read()

    if (!existing || existing.expires <= Date.now()) return null

    return existing.owner
  }

  private async read(): Promise<{ owner: string; expires: number } | null> {
    try {
      return (await Bun.file(this.path()).json()) as { owner: string; expires: number }
    } catch {
      return null
    }
  }

  private async forget(): Promise<boolean> {
    try {
      await unlink(this.path())
      return true
    } catch {
      return false
    }
  }

  private expiry(seconds = this.seconds): number {
    return seconds === 0 ? Number.MAX_SAFE_INTEGER : Date.now() + seconds * 1000
  }

  private path(): string {
    const hash = new Bun.CryptoHasher('sha1').update(this.name).digest('hex')

    return join(this.directory, `${hash}.lock`)
  }
}
